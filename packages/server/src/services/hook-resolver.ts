// packages/server/src/services/hook-resolver.ts
import type { HookDef, WorkflowHooks } from "@octopus/shared"

export type HookEvent =
  | "on_node_success"
  | "on_node_failure"
  | "on_workflow_failure"
  | "on_cancel"
  | "on_interrupt"
  | "on_retry"
  | "on_success"
  | "on_complete"

export type PipelineHooks = {
  [K in HookEvent]?: HookDef[]
}

export class HookResolver {
  /**
   * 解析 hooks 优先级
   * 规则:
   * - workflow 定义了该事件（包括空数组）→ 使用 workflow hooks
   * - workflow 未定义该事件 → 使用 pipeline hooks
   * - 都未定义 → 返回空数组
   */
  resolve(
    event: HookEvent,
    workflowHooks: WorkflowHooks | undefined,
    pipelineHooks: PipelineHooks | undefined
  ): HookDef[] {
    // 检查 workflow 是否显式定义了该事件
    const wfHasEvent = workflowHooks && event in workflowHooks
    if (wfHasEvent) {
      return workflowHooks[event] ?? []
    }

    // fallback 到 pipeline hooks
    return pipelineHooks?.[event] ?? []
  }

  /**
   * 检查事件是否有 hooks（workflow 或 pipeline）
   */
  hasHooks(
    event: HookEvent,
    workflowHooks: WorkflowHooks | undefined,
    pipelineHooks: PipelineHooks | undefined
  ): boolean {
    const hooks = this.resolve(event, workflowHooks, pipelineHooks)
    return hooks.length > 0
  }
}
