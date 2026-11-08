// packages/server/src/services/tasks/workflow-dev-service.ts
//
// workflow-dev task kind (2026-11-06) — the file/verification/publish side of
// 「工作流开发」tasks.
//
// Source of truth: `{taskHome}/workflows/<ref>.yaml`. Every save is mirrored to
// the task's workspace `workflows/` so the existing engine resolver can run it
// from the chat (`run_workflow`), exactly like an ordinary workspace workflow.
//
// Verification state lives in `task_spec.workflow_dev` and is bound to the
// file's sha256: editing the YAML invalidates the previous validation /
// simulation. `run_workflow` consults `canRun()` before starting a real run.
//
// Task-level completion (`completeTask`) writes `workflow_dev.complete` and
// flips the persisted status to `ready`; deriveTaskView maps that kind to
// `awaiting_archive`, so the existing archive-consent / start_archive /
// ArchiveService chain takes over unchanged.

import crypto from "crypto"
import fs from "fs"
import os from "os"
import path from "path"
import type Database from "better-sqlite3"
import { parseWorkflow, validateWorkflow, workflowDevStateSchema, WorkflowRef, type WorkflowDevState } from "@octopus/shared"
import {
  discoverTestFixture,
  loadTestFixture,
  loadWorkflow,
  runTestSuite,
} from "@octopus/engine"
import { TaskDAO } from "../../db/dao"
import type { TaskRow } from "../../db/types"
import { getAgentDir } from "../agent/paths"
import { TaskHomeService } from "./task-home-service"
import { WorkspaceService } from "../workspace"
import { WorkspaceGit } from "../workspace-git"

export type WorkflowDevKind = "workflow-dev"

export class WorkflowDevError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "WorkflowDevError"
  }
}

export interface WorkflowDevDeps {
  db: Database.Database
  taskDAO?: TaskDAO
  taskHomeService?: TaskHomeService
  workspaceService?: WorkspaceService
  /** SSE bridge (taskpool/task_status). Optional in tests. */
  emitTaskStatus?: (taskId: string, status: string) => void
}

export interface WorkflowDevFileInfo {
  ref: string
  name: string
  description?: string
  stage: "release" | "snapshot"
  version?: string
}

export interface WorkflowDevSnapshot {
  taskId: string
  kind: WorkflowDevKind
  ref: string | null
  content: string
  /** Parsed summary; null when the current file does not parse. */
  parsed: {
    name: string
    description?: string
    stage: "release" | "snapshot"
    version?: string
    executionMode?: string
    nodeCount: number
    inputs: string[]
  } | null
  files: WorkflowDevFileInfo[]
  state: WorkflowDevState
  workspacePath: string | null
}

export interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
  parsed?: { mode?: string; expertCount?: number; hasAggregator?: boolean }
}

export interface SimulationResult {
  passed: boolean
  passedCount: number
  failedCount: number
  scenarios: Array<{ name: string; passed: boolean; error?: string }>
  message?: string
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex")
}

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p
}

function parseSpec(row: TaskRow): Record<string, unknown> {
  try {
    return JSON.parse(row.task_spec || "{}") as Record<string, unknown>
  } catch {
    return {}
  }
}

function ensureWorkflowDev(spec: Record<string, unknown>): WorkflowDevState {
  return workflowDevStateSchema.parse((spec.workflow_dev ?? {}) as Record<string, unknown>)
}

export class WorkflowDevService {
  private readonly taskDAO: TaskDAO
  private readonly taskHomeService: TaskHomeService
  private readonly workspaceService: WorkspaceService
  private readonly emitTaskStatus?: (taskId: string, status: string) => void

  constructor(deps: WorkflowDevDeps) {
    this.taskDAO = deps.taskDAO ?? new TaskDAO(deps.db)
    this.taskHomeService = deps.taskHomeService ?? new TaskHomeService()
    this.workspaceService = deps.workspaceService ?? new WorkspaceService()
    this.emitTaskStatus = deps.emitTaskStatus
  }

  // ── task / path plumbing ────────────────────────────────────────────

  private task(taskId: string): TaskRow {
    const row = this.taskDAO.getById(taskId)
    if (!row) throw new WorkflowDevError(404, `task ${taskId} not found`)
    const spec = parseSpec(row)
    if (spec.kind !== "workflow-dev") {
      throw new WorkflowDevError(400, `task ${taskId} is not a workflow-dev task`)
    }
    return row
  }

  private workspacePath(row: TaskRow): string | null {
    if (!row.workspace_id) return null
    const ws = this.workspaceService.getById(row.workspace_id)
    return ws ? expandHome(ws.path) : null
  }

  private workflowsDir(taskId: string): string {
    return this.taskHomeService.workflowsDir(taskId)
  }

  /** Authored workflow files only — `*.test.yaml` fixtures are not workflows. */
  private authoredRefs(taskId: string): string[] {
    return this.taskHomeService
      .listWorkflowFiles(taskId)
      .filter((f) => !/\.test\.ya?ml$/i.test(f))
  }

  private refPath(taskId: string, ref: string): string {
    return path.join(this.workflowsDir(taskId), ref)
  }

  /** Resolve a ref against the task-home workflows dir, trying `.yaml`/`.yml`
   *  when the caller omits the extension. Returns the actual filename + body. */
  private resolveAuthored(taskId: string, ref: string): { ref: string; content: string } | null {
    // Fixtures are inputs to the simulator, never runnable workflows.
    if (/\.test\.ya?ml$/i.test(ref)) return null
    const direct = this.taskHomeService.readWorkflowFile(taskId, ref)
    if (direct !== null) return { ref, content: direct }
    if (!/\.ya?ml$/i.test(ref)) {
      for (const ext of [".yaml", ".yml"]) {
        const candidate = `${ref}${ext}`
        const content = this.taskHomeService.readWorkflowFile(taskId, candidate)
        if (content !== null) return { ref: candidate, content }
      }
    }
    return null
  }

  /** Update task_spec (and optionally other columns) with optimistic retry. */
  private updateSpec(taskId: string, mutate: (spec: Record<string, unknown>) => void, extra: Record<string, unknown> = {}): void {
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = this.taskDAO.getById(taskId)
      if (!row) throw new WorkflowDevError(404, `task ${taskId} not found`)
      const spec = parseSpec(row)
      mutate(spec)
      spec.workflow_dev = ensureWorkflowDev(spec)
      const result = this.taskDAO.updateWithVersion(
        taskId,
        { task_spec: JSON.stringify(spec), ...extra },
        row.version,
      )
      if ((result.changes ?? 0) > 0) {
        // Keep the task-home manifest snapshot in step (the agent reads it).
        this.taskHomeService.writeManifestFile(taskId, {
          version: 1,
          spec,
          updated_at: new Date().toISOString(),
          ...(spec.format === "v4" ? { format: "v4" } : {}),
        })
        return
      }
    }
    throw new WorkflowDevError(409, "task spec changed concurrently — retry")
  }

  private mirrorToWorkspace(row: TaskRow, ref: string, content: string): void {
    const wsPath = this.workspacePath(row)
    if (!wsPath) return
    const dir = path.join(wsPath, "workflows")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, ref), content, "utf-8")
  }

  // ── read ────────────────────────────────────────────────────────────

  /** Resolve the current ref: active_ref, else the single YAML in task home. */
  private currentRef(taskId: string, state: WorkflowDevState): string | null {
    if (state.active_ref) return state.active_ref
    const files = this.authoredRefs(taskId)
    return files.length === 1 ? files[0] : null
  }

  listFiles(taskId: string): WorkflowDevFileInfo[] {
    const out: WorkflowDevFileInfo[] = []
    for (const ref of this.authoredRefs(taskId)) {
      try {
        const parsed = parseWorkflow(fs.readFileSync(this.refPath(taskId, ref), "utf-8"))
        out.push({
          ref,
          name: parsed.name,
          description: parsed.description,
          stage: parsed.stage ?? "snapshot",
          version: parsed.version,
        })
      } catch {
        out.push({ ref, name: ref.replace(/\.ya?ml$/, ""), stage: "snapshot" })
      }
    }
    return out.sort((a, b) => a.ref.localeCompare(b.ref))
  }

  getState(taskId: string): WorkflowDevSnapshot {
    const task = this.task(taskId)
    const spec = parseSpec(task)
    const state = ensureWorkflowDev(spec)
    const ref = this.currentRef(taskId, state)
    const content = ref && fs.existsSync(this.refPath(taskId, ref))
      ? fs.readFileSync(this.refPath(taskId, ref), "utf-8")
      : ""
    let parsed: WorkflowDevSnapshot["parsed"] = null
    if (content) {
      try {
        const wf = parseWorkflow(content)
        parsed = {
          name: wf.name,
          description: wf.description,
          stage: wf.stage ?? "snapshot",
          version: wf.version,
          executionMode: wf.execution_mode,
          nodeCount: wf.nodes.length,
          inputs: Object.keys(wf.inputs ?? {}),
        }
      } catch {
        parsed = null
      }
    }
    return {
      taskId,
      kind: "workflow-dev",
      ref,
      content,
      parsed,
      files: this.listFiles(taskId),
      state,
      workspacePath: this.workspacePath(task),
    }
  }

  read(taskId: string): { ref: string | null; content: string } {
    const snap = this.getState(taskId)
    return { ref: snap.ref, content: snap.content }
  }

  /** Read an authored file by ref (task home only; null when absent). */
  readFile(taskId: string, ref: string): string | null {
    this.task(taskId)
    return this.resolveAuthored(taskId, ref)?.content ?? null
  }

  /** Copy the current task-home YAML into the task workspace workflows/ so the
   *  engine resolver finds it when `run_workflow` starts an execution. */
  syncToWorkspace(taskId: string, ref: string): void {
    const task = this.task(taskId)
    const found = this.resolveAuthored(taskId, ref)
    if (!found) return
    this.mirrorToWorkspace(task, found.ref, found.content)
  }

  // ── write ───────────────────────────────────────────────────────────

  /** Save the current workflow YAML. Returns the snapshot after writing.
   *
   *  A ref is resolved from (in order): the current active_ref, else the YAML
   *  `name:` for a new file. YAML that does not parse is still saved when an
   *  active ref exists (the editor may be mid-edit); a first save must parse so
   *  we can name the file. */
  save(taskId: string, content: string, originalContent?: string): WorkflowDevSnapshot {
    const task = this.task(taskId)
    const spec = parseSpec(task)
    const state = ensureWorkflowDev(spec)
    let ref = state.active_ref ?? null
    if (!ref) {
      let parsedName: string | null = null
      try {
        parsedName = parseWorkflow(content).name
      } catch (err: unknown) {
        throw new WorkflowDevError(
          400,
          `首次保存的 YAML 必须能解析（需要顶层 name）: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      ref = `${WorkflowRef.sanitize(parsedName)}.yaml`
    }

    const filePath = this.refPath(taskId, ref)
    if (originalContent !== undefined && fs.existsSync(filePath)) {
      const current = fs.readFileSync(filePath, "utf-8")
      if (current !== originalContent) {
        throw new WorkflowDevError(409, "文件已被外部修改，请重新打开后再保存")
      }
    }

    fs.mkdirSync(this.workflowsDir(taskId), { recursive: true })
    fs.writeFileSync(filePath, content, "utf-8")
    this.mirrorToWorkspace(task, ref, content)

    const hash = sha256(content)
    this.updateSpec(taskId, (s) => {
      s.kind = "workflow-dev"
      const dev = ensureWorkflowDev(s)
      if (!dev.active_ref) dev.active_ref = ref!
      // Editing the file invalidates the previous verification results.
      if (dev.validation && dev.validation.hash !== hash) delete dev.validation
      if (dev.simulation && dev.simulation.hash !== hash) delete dev.simulation
      if (dev.waiver && dev.waiver.hash !== hash) delete dev.waiver
      s.workflow_dev = dev
    })
    return this.getState(taskId)
  }

  /** Register / switch the workflow under development. One at a time. */
  setActiveRef(taskId: string, ref: string): WorkflowDevSnapshot {
    const found = this.resolveAuthored(taskId, ref)
    if (!found) {
      throw new WorkflowDevError(404, `workflow file ${ref} not found in task home`)
    }
    const resolvedRef = found.ref
    const task = this.task(taskId)
    const spec = parseSpec(task)
    const state = ensureWorkflowDev(spec)
    if (state.active_ref && state.active_ref !== resolvedRef && !state.completed_refs.includes(state.active_ref)) {
      throw new WorkflowDevError(
        409,
        `workflow "${state.active_ref}" is still in development — finish it before starting "${resolvedRef}"`,
      )
    }
    this.updateSpec(taskId, (s) => {
      const dev = ensureWorkflowDev(s)
      dev.active_ref = resolvedRef
      s.workflow_dev = dev
    })
    return this.getState(taskId)
  }

  // ── verification ────────────────────────────────────────────────────

  validate(taskId: string, yaml?: string, ref?: string): ValidationResult {
    this.task(taskId)
    const spec = parseSpec(this.taskDAO.getById(taskId)!)
    const state = ensureWorkflowDev(spec)
    const targetRef = ref ?? state.active_ref ?? this.currentRef(taskId, state)
    const content =
      yaml ?? (targetRef ? fs.readFileSync(this.refPath(taskId, targetRef), "utf-8") : "")
    if (!content) throw new WorkflowDevError(400, "no workflow YAML to validate")

    let result: ValidationResult
    try {
      const wf = parseWorkflow(content)
      const { warnings } = validateWorkflow(wf)
      const swarm = wf.nodes.find((n) => n.type === "swarm")
      result = {
        valid: true,
        errors: [],
        warnings,
        parsed: {
          mode: wf.execution_mode,
          expertCount: swarm?.swarm?.experts?.length,
          hasAggregator: Boolean(swarm?.swarm?.aggregator),
        },
      }
    } catch (err: unknown) {
      result = {
        valid: false,
        errors: [err instanceof Error ? err.message : String(err)],
        warnings: [],
      }
    }

    if (targetRef && yaml === undefined) {
      const hash = sha256(content)
      this.updateSpec(taskId, (s) => {
        const dev = ensureWorkflowDev(s)
        dev.validation = {
          ref: targetRef,
          hash,
          valid: result.valid,
          at: new Date().toISOString(),
          errors: result.errors,
        }
        if (!result.valid) delete dev.simulation
        s.workflow_dev = dev
      })
    }
    return result
  }

  async simulate(
    taskId: string,
    opts: { scenario?: string; strict?: boolean; realExecution?: string[] } = {},
  ): Promise<SimulationResult> {
    const task = this.task(taskId)
    const spec = parseSpec(task)
    const state = ensureWorkflowDev(spec)
    const ref = state.active_ref ?? this.currentRef(taskId, state)
    if (!ref) throw new WorkflowDevError(400, "no active workflow to simulate")
    const workflowPath = this.refPath(taskId, ref)
    const content = fs.readFileSync(workflowPath, "utf-8")
    const fixturePath = discoverTestFixture(workflowPath)
    if (!fixturePath) {
      throw new WorkflowDevError(
        400,
        `缺少仿真 fixture：请先写 ${ref.replace(/\.ya?ml$/, "")}.test.yaml（与工作流同目录）再仿真`,
      )
    }

    const workflow = loadWorkflow(workflowPath)
    const fixture = loadTestFixture(fixturePath)
    const suite = await runTestSuite(workflow, fixture, {
      scenarioFilter: opts.scenario,
      strict: opts.strict ?? true,
      realExecution: opts.realExecution,
    })
    const scenarios = suite.results.map((r) => {
      const failed = r.assertionReport.results
        .filter((a) => !a.passed)
        .map((a) => a.message ?? a.name)
      const detail = r.error ?? (failed.length > 0 ? failed.join("; ") : undefined)
      return {
        name: r.scenarioName,
        passed: r.passed,
        ...(detail ? { error: detail } : {}),
      }
    })
    const message = suite.passed
      ? `仿真通过（${suite.passedCount}/${suite.results.length}）`
      : `仿真失败（${suite.failedCount} 个场景未通过）`

    const hash = sha256(content)
    this.updateSpec(taskId, (s) => {
      const dev = ensureWorkflowDev(s)
      dev.simulation = {
        ref,
        hash,
        passed: suite.passed,
        at: new Date().toISOString(),
        scenarios: scenarios.map((x) => x.name),
        message,
      }
      if (!suite.passed) delete dev.waiver
      s.workflow_dev = dev
    })

    return {
      passed: suite.passed,
      passedCount: suite.passedCount,
      failedCount: suite.failedCount,
      scenarios,
      message,
    }
  }

  /** Real-run gate for `run_workflow`. Applies only to refs authored in this
   *  task's home (built-in / external workspace workflows pass through). */
  canRun(taskId: string, ref: string, waiverReason?: string): { ok: true } | { ok: false; reason: string } {
    const task = this.task(taskId)
    const state = ensureWorkflowDev(parseSpec(task))
    const found = this.resolveAuthored(taskId, ref)
    if (!found) return { ok: true } // not an authored file — leave to ExecutionService

    const hash = sha256(found.content)
    const valid = state.validation?.valid === true && state.validation.hash === hash
    const simulated = state.simulation?.passed === true && state.simulation.hash === hash
    if (valid && simulated) return { ok: true }

    if (waiverReason && waiverReason.trim()) {
      this.updateSpec(taskId, (s) => {
        const dev = ensureWorkflowDev(s)
        dev.waiver = { ref: found.ref, hash, reason: waiverReason.trim(), at: new Date().toISOString() }
        s.workflow_dev = dev
      })
      return { ok: true }
    }

    const missing: string[] = []
    if (!valid) missing.push("基础校验未通过（或 YAML 已改动）")
    if (!simulated) missing.push("仿真未通过（或 YAML 已改动）")
    return {
      ok: false,
      reason: `运行前必须通过 ${missing.join(" + ")}。请先 validate_workflow / simulate_workflow；如用户明确要求豁免，传 waiver 并说明原因。`,
    }
  }

  // ── completion / release ────────────────────────────────────────────

  markWorkflowComplete(taskId: string, ref: string, stage: "release" | "snapshot"): WorkflowDevSnapshot {
    const task = this.task(taskId)
    const state = ensureWorkflowDev(parseSpec(task))
    const found = this.resolveAuthored(taskId, ref)
    if (!found) throw new WorkflowDevError(404, `workflow file ${ref} not found`)
    const targetRef = found.ref
    const hash = sha256(found.content)
    const valid = state.validation?.valid === true && state.validation.hash === hash
    const simulated = state.simulation?.passed === true && state.simulation.hash === hash
    const waived = state.waiver?.hash === hash
    if ((!valid || !simulated) && !waived) {
      throw new WorkflowDevError(409, "工作流尚未通过基础校验 + 仿真，不能标记完成")
    }
    if (stage === "release") this.release(taskId, targetRef)

    this.updateSpec(taskId, (s) => {
      const dev = ensureWorkflowDev(s)
      if (!dev.completed_refs.includes(targetRef)) dev.completed_refs.push(targetRef)
      dev.stage = stage
      if (dev.active_ref === targetRef) delete dev.active_ref
      s.workflow_dev = dev
    })
    return this.getState(taskId)
  }

  /** Copy a released workflow into the main-agent workspace so default chats
   *  (cwd = ~/.octopus/agent) can list and run it. */
  release(taskId: string, ref: string): { targetPath: string } {
    const found = this.resolveAuthored(taskId, ref)
    if (!found) throw new WorkflowDevError(404, `workflow file ${ref} not found`)
    const wf = parseWorkflow(found.content)
    if ((wf.stage ?? "snapshot") !== "release") {
      throw new WorkflowDevError(400, `release 需要 YAML 顶层 stage: release（当前 ${wf.stage ?? "snapshot"}）`)
    }
    if (wf.version === undefined || !String(wf.version).trim()) {
      throw new WorkflowDevError(400, "release 需要 YAML 顶层 version（例如 version: 1.0.0）")
    }
    const dir = path.join(getAgentDir(), "workflows")
    fs.mkdirSync(dir, { recursive: true })
    const targetPath = path.join(dir, found.ref)
    fs.writeFileSync(targetPath, found.content, "utf-8")
    return { targetPath }
  }

  /** Task-level completion: flip the persisted row to ready and emit the
   *  awaiting_archive status so the existing consent card / wake fires. */
  completeTask(taskId: string): WorkflowDevSnapshot {
    const task = this.task(taskId)
    if (["archiving", "done", "aborted"].includes(task.status)) {
      throw new WorkflowDevError(409, `task is already ${task.status}`)
    }
    const state = ensureWorkflowDev(parseSpec(task))
    if (state.active_ref) {
      throw new WorkflowDevError(409, `workflow "${state.active_ref}" is still in development — finish it first`)
    }
    if (state.completed_refs.length === 0) {
      throw new WorkflowDevError(409, "至少完成一个工作流后才能结束开发")
    }
    this.updateSpec(
      taskId,
      (s) => {
        const dev = ensureWorkflowDev(s)
        dev.complete = true
        s.workflow_dev = dev
      },
      task.status === "draft" ? { status: "ready" } : {},
    )
    this.emitTaskStatus?.(taskId, "awaiting_archive")
    return this.getState(taskId)
  }

  // ── projects ────────────────────────────────────────────────────────

  /** Add project names to the task and materialise their worktrees in the
   *  task workspace (the "bring a repo in to debug the workflow" path). */
  addProjects(taskId: string, projectNames: string[]): { added: string[]; failed: Array<{ name: string; error: string }> } {
    const task = this.task(taskId)
    const names = [...new Set(projectNames.map((n) => n.trim()).filter(Boolean))]
    if (names.length === 0) return { added: [], failed: [] }

    const current = (() => {
      try {
        return JSON.parse(task.project_ids || "[]") as string[]
      } catch {
        return [] as string[]
      }
    })()
    const merged = [...new Set([...current, ...names])]
    const result = this.taskDAO.updateWithVersion(
      taskId,
      { project_ids: JSON.stringify(merged) },
      task.version,
    )
    if ((result.changes ?? 0) === 0) throw new WorkflowDevError(409, "task changed concurrently — retry")

    const ws = task.workspace_id ? this.workspaceService.getById(task.workspace_id) : undefined
    if (!ws) return { added: names, failed: [] }

    const git = new WorkspaceGit()
    const refs: Array<{ name: string; source_path: string; group?: string }> = []
    const failed: Array<{ name: string; error: string }> = []
    for (const name of names) {
      try {
        const sourcePath = git.resolveRepoPath(task.repo_group ?? "", name)
        refs.push({ name, source_path: sourcePath, ...(task.repo_group ? { group: task.repo_group } : {}) })
      } catch (err: unknown) {
        failed.push({ name, error: err instanceof Error ? err.message : String(err) })
      }
    }
    let created: string[] = []
    if (refs.length > 0) {
      const out = this.workspaceService.ensureWorktreesForProjects(
        ws,
        refs,
        "workflow-dev",
        taskId.slice(0, 8),
      )
      created = out.created
    }
    return { added: created.length > 0 ? created : refs.map((r) => r.name), failed }
  }
}

// ── process-wide singleton (routes + chat tools) ─────────────────────

let singleton: WorkflowDevService | null = null

export function initWorkflowDevService(deps: WorkflowDevDeps): WorkflowDevService {
  singleton = new WorkflowDevService(deps)
  return singleton
}

export function getWorkflowDevService(): WorkflowDevService | null {
  return singleton
}
