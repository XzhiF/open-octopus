// packages/web-app/components/tasks/run-console/phase-status.ts
//
// 执行态控制台的「状态词表 + 判据」单源 —— rail 节点、轮次 chips、导航条状态
// pill 全部从这里取色取词（2026-09-12 执行弹窗改版：PhaseTimeline 退役后，
// 票 11 的显示词表原样搬入，钉点语义不变）。

import type { TaskRoundView } from "@/lib/tasks-api"

/** 派生态 phase 词表 → 中文。注意这不是共享的 TaskPhaseStatusSchema：那是持久节点
 *  词表，而这里描述 deriveTaskView 的输出，多一个 'paused'（无持久对应物）。 */
export const PHASE_STATUS_LABEL: Record<string, string> = {
  pending: "未开始",
  running: "执行中",
  paused: "已暂停",
  awaiting_review: "待验收",
  accepted: "已通过",
}

/** 状态词 → 任务状态 pill（导航条），与旧 ModalHeader STATUS_LABEL 同词。 */
export const TASK_STATUS_LABEL: Record<string, string> = {
  draft: "草稿", ready: "待执行", running: "执行中", paused: "已暂停",
  awaiting_review: "待验收", archiving: "归档中",
  done: "已完成", failed: "失败", aborted: "已中止",
}

/** 状态词 → 任务状态 pill（导航条）。暖黑 TUI 版：一状态一 accent，pill 一律
 *  「soft 深底 + accent 字 + accent 细边」（原型 .pill.p-*）。
 *  执行中固定琥珀、待验收固定黄 —— 与看板列 accent 同一个色语，不再用紫色
 *  （换底后 --pop-purple 与 --pop-pink 同值，紫已不承担「运行」语义）。 */
export const TASK_PILL: Record<string, string> = {
  ready: "border-pop-cyan/45 bg-pop-cyan-soft text-pop-cyan",
  running: "border-pop-amber/45 bg-pop-amber-soft text-pop-amber animate-pulse",
  // 暂停不 pulse：它没有在动，闪烁会谎报「还在跑」。
  paused: "border-pop-bd bg-pop-idle text-pop-dim",
  awaiting_review: "border-pop-yellow/45 bg-pop-yellow-soft text-pop-yellow",
  archiving: "border-pop-amber/45 bg-pop-amber-soft text-pop-amber",
  done: "border-pop-green/45 bg-pop-green-soft text-pop-green",
  failed: "border-pop-red/45 bg-pop-pink-soft text-pop-red",
  aborted: "border-pop-bd bg-pop-idle text-pop-dim",
}

/** rail 节点 P# 瓷砖色。accent 整面填充上的字统一走 --pop-bg（暖黑盘上
 *  amber/yellow/cyan/green 都是亮色，深字压亮底）。ready 语境下第一个
 *  pending = 「下一发」给 cyan 点亮。 */
export function phaseTileTone(status: string, isNext: boolean): string {
  switch (status) {
    case "accepted": return "bg-pop-green text-pop-bg"
    case "awaiting_review": return "bg-pop-yellow text-pop-bg"
    case "running": return "bg-pop-amber text-pop-bg"
    case "paused": return "bg-pop-amber-soft text-pop-dim"
    default: return isNext ? "bg-pop-cyan text-pop-bg" : "bg-pop-idle text-pop-dim"
  }
}

/** rail 节点状态小 pill。 */
export const PHASE_PILL: Record<string, string> = {
  pending: "bg-pop-idle text-pop-dim",
  running: "bg-pop-amber-soft text-pop-amber",
  paused: "bg-pop-idle text-pop-dim",
  awaiting_review: "bg-pop-yellow-soft text-pop-yellow",
  accepted: "bg-pop-green-soft text-pop-green",
}

/** 轮次 chip 配色（人决策盖机器状态，同票 11 判据）。 */
export function roundTone(r: TaskRoundView): string {
  if (r.decision === "accepted") return "bg-pop-green-soft text-pop-green"
  if (r.decision === "rejected") return "bg-pop-pink-soft text-pop-red"
  switch (r.state) {
    case "succeeded": return "bg-pop-green-soft text-pop-green"
    case "failed": return "bg-pop-pink-soft text-pop-red"
    case "cancelled": return "bg-pop-idle text-pop-dim"
    case "running": return "bg-pop-amber-soft text-pop-amber animate-pulse"
    // 暂停：dim 且去 pulse —— 它确实没在跑。
    case "paused": return "bg-pop-idle text-pop-dim"
    default: return "bg-pop-idle text-pop-dim"
  }
}

/** Round chip glyph — the human decision (ledger) outranks the machine state. */
export function roundGlyph(r: TaskRoundView): string {
  if (r.decision === "accepted") return "✓"
  if (r.decision === "rejected") return "✗"
  switch (r.state) {
    case "succeeded": return "●"
    case "failed": return "●"
    case "cancelled": return "○"
    case "running": return "▶"
    case "paused": return "⏸"
    default: return "…"
  }
}

/** ⏳ 超预算（K2/D18 advisory）：仅跑轮（pending/running）且 created_at 距今 > budgetMs。
 *  derived 的 exec 只带 created_at —— 与退役前的 PhaseTimeline 完全同判据。 */
export function roundOverBudget(r: TaskRoundView, now: number, budgetMs: number): boolean {
  if (r.state !== "pending" && r.state !== "running") return false
  const started = Date.parse(r.exec.created_at)
  if (Number.isNaN(started)) return false
  return now - started > budgetMs
}

/** 条内时间显示：MM-DD HH:mm（短表，长表留给 title hover）。
 *  命名刻意避开 fmt/format 前缀（formatter revival gate C4 单源立法）。 */
export function clockShort(iso: string | null | undefined): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Σ 实跑段：逐轮加 (completed_at ?? running 时取 now) − started_at，替代墙钟总跨度 ——
 *  待验收挂一夜会把墙钟读成跑时（「已用 17h36m」之误）。pending/paused 未闭行不计。 */
export function sumRunMs(
  runs: Array<{ started_at?: string | null; completed_at?: string | null; status?: string }>,
  now: number,
): { ms: number; count: number } {
  let ms = 0
  let count = 0
  for (const r of runs) {
    if (!r.started_at) continue
    const start = Date.parse(r.started_at)
    if (Number.isNaN(start)) continue
    let end = r.completed_at ? Date.parse(r.completed_at) : NaN
    if (Number.isNaN(end) && r.status === "running") end = now
    if (Number.isNaN(end) || end <= start) continue
    ms += end - start
    count += 1
  }
  return { ms, count }
}
