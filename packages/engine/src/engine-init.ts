import type { EngineCallbacks } from "./engine"
import type { WorkflowDef } from "@octopus/shared"

// ── Dependency interfaces (injected for testability) ──

export interface ResourceManifestLike {
  agents: string[]
  skills: string[]
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
  gitSyncResults: GitSyncResult[]
}

// ── Constants ──

const INIT_NODE_ID = "__engine_init__"
const INIT_NODE_TYPE = "bash"

// ── Implementation ──

interface ProvisionContext {
  skillsCopied: number
  agentsCopied: number
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
  ): Promise<ProvisionContext> {
    callbacks.onNodeLog?.(
      INIT_NODE_ID,
      `Provisioning ${missing.length} missing resource(s) from ${source}: ${missing.map(m => `${m.type}:${m.name}`).join(", ")}`,
    )

    const result = await provisioner.provision(missing, workspacePath)

    // Count by type from result.provisioned ratio (not from missing, which may partially fail)
    const missingSkills = missing.filter(m => m.type === "skill").length
    const missingAgents = missing.filter(m => m.type === "agent").length
    const totalMissing = missingSkills + missingAgents
    const provisionedRatio = totalMissing > 0 ? result.provisioned / totalMissing : 1
    const skillsProvisioned = Math.round(missingSkills * provisionedRatio)
    const agentsProvisioned = Math.round(missingAgents * provisionedRatio)

    const updated: ProvisionContext = {
      skillsCopied: current.skillsCopied + skillsProvisioned,
      agentsCopied: current.agentsCopied + agentsProvisioned,
      failed: result.failed.length > 0,
    }

    if (updated.failed) {
      callbacks.onNodeLog?.(
        INIT_NODE_ID,
        `[ERROR] Failed to provision resources: ${result.failed.join(", ")}`,
      )
    } else {
      callbacks.onNodeLog?.(
        INIT_NODE_ID,
        `Provisioned ${result.provisioned} resource(s) from ${source} successfully`,
      )
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
    } = options

    const startTime = Date.now()
    const ctx: ProvisionContext = { skillsCopied: 0, agentsCopied: 0, failed: false }

    callbacks.onNodeStart?.(INIT_NODE_ID, INIT_NODE_TYPE)

    try {
      // Step 1: Provision declared requires resources first
      const requiresSkills = workflow.requires?.skills ?? []
      const requiresAgentFiles = workflow.requires?.agent_files ?? []
      const hasRequires = requiresSkills.length > 0 || requiresAgentFiles.length > 0

      if (hasRequires && !resourcePreflight) {
        callbacks.onNodeLog?.(
          INIT_NODE_ID,
          `[WARN] requires declared but resource preflight not configured — skipping provision`,
        )
      }

      if (hasRequires && resourcePreflight && resourceProvisioner) {
        const requiresAgentNames = requiresAgentFiles
          .map(agentFileToName)
          .filter((n): n is string => n !== undefined)
        const requiresManifest: ResourceManifestLike = {
          agents: requiresAgentNames,
          skills: requiresSkills,
        }

        callbacks.onNodeLog?.(
          INIT_NODE_ID,
          `Provisioning from requires: ${requiresManifest.skills.length} skills, ${requiresManifest.agents.length} agents`,
        )

        const requiresCheck = resourcePreflight.check(requiresManifest, workspacePath)

        if (requiresCheck.missing.length > 0) {
          const result = await this.provisionMissing(
            requiresCheck.missing, workspacePath, resourceProvisioner,
            callbacks, "requires", ctx,
          )
          ctx.skillsCopied = result.skillsCopied
          ctx.agentsCopied = result.agentsCopied
          ctx.failed = result.failed
        } else {
          callbacks.onNodeLog?.(INIT_NODE_ID, "All requires resources already present")
        }
      }

      // Step 2: Scan for additional resources (fallback)
      if (resourcePreflight && resourceProvisioner) {
        const scanResult = await this.runScanPhase(
          workflow, workspacePath, resourcePreflight, resourceProvisioner,
          callbacks, hasRequires, ctx,
        )
        ctx.skillsCopied = scanResult.skillsCopied
        ctx.agentsCopied = scanResult.agentsCopied
        if (scanResult.failed) ctx.failed = true
      } else if (!resourcePreflight || !resourceProvisioner) {
        callbacks.onNodeLog?.(INIT_NODE_ID, "Resource preflight not configured, skipping")
      }

      // Early return on provision failure
      if (ctx.failed) {
        const durationMs = Date.now() - startTime
        callbacks.onNodeEnd?.(INIT_NODE_ID, "failed", durationMs)
        return { status: "failed", durationMs, skillsCopied: ctx.skillsCopied, agentsCopied: ctx.agentsCopied, gitSyncResults: [] }
      }

      // Step 3: Optional git sync
      const syncResults = await this.runGitSyncPhase(syncMainBranch, gitOps, workspacePath, callbacks)

      const durationMs = Date.now() - startTime
      callbacks.onNodeEnd?.(INIT_NODE_ID, "completed", durationMs)

      return { status: "completed", durationMs, skillsCopied: ctx.skillsCopied, agentsCopied: ctx.agentsCopied, gitSyncResults: syncResults }
    } catch {
      const durationMs = Date.now() - startTime
      callbacks.onNodeEnd?.(INIT_NODE_ID, "failed", durationMs)
      return { status: "failed", durationMs, skillsCopied: ctx.skillsCopied, agentsCopied: ctx.agentsCopied, gitSyncResults: [] }
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
  ): Promise<ProvisionContext> {
    if (hasRequires) {
      callbacks.onNodeLog?.(INIT_NODE_ID, "Scanning for additional resources...")
    }

    const manifest = preflight.analyze(workflow)
    callbacks.onNodeLog?.(
      INIT_NODE_ID,
      `Analyzing resources: ${manifest.skills.length} skills, ${manifest.agents.length} agents`,
    )

    const totalResources = manifest.skills.length + manifest.agents.length
    if (totalResources === 0) {
      callbacks.onNodeLog?.(INIT_NODE_ID, "No skills/agents references found in workflow")
      return ctx
    }

    const check = preflight.check(manifest, workspacePath)
    if (check.missing.length === 0) {
      callbacks.onNodeLog?.(INIT_NODE_ID, "All required resources already present")
      return ctx
    }

    return this.provisionMissing(
      check.missing, workspacePath, provisioner, callbacks, "scan", ctx,
    )
  }

  /** Git sync: pull latest main for all workspace projects. */
  private async runGitSyncPhase(
    syncMainBranch: boolean,
    gitOps: GitOpsLike | undefined,
    workspacePath: string,
    callbacks: EngineCallbacks,
  ): Promise<GitSyncResult[]> {
    if (!syncMainBranch) {
      callbacks.onNodeLog?.(INIT_NODE_ID, "Git sync skipped (disabled)")
      return []
    }
    if (!gitOps) {
      callbacks.onNodeLog?.(INIT_NODE_ID, "Git sync requested but gitOps not configured")
      return []
    }

    callbacks.onNodeLog?.(INIT_NODE_ID, "Syncing main branch for workspace projects")

    const results = await gitOps.allProjectsAction(
      workspacePath,
      async (projectPath: string, projectName: string) => {
        try {
          const sha = await gitOps.pullLatest(projectPath)
          callbacks.onNodeLog?.(INIT_NODE_ID, `✓ ${projectName} synced to ${sha.slice(0, 8)}`)
          return { project: projectName, success: true } as GitSyncResult
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : String(err)
          callbacks.onNodeLog?.(INIT_NODE_ID, `⚠ ${projectName} sync failed: ${errorMsg}`)
          return { project: projectName, success: false, error: errorMsg } as GitSyncResult
        }
      },
    )

    const gitSyncResults = Object.values(results)
    const syncFailures = gitSyncResults.filter((r) => !r.success)
    if (syncFailures.length > 0) {
      callbacks.onNodeLog?.(
        INIT_NODE_ID,
        `${syncFailures.length} project(s) failed to sync (continuing anyway)`,
      )
    }

    return gitSyncResults
  }
}
