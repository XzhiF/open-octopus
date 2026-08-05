import type { EngineCallbacks } from "./engine"
import type { WorkflowDef } from "@octopus/shared"
import type { JsonlLogger } from "./logger"
import os from "os"
import path from "path"
import fs from "fs"

// ── Dependency interfaces (injected for testability) ──

export interface ResourceManifestLike {
  agents: string[]
  skills: string[]
  commands: string[]
  rules: string[]
  // Note: clones NOT included — checked by separate hard-fail gate
}

export interface ResourceCheckResultLike {
  missing: Array<{ name: string; type: string }>
}

export interface ResourcePreFlightLike {
  analyze(workflow: WorkflowDef): ResourceManifestLike
  check(manifest: ResourceManifestLike, workspaceDir: string): ResourceCheckResultLike
}

export interface ResourceProvisionResultLike {
  provisioned: number
  failed: string[]
  byType: Record<string, number>
}

export interface ResourceProvisionerLike {
  provision(
    missing: Array<{ name: string; type: string }>,
    workspaceDir: string,
  ): Promise<ResourceProvisionResultLike>
}

export interface GitOpsLike {
  allProjectsAction<T>(
    workspacePath: string,
    action: (projectPath: string, projectName: string) => Promise<T>,
  ): Promise<Record<string, T>>
  pullLatest(projectPath: string): Promise<string>
}

// ── Options & result ──

export interface EngineInitOptions {
  workspacePath: string
  workflow: WorkflowDef
  callbacks: EngineCallbacks
  syncMainBranch?: boolean
  gitOps?: GitOpsLike
  resourceProvisioner?: ResourceProvisionerLike
  resourcePreflight?: ResourcePreFlightLike
  logger?: JsonlLogger
}

export interface GitSyncResult {
  project: string
  success: boolean
  error?: string
}

export interface EngineInitResult {
  status: "completed" | "failed"
  durationMs: number
  skillsCopied: number
  agentsCopied: number
  commandsCopied: number
  rulesCopied: number
  cloneErrors: string[]
  gitSyncResults: GitSyncResult[]
}

// ── Constants ──

const INIT_NODE_ID = "__engine_init__"
const INIT_NODE_TYPE = "bash"

// ── Implementation ──

interface ProvisionContext {
  skillsCopied: number
  agentsCopied: number
  commandsCopied: number
  rulesCopied: number
  cloneErrors: string[]
  failed: boolean
}

/**
 * Extract agent name from a file path reference.
 * "agents/code-reviewer.md" → "code-reviewer"
 */
function agentFileToName(filePath: string): string | undefined {
  if (typeof filePath !== "string" || filePath.includes("$")) return undefined
  const basename = filePath.split("/").pop() ?? filePath
  return basename.replace(/\.md$/, "")
}

export class EngineInitPhase {
  /**
   * Helper to log a message to both the callback and the JSONL logger.
   */
  private logMessage(logger: JsonlLogger | undefined, callbacks: EngineCallbacks, message: string): void {
    callbacks.onNodeLog?.(INIT_NODE_ID, message)
    logger?.log(INIT_NODE_ID, "node_log", { line: message })
  }

  /**
   * Build a consistent EngineInitResult from the current ProvisionContext.
   */
  private buildResult(
    ctx: ProvisionContext,
    status: "completed" | "failed",
    durationMs: number,
    syncResults: GitSyncResult[] = [],
  ): EngineInitResult {
    return {
      status, durationMs,
      skillsCopied: ctx.skillsCopied, agentsCopied: ctx.agentsCopied,
      commandsCopied: ctx.commandsCopied, rulesCopied: ctx.rulesCopied,
      cloneErrors: ctx.cloneErrors, gitSyncResults: syncResults,
    }
  }

  /**
   * Provision missing resources and update counters.
   * Returns updated context with incremented counts and failure flag.
   */
  private async provisionMissing(
    missing: Array<{ name: string; type: string }>,
    workspacePath: string,
    provisioner: ResourceProvisionerLike,
    callbacks: EngineCallbacks,
    source: string,
    current: ProvisionContext,
    logger?: JsonlLogger,
  ): Promise<ProvisionContext> {
    this.logMessage(logger, callbacks, `Provisioning ${missing.length} missing resource(s) from ${source}: ${missing.map(m => `${m.type}:${m.name}`).join(", ")}`)

    const result = await provisioner.provision(missing, workspacePath)

    // Use exact per-type counts from provisioner result (replaces fragile ratio estimation)
    const updated: ProvisionContext = {
      skillsCopied: current.skillsCopied + (result.byType.skill ?? 0),
      agentsCopied: current.agentsCopied + (result.byType.agent ?? 0),
      commandsCopied: current.commandsCopied + (result.byType.command ?? 0),
      rulesCopied: current.rulesCopied + (result.byType.rule ?? 0),
      cloneErrors: current.cloneErrors,
      failed: result.failed.length > 0,
    }

    if (updated.failed) {
      this.logMessage(logger, callbacks, `[ERROR] Failed to provision resources: ${result.failed.join(", ")}`)
    } else {
      this.logMessage(logger, callbacks, `Provisioned ${result.provisioned} resource(s) from ${source} successfully`)
    }

    return updated
  }

  async run(options: EngineInitOptions): Promise<EngineInitResult> {
    const {
      workspacePath,
      workflow,
      callbacks,
      syncMainBranch = true,
      gitOps,
      resourceProvisioner,
      resourcePreflight,
      logger,
    } = options

    const startTime = Date.now()
    const ctx: ProvisionContext = {
      skillsCopied: 0, agentsCopied: 0, commandsCopied: 0, rulesCopied: 0,
      cloneErrors: [], failed: false,
    }

    // Write start event to JSONL log
    logger?.log(INIT_NODE_ID, "start", { type: INIT_NODE_TYPE })

    callbacks.onNodeStart?.(INIT_NODE_ID, INIT_NODE_TYPE)

    try {
      // Step 0: Clone hard-fail gate — check BEFORE provisioning
      const requiresClones = workflow.requires?.clones ?? []
      if (requiresClones.length > 0) {
        const homeDir = os.homedir()
        const missingClones: string[] = []

        for (const cloneName of requiresClones) {
          const clonePath = path.join(homeDir, '.octopus', 'agent', 'clones', cloneName)
          const builtInPath = path.join(homeDir, '.octopus', 'agent', 'built-in', cloneName)

          if (!fs.existsSync(clonePath) && !fs.existsSync(builtInPath)) {
            missingClones.push(cloneName)
          }
        }

        if (missingClones.length > 0) {
          for (const cloneName of missingClones) {
            const errorMsg = `Clone '${cloneName}' is not installed. Install it with: octopus resource install builtin:${cloneName} --type clone`
            this.logMessage(logger, callbacks, `[ERROR] ${errorMsg}`)
            ctx.cloneErrors.push(errorMsg)
          }
          ctx.failed = true

          const durationMs = Date.now() - startTime
          logger?.log(INIT_NODE_ID, "end", { status: "failed", durationMs })
          callbacks.onNodeEnd?.(INIT_NODE_ID, "failed", durationMs)
          return this.buildResult(ctx, "failed", durationMs)
        }
      }

      // Step 1: Provision declared requires resources first
      const requiresSkills = workflow.requires?.skills ?? []
      const requiresAgentFiles = workflow.requires?.agent_files ?? []
      const requiresCommands = workflow.requires?.commands ?? []
      const requiresRules = workflow.requires?.rules ?? []
      const hasRequires = requiresSkills.length > 0 || requiresAgentFiles.length > 0
        || requiresCommands.length > 0 || requiresRules.length > 0

      if (hasRequires && !resourcePreflight) {
        this.logMessage(logger, callbacks, `[WARN] requires declared but resource preflight not configured — skipping provision`)
      }

      if (hasRequires && resourcePreflight && resourceProvisioner) {
        const requiresAgentNames = requiresAgentFiles
          .map(agentFileToName)
          .filter((n): n is string => n !== undefined)
        const requiresManifest: ResourceManifestLike = {
          agents: requiresAgentNames,
          skills: requiresSkills,
          commands: requiresCommands,
          rules: requiresRules,
        }

        this.logMessage(logger, callbacks, `Provisioning from requires: ${requiresManifest.skills.length} skills, ${requiresManifest.agents.length} agents`)

        const requiresCheck = resourcePreflight.check(requiresManifest, workspacePath)

        if (requiresCheck.missing.length > 0) {
          const result = await this.provisionMissing(
            requiresCheck.missing, workspacePath, resourceProvisioner,
            callbacks, "requires", ctx, logger,
          )
          ctx.skillsCopied = result.skillsCopied
          ctx.agentsCopied = result.agentsCopied
          ctx.commandsCopied = result.commandsCopied
          ctx.rulesCopied = result.rulesCopied
          ctx.failed = result.failed
        } else {
          this.logMessage(logger, callbacks, "All requires resources already present")
        }
      }

      // Step 2: Scan for additional resources (fallback)
      if (resourcePreflight && resourceProvisioner) {
        const scanResult = await this.runScanPhase(
          workflow, workspacePath, resourcePreflight, resourceProvisioner,
          callbacks, hasRequires, ctx, logger,
        )
        ctx.skillsCopied = scanResult.skillsCopied
        ctx.agentsCopied = scanResult.agentsCopied
        // Note: commandsCopied/rulesCopied unchanged — scan only produces skills+agents
        if (scanResult.failed) ctx.failed = true
      } else if (!resourcePreflight || !resourceProvisioner) {
        this.logMessage(logger, callbacks, "Resource preflight not configured, skipping")
      }

      // Early return on provision failure
      if (ctx.failed) {
        const durationMs = Date.now() - startTime
        logger?.log(INIT_NODE_ID, "end", { status: "failed", durationMs })
        callbacks.onNodeEnd?.(INIT_NODE_ID, "failed", durationMs)
        return this.buildResult(ctx, "failed", durationMs)
      }

      // Step 3: Optional git sync
      const syncResults = await this.runGitSyncPhase(syncMainBranch, gitOps, workspacePath, callbacks, logger)

      const durationMs = Date.now() - startTime
      logger?.log(INIT_NODE_ID, "end", { status: "completed", durationMs })
      callbacks.onNodeEnd?.(INIT_NODE_ID, "completed", durationMs)

      return this.buildResult(ctx, "completed", durationMs, syncResults)
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.logMessage(logger, callbacks, `[ERROR] Engine init failed with unexpected error: ${errorMsg}`)
      const durationMs = Date.now() - startTime
      logger?.log(INIT_NODE_ID, "end", { status: "failed", durationMs, error: errorMsg })
      callbacks.onNodeEnd?.(INIT_NODE_ID, "failed", durationMs)
      return this.buildResult(ctx, "failed", durationMs)
    }
  }

  /** Scan fallback: analyze workflow nodes for additional resources not in requires. */
  private async runScanPhase(
    workflow: WorkflowDef,
    workspacePath: string,
    preflight: ResourcePreFlightLike,
    provisioner: ResourceProvisionerLike,
    callbacks: EngineCallbacks,
    hasRequires: boolean,
    ctx: ProvisionContext,
    logger?: JsonlLogger,
  ): Promise<ProvisionContext> {
    if (hasRequires) {
      this.logMessage(logger, callbacks, "Scanning for additional resources...")
    }

    const manifest = preflight.analyze(workflow)
    this.logMessage(logger, callbacks, `Analyzing resources: ${manifest.skills.length} skills, ${manifest.agents.length} agents`)

    const totalResources = manifest.skills.length + manifest.agents.length
    if (totalResources === 0) {
      this.logMessage(logger, callbacks, "No skills/agents references found in workflow")
      return ctx
    }

    const check = preflight.check(manifest, workspacePath)
    if (check.missing.length === 0) {
      this.logMessage(logger, callbacks, "All required resources already present")
      return ctx
    }

    return this.provisionMissing(
      check.missing, workspacePath, provisioner, callbacks, "scan", ctx, logger,
    )
  }

  /** Git sync: pull latest main for all workspace projects. */
  private async runGitSyncPhase(
    syncMainBranch: boolean,
    gitOps: GitOpsLike | undefined,
    workspacePath: string,
    callbacks: EngineCallbacks,
    logger?: JsonlLogger,
  ): Promise<GitSyncResult[]> {
    if (!syncMainBranch) {
      this.logMessage(logger, callbacks, "Git sync skipped (disabled)")
      return []
    }
    if (!gitOps) {
      this.logMessage(logger, callbacks, "Git sync requested but gitOps not configured")
      return []
    }

    this.logMessage(logger, callbacks, "Syncing main branch for workspace projects")

    const results = await gitOps.allProjectsAction(
      workspacePath,
      async (projectPath: string, projectName: string) => {
        try {
          const sha = await gitOps.pullLatest(projectPath)
          this.logMessage(logger, callbacks, `✓ ${projectName} synced to ${sha.slice(0, 8)}`)
          return { project: projectName, success: true } as GitSyncResult
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : String(err)
          this.logMessage(logger, callbacks, `⚠ ${projectName} sync failed: ${errorMsg}`)
          return { project: projectName, success: false, error: errorMsg } as GitSyncResult
        }
      },
    )

    const gitSyncResults = Object.values(results)
    const syncFailures = gitSyncResults.filter((r) => !r.success)
    if (syncFailures.length > 0) {
      this.logMessage(logger, callbacks, `${syncFailures.length} project(s) failed to sync (continuing anyway)`)
    }

    return gitSyncResults
  }
}
