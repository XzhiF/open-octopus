// packages/web-app/components/tasks/run-console/phase-status.ts
//
// 执行态控制台的「状态词表 + 判据」单源 —— rail 节点、轮次 chips、导航条状态
// pill 全部从这里取色取词（2026-09-12 执行弹窗改版：PhaseTimeline 退役后，
// 票 11 的显示词表原样搬入，钉点语义不变）。

import type { TaskRoundView } from "@/lib/tasks-api"

/** 共享线协议词表（TaskPhaseStatusSchema）→ 中文。 */
export const PHASE_STATUS_LABEL: Record<string, string> = {
  pending: "未开始",
  running: "执行中",
  awaiting_review: "待验收",
  accepted: "已通过",
}

/** 状态词 → 任务状态 pill（导航条），与旧 ModalHeader STATUS_LABEL 同词。 */
export const TASK_STATUS_LABEL: Record<string, string> = {
  draft: "草稿", ready: "待执行", running: "执行中",
  awaiting_review: "待验收", archiving: "归档中",
  done: "已完成", failed: "失败", aborted: "已中止",
}

/** 导航条深色底上的状态 pill 配色（pop-* tokens，与看板角标同语义）。 */
export const TASK_PILL: Record<string, string> = {
  ready: "border-pop-cyan text-pop-cyan bg-pop-cyan/10",
  running: "border-pop-purple text-[#a48bff] bg-pop-purple/20 animate-pulse",
  awaiting_review: "border-pop-amber text-pop-amber bg-pop-amber/10",
  archiving: "border-pop-amber text-pop-amber bg-pop-amber/10",
  done: "border-[#33d69f] text-[#33d69f] bg-pop-green/10",
  failed: "border-pop-red text-[#ff8a8f] bg-pop-red/10",
  aborted: "border-pop-bg/30 text-pop-bg/60 bg-pop-bg/10",
}

/** rail 节点 P# 瓷砖色。ready 语境下第一个 pending = 「下一发」给 cyan 点亮。 */
export function phaseTileTone(status: string, isNext: boolean): string {
  switch (status) {
    case "accepted": return "bg-pop-green text-white"
    case "awaiting_review": return "bg-pop-amber text-pop-ink"
    case "running": return "bg-pop-purple text-white"
    default: return isNext ? "bg-pop-cyan text-pop-ink" : "bg-pop-idle text-pop-dim"
  }
}

/** rail 节点状态小 pill。 */
export const PHASE_PILL: Record<string, string> = {
  pending: "bg-pop-idle text-pop-dim",
  running: "bg-pop-purple-soft text-pop-purple",
  awaiting_review: "bg-pop-amber-soft text-pop-ink",
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
    case "running": return "bg-pop-purple-soft text-pop-purple animate-pulse"
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
