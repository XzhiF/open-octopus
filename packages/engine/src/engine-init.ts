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

export class EngineInitPhase {
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
    let skillsCopied = 0
    let agentsCopied = 0
    const gitSyncResults: GitSyncResult[] = []
    let nodeEndEmitted = false

    callbacks.onNodeStart?.(INIT_NODE_ID, INIT_NODE_TYPE)

    try {
      // Step 1: Analyze and provision skills/agents
      if (resourcePreflight && resourceProvisioner) {
        const manifest = resourcePreflight.analyze(workflow)
        const totalResources = manifest.skills.length + manifest.agents.length
        callbacks.onNodeLog?.(
          INIT_NODE_ID,
          `Analyzing resources: ${manifest.skills.length} skills, ${manifest.agents.length} agents`,
        )

        if (totalResources > 0) {
          const check = resourcePreflight.check(manifest, workspacePath)

          if (check.missing.length > 0) {
            callbacks.onNodeLog?.(
              INIT_NODE_ID,
              `Provisioning ${check.missing.length} missing resource(s): ${check.missing.map((m) => `${m.type}:${m.name}`).join(", ")}`,
            )

            const result = await resourceProvisioner.provision(check.missing, workspacePath)
            skillsCopied = result.provisioned
            agentsCopied = result.provisioned

            if (result.failed.length > 0) {
              const errorMsg = `Failed to provision resources: ${result.failed.join(", ")}`
              callbacks.onNodeLog?.(INIT_NODE_ID, `[ERROR] ${errorMsg}`)
              const durationMs = Date.now() - startTime
              callbacks.onNodeEnd?.(INIT_NODE_ID, "failed", durationMs)
              nodeEndEmitted = true
              return {
                status: "failed",
                durationMs,
                skillsCopied,
                agentsCopied,
                gitSyncResults,
              }
            }

            callbacks.onNodeLog?.(
              INIT_NODE_ID,
              `Provisioned ${result.provisioned} resource(s) successfully`,
            )
          } else {
            callbacks.onNodeLog?.(INIT_NODE_ID, "All required resources already present")
          }
        } else {
          callbacks.onNodeLog?.(INIT_NODE_ID, "No skills/agents references found in workflow")
        }
      } else {
        callbacks.onNodeLog?.(INIT_NODE_ID, "Resource preflight not configured, skipping")
      }

      // Step 2: Optional git sync
      if (syncMainBranch && gitOps) {
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
              callbacks.onNodeLog?.(
                INIT_NODE_ID,
                `⚠ ${projectName} sync failed: ${errorMsg}`,
              )
              return { project: projectName, success: false, error: errorMsg } as GitSyncResult
            }
          },
        )

        gitSyncResults.push(...Object.values(results))

        const syncFailures = gitSyncResults.filter((r) => !r.success)
        if (syncFailures.length > 0) {
          callbacks.onNodeLog?.(
            INIT_NODE_ID,
            `${syncFailures.length} project(s) failed to sync (continuing anyway)`,
          )
        }
      } else if (syncMainBranch && !gitOps) {
        callbacks.onNodeLog?.(INIT_NODE_ID, "Git sync requested but gitOps not configured")
      } else {
        callbacks.onNodeLog?.(INIT_NODE_ID, "Git sync skipped (disabled)")
      }

      const durationMs = Date.now() - startTime
      if (!nodeEndEmitted) {
        callbacks.onNodeEnd?.(INIT_NODE_ID, "completed", durationMs)
      }

      return {
        status: "completed",
        durationMs,
        skillsCopied,
        agentsCopied,
        gitSyncResults,
      }
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime

      if (!nodeEndEmitted) {
        callbacks.onNodeEnd?.(INIT_NODE_ID, "failed", durationMs)
      }

      return {
        status: "failed",
        durationMs,
        skillsCopied,
        agentsCopied,
        gitSyncResults,
      }
    }
  }
}
