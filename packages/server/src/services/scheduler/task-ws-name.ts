// packages/server/src/services/scheduler/task-ws-name.ts
//
// 任务启动时的 workspace 展示名 (2026-08-29)：`task:{任务标题}`。
// 标题取值与看板弹窗同源 —— task.name 优先；仍是默认名（用户没改过）时，
// 按 chatbot 会话同款规则从 spec.goal 生成智能标题（clone/index.ts:625 的
// slice(0,20)+去换行 口径）。
//
// ⚠ 唯一性 token：workspaces.name 直接用作目录名（workspace.ts createFromSpec:
// `~/.octopus/{org}/workspaces/{name}`，同名目录会被 rmSync 覆盖重建）。同一任务
// 重复触发必须各自落盘，故名字尾部固定拼 `-MMDD-HHmmss`。branch_prefix 仍保持
// 确定性的 `taskpool-{scheduleId}`（git 分支名，不进展示）。

import { DEFAULT_TASK_NAME } from "../tasks/tasks-service"

/** chatbot 会话智能标题同款截断。 */
const TITLE_MAX = 20

/** 任务展示标题：用户改过名 → 用名；默认名 → goal 前 20 字；都没有 → ""。 */
export function taskDisplayTitle(row: { name: string | null; task_spec: string | null | unknown }): string {
  const name = (row.name ?? "").trim()
  if (name && name !== DEFAULT_TASK_NAME) return name
  try {
    const spec = typeof row.task_spec === "string" ? JSON.parse(row.task_spec) : (row.task_spec ?? {})
    const goal = (spec as { goal?: unknown }).goal
    if (typeof goal === "string") return goal.slice(0, TITLE_MAX).replace(/\n/g, " ").trim()
  } catch { /* 坏 JSON → 无标题，调用方回退旧命名 */ }
  return ""
}

/** `task:{标题}` / `task:{标题}·{子单元名}` + `-MMDD-HHmmss` 唯一性尾缀。
 *  返回 null 表示无从取名（无 name 且无 goal），调用方保留 taskpool-{id} 兜底。 */
export function taskWorkspaceName(
  row: { name: string | null; task_spec: string | null | unknown },
  opts?: { subName?: string; date?: Date },
): string | null {
  const title = taskDisplayTitle(row)
  if (!title) return null
  const d = opts?.date ?? new Date()
  const p = (n: number) => String(n).padStart(2, "0")
  const ts = `${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  const core = opts?.subName ? `${title}·${opts.subName}` : title
  // name 即目录名 —— 剥掉文件系统保留字符。
  return `task:${core.replace(/[/\\:*?"<>|]/g, "")}-${ts}`
}
