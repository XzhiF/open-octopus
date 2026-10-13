import type { EngineCallbacks } from "./engine"
import type { WorkflowDef } from "@octopus/shared"
import type { JsonlLogger } from "./logger"
import { IdentityResolver } from "./executors/identity-resolver"
import { checkAsRefs } from "./identity-gate"
import { collectAgentIdentityRefs } from "./precompute-gate"
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
  /**
   * 07 (SG7): config.requires from the schedule's WorkflowConfig (propagated
   * by materializeTaskSpecToConfig from tasks.resources[] + subunit.resources[]).
   * UNION-merged with workflow.requires for provisioning — does NOT override
   * workflow-defined requires; duplicates across both sources are deduped.
   * Optional: existing call sites (no schedule config) omit it and behavior
   * is unchanged (workflow.requires alone drives provisioning).
   */
  configRequires?: {
    skills?: string[]
    agent_files?: string[]
    commands?: string[]
    rules?: string[]
  }
  /**
   * Execution-identity resolver for the `as:` L3 hard gate (ticket 10).
   * Server injects one backed by the published VersionResolver so
   * snapshot-only identities pass; when omitted the gate falls back to a
   * filesystem-only resolver (built-in/clones directory probe, real HOME)
   * — the same dual-path shape as the Step 0 clone gate.
   */
  identityResolver?: IdentityResolver
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
  /** L3 `as:` identity hard-gate errors (ticket 10) — one per unresolvable site. */
  identityErrors: string[]
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
  identityErrors: string[]
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

/**
 * 07 (SG7): UNION-merge workflow.requires + configRequires (from the schedule's
 * WorkflowConfig.requires, propagated by materializeTaskSpecToConfig). Does NOT
 * override workflow.requires — duplicates are deduped via Set. `clones` come
 * only from workflow.requires (config.requires schema omits clones; tasks do
 * not provision clones via config — manual-install per ResourceProvisioner).
 * Returns a full requires object (all 5 buckets, possibly empty) so downstream
 * Step 0/Step 1 code reads a single merged source without re-merging.
 */
function mergeRequires(
  wf?: {
    skills?: string[]
    agent_files?: string[]
    commands?: string[]
    rules?: string[]
    clones?: string[]
  },
  cfg?: {
    skills?: string[]
    agent_files?: string[]
    commands?: string[]
    rules?: string[]
  },
): {
  skills: string[]
  agent_files: string[]
  commands: string[]
  rules: string[]
  clones: string[]
} {
  const skills = new Set([...(wf?.skills ?? []), ...(cfg?.skills ?? [])])
  const agent_files = new Set([...(wf?.agent_files ?? []), ...(cfg?.agent_files ?? [])])
  const commands = new Set([...(wf?.commands ?? []), ...(cfg?.commands ?? [])])
  const rules = new Set([...(wf?.rules ?? []), ...(cfg?.rules ?? [])])
  const clones = new Set([...(wf?.clones ?? [])])
  return {
    skills: [...skills],
    agent_files: [...agent_files],
    commands: [...commands],
    rules: [...rules],
    clones: [...clones],
  }
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
      cloneErrors: ctx.cloneErrors, identityErrors: ctx.identityErrors, gitSyncResults: syncResults,
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
      identityErrors: current.identityErrors,
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
      configRequires,
      identityResolver,
    } = options

    const startTime = Date.now()
    const ctx: ProvisionContext = {
      skillsCopied: 0, agentsCopied: 0, commandsCopied: 0, rulesCopied: 0,
      cloneErrors: [], identityErrors: [], failed: false,
    }

    // Write start event to JSONL log
    logger?.log(INIT_NODE_ID, "start", { type: INIT_NODE_TYPE })

    callbacks.onNodeStart?.(INIT_NODE_ID, INIT_NODE_TYPE)

    try {
      // 07 (SG7): UNION-merge workflow.requires + configRequires (from the
      // schedule's WorkflowConfig.requires, propagated by materialize). The
      // merged set drives all downstream provisioning (Step 0 clones gate +
      // Step 1 requires provisioning) so config-declared resources are
      // installed into the workspace's .claude/skills|agents|commands|rules
      // alongside workflow-declared ones. Does NOT override workflow.requires
      // — duplicates are deduped via Set. configRequires is optional;
      // omitting it (existing call sites) leaves workflow.requires unchanged.
      const mergedRequires = mergeRequires(workflow.requires, configRequires)

      // Step 0: Clone hard-fail gate — check BEFORE provisioning
      const requiresClones = mergedRequires.clones
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

      // Step 0.5: Execution-identity `as:` hard-fail gate (ticket 10) —
      // every explicit as: target must resolve NOW, mirroring Step 0's
      // requires.clones existence check. Unresolvable ⇒ failed init,
      // provisioning and execution never start (no doomed run).
      const asErrors = checkAsRefs(
        workflow.nodes,
        identityResolver ?? new IdentityResolver({}),
      )
      if (asErrors.length > 0) {
        for (const errorMsg of asErrors) {
          this.logMessage(logger, callbacks, `[ERROR] ${errorMsg}`)
          ctx.identityErrors.push(errorMsg)
        }
        ctx.failed = true

        const durationMs = Date.now() - startTime
        logger?.log(INIT_NODE_ID, "end", { status: "failed", durationMs })
        callbacks.onNodeEnd?.(INIT_NODE_ID, "failed", durationMs)
        return this.buildResult(ctx, "failed", durationMs)
      }

      // Step 1: Provision declared requires resources first
      const requiresSkills = mergedRequires.skills
      const requiresAgentFiles = mergedRequires.agent_files
      const requiresCommands = mergedRequires.commands
      const requiresRules = mergedRequires.rules
      const hasRequires = requiresSkills.length > 0 || requiresAgentFiles.length > 0
        || requiresCommands.length > 0 || requiresRules.length > 0 || requiresClones.length > 0

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
          callbacks, hasRequires, ctx, logger, identityResolver,
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
    identityResolver?: IdentityResolver,
  ): Promise<ProvisionContext> {
    if (hasRequires) {
      this.logMessage(logger, callbacks, "Scanning for additional resources...")
    }

    const manifest = preflight.analyze(workflow)
    // D2（review fix #2 + addendum）：身份声明技能（snapshot.skills ∪ config.skills）
    // 并入 provisioning 集 ——
    // 无 `skills:` 声明的 agent 节点（缺省 workflow-operator / as: 目标）过去
    // 只进 SDK 白名单、不落文件，octo-wiki 在 workspace .claude/skills 缺席。
    // 合并后走既有 Provisioner 文件物化 → SDK 原生发现（ADR-0006，非 prompt 文本）。
    const identitySkills = this.collectIdentitySkills(
      workflow.nodes,
      identityResolver ?? new IdentityResolver({}),
    )
    const mergedManifest: ResourceManifestLike = identitySkills.length === 0
      ? manifest
      : { ...manifest, skills: [...new Set([...manifest.skills, ...identitySkills])] }
    if (identitySkills.length > 0) {
      this.logMessage(logger, callbacks, `Identity skills merged into provisioning set: ${identitySkills.join(", ")}`)
    }
    this.logMessage(logger, callbacks, `Analyzing resources: ${mergedManifest.skills.length} skills, ${mergedManifest.agents.length} agents`)

    const totalResources = mergedManifest.skills.length + mergedManifest.agents.length
    if (totalResources === 0) {
      this.logMessage(logger, callbacks, "No skills/agents references found in workflow")
      return ctx
    }

    const check = preflight.check(mergedManifest, workspacePath)
    if (check.missing.length === 0) {
      this.logMessage(logger, callbacks, "All required resources already present")
      return ctx
    }

    return this.provisionMissing(
      check.missing, workspacePath, provisioner, callbacks, "scan", ctx, logger,
    )
  }

  /**
   * D2（review fix #2 + addendum 数据契约修复）— resolve every agent node's
   * execution identity (explicit `as:` or default workflow-operator, loop-nested
   * included) and union their declared skills from TWO sources:
   * ① snapshot.skills (clone 目录 skills/ 子目录) and
   * ② snapshot.config.skills (config.json 顶层治理声明 — built-in 分身唯一来源, 票09).
   * Unresolvable identities degrade gracefully (the Step 0.5
   * L3 gate already hard-fails explicit refs; default-missing must never break
   * existing flows) — their skills are simply skipped.
   */
  private collectIdentitySkills(
    nodes: WorkflowDef["nodes"],
    resolver: IdentityResolver,
  ): string[] {
    const skills = new Set<string>()
    for (const ref of collectAgentIdentityRefs(nodes)) {
      if (ref.includes("$")) continue // variable refs unresolvable at preflight
      try {
        const snapshot = resolver.resolve(ref).snapshot
        // Source ① — 目录形态：分身 skills/ 子目录 readdir → snapshot.skills
        // （真实带 skills/ 的分身走这里，previous review fix 的通路保留）。
        for (const s of snapshot.skills ?? []) {
          if (typeof s === "string" && !s.includes("$")) skills.add(s)
        }
        // Source ② — 治理声明形态（票09 preflight 依据，fix-verification addendum
        // D2 根因）：built-in 分身没有 skills/ 目录（clone-init-service 不种），
        // CloneDef.skills 落在 config.json 顶层 skills → filesToSnapshot /
        // readIdentityFromDir 把整个 config.json 读进 snapshot.config。
        // 只读 ① 时运行时 snapshot.skills=[] ⇒ analyze 集为空（本 review fix 的洞）。
        const declared = snapshot.config?.skills
        if (Array.isArray(declared)) {
          for (const s of declared) {
            if (typeof s === "string" && !s.includes("$")) skills.add(s)
          }
        }
      } catch {
        // graceful: identity absent — same degradation shape as runtime assembly
      }
    }
    return [...skills]
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
