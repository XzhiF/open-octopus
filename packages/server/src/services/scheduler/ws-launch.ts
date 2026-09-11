// packages/server/src/services/scheduler/ws-launch.ts
//
// 任务工作区「起跳参数」共享纯函数 —— 从 WorkflowExecutor 抽出的单一来源。
//
// 存在理由（trigger-prebuild 2026-09-08）：v4 触发执行现在在 triggerTask 里
// **同步预建** workspace+worktree（失败 409 弹回），executor 认领时命中绑定
// 走复用路径。两处必须产出**逐字节一致**的 branch_prefix / branch_suffix /
// workspace 展示名，否则预建的 ws 永远不被 executor 复用（多 ws-per-task
// 漂移回归）。命名规则一旦改动，两个调用方经由本文件原子地一起变。
//
// 纪律：本文件只放纯函数（无 IO / 无 git / 无 DB）；executor 与
// task-dispatch-service 的本地 formatBranchSuffix 副本已收敛于此。

import { COMPOSITION_WF_REF } from "./orchestration-strategy"
import { taskWorkspaceName } from "./task-ws-name"

/** `YYYYMMDDHHmmss-<rand4>` 分支/目录唯一性尾缀。executor 与 task-dispatch
 *  历史上的两份逐字相同副本合一（勿改格式 — schedule_workspaces 反查依赖）。 */
export function formatBranchSuffix(date: Date): string {
  const y = date.getFullYear()
  const mo = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  const h = String(date.getHours()).padStart(2, "0")
  const mi = String(date.getMinutes()).padStart(2, "0")
  const s = String(date.getSeconds()).padStart(2, "0")
  const rand = Math.random().toString(36).substring(2, 6)
  return `${y}${mo}${d}${h}${mi}${s}-${rand}`
}

/** 结构最小面 — WorkflowConfig 可赋值；trigger 侧从信封 config JSON 也喂得进。 */
export interface CompositeProbe {
  task_spec?: { subunits?: unknown[] }
  workflow_chain?: Array<{ workflow_ref?: string | undefined }>
}

/** POST-materialization 复合判定（WorkflowExecutor.isCompositeTask 的规则的
 *  verbatim 迁移）：subunits≥2 或 chain[0] 指向 composition wf。与
 *  orchestration-strategy 共享 COMPOSITION_WF_REF 常量，两层永不漂移。 */
export function isCompositeWorkflowConfig(config: CompositeProbe): boolean {
  if ((config.task_spec?.subunits?.length ?? 0) >= 2) return true
  const ref = config.workflow_chain?.[0]?.workflow_ref
  if (typeof ref === "string") {
    return ref === COMPOSITION_WF_REF || ref.endsWith(`/${COMPOSITION_WF_REF}`)
  }
  return false
}

/** Naming block (workflow-executor.ts:222-237 的 verbatim 语义迁移).
 *
 *  ADR-0021 票03: the discriminator used to be the derived string
 *  `trigger_source === 'requirement'`, and the id used to be a schedule id — both
 *  artifacts of tasks being launched through the scheduler. It is now an explicit
 *  `naming` axis plus an `instanceKey`:
 *    - `naming:'task'` + instanceKey = the TASK id → deterministic `taskpool-{taskId}`
 *      branch prefix, so every round of one task shares a branch lineage (was
 *      `taskpool-{envelopeId}`, which changed if the task was reopened + re-enqueued);
 *    - `naming:'cron'` → the job's own AI-authored workspace_spec.branch_prefix.
 *  taskRow=null (v3/cron/查无任务) → 回退旧 taskpool 命名,与抽前一致. */
export function computeTaskWsLaunchParams(a: {
  /** Stable per-run-series identifier: task id for a task launch, schedule id for a job. */
  instanceKey: string
  naming: "task" | "cron"
  config: { workspace_spec: { branch_prefix: string } } & CompositeProbe
  taskRow: { name: string | null; task_spec: string | null | unknown } | null
  date?: Date
}): { branchPrefix: string; branchSuffix: string; workspaceName: string } {
  const branchSuffix = formatBranchSuffix(a.date ?? new Date())
  const isTask = a.naming === "task"
  const branchPrefix = isTask ? `taskpool-${a.instanceKey}` : a.config.workspace_spec.branch_prefix
  const taskWsName = a.taskRow
    ? taskWorkspaceName({ name: a.taskRow.name, task_spec: a.taskRow.task_spec })
    : null
  const workspaceName =
    taskWsName ??
    (isTask
      ? `${branchPrefix}-${branchSuffix}`
      : `${a.config.workspace_spec.branch_prefix}-${branchSuffix}`)
  return { branchPrefix, branchSuffix, workspaceName }
}
