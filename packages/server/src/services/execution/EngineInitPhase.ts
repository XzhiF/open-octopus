// packages/server/src/services/execution/EngineInitPhase.ts
// Pre-phase that runs before formal workflow nodes: copies skills/agents to workspace
// and (optionally) syncs git projects to main branch. Emits SSE events and persists
// to __engine_init__.jsonl so events survive page refresh.
import { appendFileSync, mkdirSync, existsSync, copyFileSync, readdirSync, statSync } from "fs"
import { join } from "path"
import type { SSEService } from "../sse"
import { gitOps } from "../git-ops"

export const ENGINE_INIT_JSONL = "__engine_init__.jsonl"

export interface EngineInitOptions {
  workspacePath: string
  workspaceId: string
  executionId: string
  syncMainBranch: boolean
  sse: SSEService
  /** Override for core-pack skills root (used in tests) */
  skillsSourceOverride?: string | null
}

export interface EngineInitEvent {
  event: string
  timestamp: string
  [key: string]: unknown
}

export class EngineInitPhase {
  /**
   * Run the full engine_init pre-phase. Failures in any step emit a warning
   * but never throw — the workflow engine must still run.
   */
  async run(opts: EngineInitOptions): Promise<void> {
    const logDir = join(opts.workspacePath, "logs", opts.executionId)
    mkdirSync(logDir, { recursive: true })
    const jsonlPath = join(logDir, ENGINE_INIT_JSONL)

    const emit = (event: EngineInitEvent) => {
      const line = JSON.stringify(event) + "\n"
      try { appendFileSync(jsonlPath, line) } catch (e) {
        process.stderr.write(`[engine_init] JSONL append failed: ${e instanceof Error ? e.message : String(e)}\n`)
      }
      try { opts.sse.emit(opts.workspaceId, { event: event.event, data: event }) } catch (e) {
        process.stderr.write(`[engine_init] SSE emit failed: ${e instanceof Error ? e.message : String(e)}\n`)
      }
    }

    emit({
      event: "engine_init_start",
      timestamp: new Date().toISOString(),
      executionId: opts.executionId,
      syncMainBranch: opts.syncMainBranch,
    })

    // Skills/agents copy
    try {
      await this.copySkillsAndAgents(opts, emit)
    } catch (err: unknown) {
      emit({
        event: "engine_init_warning",
        timestamp: new Date().toISOString(),
        projectName: "",
        errorMessage: `skills/agents copy failed: ${err instanceof Error ? err.message : String(err)}`,
      })
    }

    // Git sync (T-2)
    if (opts.syncMainBranch) {
      await this.syncAllProjects(opts, emit)
    }

    emit({
      event: "engine_init_complete",
      timestamp: new Date().toISOString(),
      executionId: opts.executionId,
    })
  }

  private async syncAllProjects(
    opts: EngineInitOptions,
    emit: (e: EngineInitEvent) => void,
  ): Promise<void> {
    const projectsDir = join(opts.workspacePath, "projects")
    if (!existsSync(projectsDir)) return

    const entries = readdirSync(projectsDir).filter((entry) => {
      const projectPath = join(projectsDir, entry)
      return statSync(projectPath).isDirectory() && existsSync(join(projectPath, ".git"))
    })

    const OVERALL_TIMEOUT_MS = 30_000
    const startTime = Date.now()

    for (const projectName of entries) {
      if (Date.now() - startTime > OVERALL_TIMEOUT_MS) {
        emit({
          event: "engine_init_warning",
          timestamp: new Date().toISOString(),
          projectName,
          errorMessage: "overall sync timeout (30s) exceeded, remaining projects skipped",
        })
        break
      }

      const projectPath = join(projectsDir, projectName)
      try {
        const result = await gitOps.syncProjectToMain(projectPath, projectName)
        if (result.status === "success") {
          emit({
            event: "engine_init_pull",
            timestamp: new Date().toISOString(),
            projectName,
            branch: result.branch,
            status: "success",
          })
        } else if (result.status === "info") {
          emit({
            event: "engine_init_info",
            timestamp: new Date().toISOString(),
            projectName,
            branch: result.branch,
            message: result.reason ?? "",
          })
        } else if (result.status === "skipped") {
          emit({
            event: "engine_init_warning",
            timestamp: new Date().toISOString(),
            projectName,
            errorMessage: result.reason ?? "skipped",
          })
        } else {
          emit({
            event: "engine_init_warning",
            timestamp: new Date().toISOString(),
            projectName,
            errorMessage: result.reason ?? "sync failed",
          })
        }
      } catch (err: unknown) {
        emit({
          event: "engine_init_warning",
          timestamp: new Date().toISOString(),
          projectName,
          errorMessage: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  private async copySkillsAndAgents(
    opts: EngineInitOptions,
    emit: (e: EngineInitEvent) => void,
  ): Promise<void> {
    // Skills
    const skillsRoot = opts.skillsSourceOverride ?? this.findCorePackRoot("skills")
    if (skillsRoot && existsSync(skillsRoot)) {
      const destDir = join(opts.workspacePath, ".claude", "skills")
      mkdirSync(destDir, { recursive: true })
      const count = this.copyTree(skillsRoot, destDir)
      emit({
        event: "engine_init_skills",
        timestamp: new Date().toISOString(),
        status: "success",
        fileCount: count,
      })
    } else {
      emit({
        event: "engine_init_skills",
        timestamp: new Date().toISOString(),
        status: "skipped",
        fileCount: 0,
      })
    }

    // Agents
    const agentsRoot = this.findCorePackRoot("agents")
    if (agentsRoot && existsSync(agentsRoot)) {
      const destDir = join(opts.workspacePath, ".claude", "agents")
      mkdirSync(destDir, { recursive: true })
      const coreAgents = ["devil-advocate.md", "architecture-explorer.md", "vision-analyzer.md", "testing-qa-engineer.md"]
      let copied = 0
      for (const agentFile of coreAgents) {
        const src = join(agentsRoot, agentFile)
        if (!existsSync(src)) continue
        const dest = join(destDir, agentFile)
        if (existsSync(dest)) continue
        copyFileSync(src, dest)
        copied++
      }
      emit({
        event: "engine_init_agents",
        timestamp: new Date().toISOString(),
        status: copied > 0 ? "success" : "skipped",
        fileCount: copied,
      })
    } else {
      emit({
        event: "engine_init_agents",
        timestamp: new Date().toISOString(),
        status: "skipped",
        fileCount: 0,
      })
    }
  }

  private findCorePackRoot(kind: "skills" | "agents"): string | null {
    const candidates = [
      join(process.cwd(), "..", "core-pack", kind),
      join(process.cwd(), "packages", "core-pack", kind),
      join(process.cwd(), "node_modules", "@octopus", "core-pack", kind),
    ]
    for (const c of candidates) {
      if (existsSync(c)) return c
    }
    return null
  }

  private copyTree(src: string, dest: string): number {
    let count = 0
    mkdirSync(dest, { recursive: true })
    const entries = readdirSync(src)
    for (const entry of entries) {
      const srcPath = join(src, entry)
      const destPath = join(dest, entry)
      const s = statSync(srcPath)
      if (s.isDirectory()) {
        count += this.copyTree(srcPath, destPath)
      } else {
        copyFileSync(srcPath, destPath)
        count++
      }
    }
    return count
  }
}

export const engineInitPhase = new EngineInitPhase()
