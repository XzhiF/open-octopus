// packages/server/src/services/execution/HookExecutor.ts
//
// Architecture note: This HookExecutor handles `type: "bash"` and `type: "agent"` hooks
// on the SERVER path (using DB var_pool). `type: "notify"` hooks are handled by the
// engine's executeNotifyHook (using in-memory VarPool) to prevent double-dispatch.
// See engine.ts runHooks() for the notify dispatch path.
//
import { execFile } from "child_process"
import { promisify } from "util"
import type { IHookExecutor } from "./interfaces"
import type { ServiceContext } from "./types"
import { HookResolver } from "../hook-resolver"
import { PipelineConfigLoader } from "../pipeline-config"
import { VarPool, substituteVars } from "@octopus/shared"
import type { HookDef } from "@octopus/shared"
import { ExecutionDAO } from "../../db/dao"

const execFileAsync = promisify(execFile)

export class HookExecutor implements IHookExecutor {
  private hookResolver: HookResolver
  private pipelineConfigLoader: PipelineConfigLoader
  private execDAO: ExecutionDAO

  constructor(
    private ctx: ServiceContext,
    hookResolver?: HookResolver,
    pipelineConfigLoader?: PipelineConfigLoader,
  ) {
    this.hookResolver = hookResolver || new HookResolver()
    this.pipelineConfigLoader = pipelineConfigLoader || new PipelineConfigLoader(ctx.workspacePath)
    this.execDAO = new ExecutionDAO(ctx.db)
  }

  async executeWorkflowHooks(
    event: string,
    context: any,
    workflow: any,
    executionId: string
  ): Promise<void> {
    // 1. Load pipeline config
    const pipelineConfig = this.pipelineConfigLoader.getConfig()

    // 2. Resolve hooks using priority: workflow > pipeline
    const workflowHooks = workflow.hooks
    const pipelineHooks = pipelineConfig?.hooks

    const hooks = this.hookResolver.resolve(
      event as any,
      workflowHooks,
      pipelineHooks
    )

    if (!hooks || hooks.length === 0) {
      return
    }

    // Architecture: Filter out `type: "notify"` hooks — they are dispatched by engine.ts
    // during execution (using in-memory VarPool). This server-side HookExecutor only handles
    // bash/agent hooks (using DB var_pool). This prevents double-dispatch of notifications.
    const filteredHooks = hooks.filter((h: HookDef) => h.type !== "notify")
    if (filteredHooks.length === 0) return

    let poolSnapshot: Record<string, string> = {}
    try {
      const varPool = this.execDAO.findVarPool(executionId)
      if (varPool) {
        poolSnapshot = JSON.parse(varPool)
      }
    } catch {
      // Malformed var_pool — use empty pool
    }

    // 4. Build hook variables for $hook.xxx substitution
    const hookVars: Record<string, string> = {
      "hook.event": event.replace("on_", ""),
      "hook.workflow_name": workflow.name ?? "",
      "hook.execution_id": executionId,
      "hook.timestamp": new Date().toISOString(),
    }
    for (const [key, value] of Object.entries(context)) {
      hookVars[`hook.${key}`] = String(value ?? "")
    }

    // Unified node_id / node_type aliases
    const nodeId = context.success_node_id ?? context.failed_node_id
    if (nodeId) hookVars["hook.node_id"] = String(nodeId)
    const nodeType = context.success_node_type ?? context.failed_node_type
    if (nodeType) hookVars["hook.node_type"] = String(nodeType)

    // 5. Execute each hook
    for (const hook of filteredHooks) {
      try {
        await this.executeHook(hook, context, executionId, poolSnapshot, hookVars)
      } catch (error: any) {
        console.error(`Hook execution failed: ${error.message}`)
        // Continue with other hooks even if one fails
      }
    }
  }

  private async executeHook(
    hook: any,
    context: any,
    executionId: string,
    poolSnapshot: Record<string, string>,
    hookVars: Record<string, string>
  ): Promise<void> {
    if (hook.type === "bash" || hook.bash) {
      await this.executeBashHook(hook, context, executionId, poolSnapshot, hookVars)
    } else if (hook.type === "agent") {
      throw new Error(`Agent hooks are not yet supported: ${hook.id ?? "anonymous"}`)
    }
    // type: "notify" hooks are intentionally not handled here — see architecture note at top.
  }

  private async executeBashHook(
    hook: any,
    context: any,
    executionId: string,
    poolSnapshot: Record<string, string>,
    hookVars: Record<string, string>
  ): Promise<void> {
    // Create VarPool with snapshot and hook variables for substitution
    const pool = new VarPool({ ...poolSnapshot })
    pool.update(hookVars)

    // Substitute variables in the script ($vars.xxx, $hook.xxx, etc.)
    let script = hook.bash || ""
    script = substituteVars(script, pool)

    // Also set HOOK_* environment variables for backward compatibility
    const hookEnv: Record<string, string> = {
      HOOK_EXECUTION_ID: executionId,
      HOOK_EVENT: context.event ?? "",
      HOOK_TIMESTAMP: context.timestamp ?? new Date().toISOString(),
    }
    for (const [key, value] of Object.entries(context)) {
      hookEnv[`HOOK_${key.toUpperCase()}`] = String(value ?? "")
    }

    try {
      const { stdout, stderr } = await execFileAsync("bash", ["-c", script], {
        cwd: this.ctx.workspacePath,
        timeout: (hook.timeout || 30) * 1000,
        env: { ...process.env, ...hookEnv },
      })

      if (stdout) {
        console.log(`[Hook] ${stdout}`)
      }
      if (stderr) {
        console.error(`[Hook] ${stderr}`)
      }
    } catch (error: any) {
      throw new Error(`Bash hook failed: ${error.message}`)
    }
  }
}
