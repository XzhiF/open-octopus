// packages/server/src/services/execution/HookExecutor.ts
//
// Architecture note: This HookExecutor handles `type: "bash"` and `type: "agent"` hooks
// on the SERVER path (using DB var_pool). `type: "notify"` hooks are dispatched by the
// engine's executeNotifyHook (using in-memory VarPool) to prevent double-dispatch.
// See engine.ts runHooks() for the notify dispatch path.
//
import type { IHookExecutor } from "./interfaces"
import type { ServiceContext } from "./types"
import type { HookDef, NodeDef, WorkflowDef, WorkflowHooks } from "@octopus/shared"
import { VarPool, evaluateExpression } from "@octopus/shared"
import { BashExecutor, AgentExecutor, AgentNodeRunner } from "@octopus/engine"
import { getProvider } from "@octopus/providers"
import type { ExecutionDAO } from "../../db/dao/execution-dao"

export class HookExecutor implements IHookExecutor {
  constructor(
    private ctx: ServiceContext,
    private dao: ExecutionDAO,
  ) {}

  /**
   * Execute workflow hooks for a given event. Called from ExecutionLifecycle
   * after engine completion (on_success, on_workflow_failure, on_complete, etc.).
   * Reads hooks directly from the workflow definition.
   */
  async executeWorkflowHooks(
    event: string,
    context: any,
    workflow: any,
    executionId: string,
  ): Promise<void> {
    const wf = workflow as { parsed: WorkflowDef }
    const hooks = wf.parsed.hooks?.[event as keyof WorkflowHooks]
    if (!hooks || hooks.length === 0) return

    const exec = this.dao.findById(executionId)
    let poolSnapshot: Record<string, string> = {}
    if (exec?.var_pool) {
      try { poolSnapshot = JSON.parse(exec.var_pool) } catch { /* use empty pool */ }
    }

    for (const hook of hooks) {
      // Evaluate condition — skip hook if condition is false
      if (hook.condition) {
        const tempPool = new VarPool({ ...poolSnapshot })
        const shouldRun = evaluateExpression(hook.condition, tempPool, {})
        if (!shouldRun) continue
      }

      // Skip notify hooks — handled by engine
      if (hook.type === "notify") continue

      const hookVars: Record<string, string> = {
        "hook.event": event.replace("on_", ""),
        "hook.workflow_name": wf.parsed.name,
        "hook.execution_id": executionId,
        "hook.timestamp": new Date().toISOString(),
        ...Object.fromEntries(Object.entries(context).map(([k, v]) => [`hook.${k}`, String(v ?? "")])),
      }

      try {
        if (hook.type === "bash" || hook.bash) {
          await this.executeBashHookServer(hook, poolSnapshot, hookVars)
        } else {
          await this.executeAgentHookServer(hook, wf.parsed, poolSnapshot, hookVars)
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`[Hook] ${event}/${hook.id ?? "anonymous"} failed: ${msg}\n`)
      }
    }
  }

  private async executeBashHookServer(
    hook: HookDef, poolSnapshot: Record<string, string>, hookVars: Record<string, string>,
  ): Promise<void> {
    const pool = new VarPool({ ...poolSnapshot })
    pool.update(hookVars)
    const bashNode: NodeDef = {
      id: hook.id ?? `hook-bash-${Date.now()}`, type: "bash",
      bash: hook.bash!, timeout: hook.timeout ?? 60,
    }
    const executor = new BashExecutor(bashNode, pool, undefined,
      (line, stream) => {
        const label = `[Hook:${hook.id ?? "bash"}${stream === "stderr" ? ":err" : ""}]`
        process.stderr.write(`${label} ${line}\n`)
      }, this.ctx.workspacePath)
    await executor.execute()
  }

  private async executeAgentHookServer(
    hook: HookDef, wf: WorkflowDef, poolSnapshot: Record<string, string>, hookVars: Record<string, string>,
  ): Promise<void> {
    const pool = new VarPool({ ...poolSnapshot })
    pool.update(hookVars)
    const providerKey = hook.engine ?? wf.engine ?? "claude"
    const provider = getProvider(providerKey)
    const agentNode: NodeDef = {
      id: hook.id ?? `hook-agent-${Date.now()}`, type: "agent",
      prompt: hook.prompt!, model: hook.model ?? wf.model,
      timeout: hook.timeout ?? 120, context: "new",
    }
    const runner = new AgentNodeRunner(provider, this.ctx.workspacePath, () => {})
    const executor = new AgentExecutor(agentNode, pool, runner, undefined, wf.auto_answers, undefined)
    await executor.execute()
  }
}
