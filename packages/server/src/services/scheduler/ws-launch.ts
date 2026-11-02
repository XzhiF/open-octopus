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
// 纪律：本文件只放纯函数（无 IO / 无 git / 无 DB）；历史分支尾缀的本地副本已收敛于此。

import { taskBranchPrefix, taskWorkspaceName } from "./task-ws-name"

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

/** Naming block (workflow-executor.ts:222-237 的 verbatim 语义迁移).
 *
 *  ADR-0021 票03: the discriminator used to be the derived string
 *  `trigger_source === 'requirement'`, and the id used to be a schedule id — both
 *  artifacts of tasks being launched through the scheduler. It is now an explicit
 *  `naming` axis plus an `instanceKey`:
 *    - `naming:'task'` + instanceKey = the TASK id → branch prefix via
 *      taskBranchPrefix: spec.branch（author 定名）> `feat-<slug>-<YYYYMMDD>` >
 *      `taskpool-{taskId}` 兜底 —— 一 task 一支系（branch lineage 恒定）;
 *    - `naming:'cron'` → the job's own AI-authored workspace_spec.branch_prefix.
 *  taskRow=null (v3/cron/查无任务) → 回退旧 taskpool 命名,与抽前一致. */
export function computeTaskWsLaunchParams(a: {
  /** Stable per-run-series identifier: task id for a task launch, schedule id for a job. */
  instanceKey: string
  naming: "task" | "cron"
  config: { workspace_spec: { branch_prefix: string } }
  taskRow: { name: string | null; task_spec: string | null | unknown; created_at?: string | null } | null
  date?: Date
}): { branchPrefix: string; branchSuffix: string; workspaceName: string } {
  const branchSuffix = formatBranchSuffix(a.date ?? new Date())
  const isTask = a.naming === "task"
  const branchPrefix = isTask
    ? (a.taskRow ? taskBranchPrefix(a.taskRow) : null) ?? `taskpool-${a.instanceKey}`
    : a.config.workspace_spec.branch_prefix
  const taskWsName = a.taskRow
    ? taskWorkspaceName({ name: a.taskRow.name, task_spec: a.taskRow.task_spec }, { date: a.date })
    : null
  const workspaceName =
    taskWsName ??
    (isTask
      ? `${branchPrefix}-${branchSuffix}`
      : `${a.config.workspace_spec.branch_prefix}-${branchSuffix}`)
  return { branchPrefix, branchSuffix, workspaceName }
}
