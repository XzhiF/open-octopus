// packages/web-app/components/tasks/phase-timeline.tsx
//
// PhaseTimeline — task-phase-redesign 票 11（US7/US16, K3/K14）：TaskRunDetailView
// 顶部的 phase 时间线。每 phase 一行：名 / 状态色点 / workflowRef / rounds 历史
// chips（R1 ✗ 打回 → R2 ✓ 通过 全程可追溯）。
//
// 数据源 = GET /api/tasks/:id 的 `derived`（票 03 deriveTaskView 唯一真相原样透传，
// 票 07 契约）。本组件 MUST NOT 重新实现派生矩阵 — 只渲染 phaseViews[]。
//
// 三态语义（票 11 prompt）：
//   • v4：行数 = phaseViews.length（AC3）。
//   • v3 legacy：derived.isV4=false → 单行 `{legacy:true}` 派生呈现（US16，
//     「v3 存量任务照常跑完并以 legacy 单 phase 呈现」）。
//   • derived 缺失（旧 server / 测试 mock）→ 静默 null，不抛错（execution-summary
//     既有测试的 getTask 桩不带 derived — 不回归）。
//
// ⏳ 超预算徽标（AC4，K2/D18 advisory）：仅在跑轮（pending/running）且
// now - exec.created_at > budgetMs。derived 的 exec 只带 created_at，终态轮的
// 用时核对属票 12 三栏「执行摘要」，此处天然只标在跑轮。阈值 phaseBudgetMs() =
// NEXT_PUBLIC_PHASE_BUDGET_MS ?? 1.5h。

"use client"

import type { TaskPhaseView, TaskRoundView, TaskDerivedView } from "@/lib/tasks-api"
import { phaseBudgetMs } from "@/lib/task-board"

/** Display status vocabulary (mirror of shared TaskPhaseStatusSchema). */
export const PHASE_STATUS_LABEL: Record<string, string> = {
  pending: "未开始",
  running: "执行中",
  awaiting_review: "待验收",
  accepted: "已通过",
}

const PHASE_DOT: Record<string, string> = {
  pending: "bg-muted-foreground/60",
  running: "bg-blue-500 animate-pulse",
  awaiting_review: "bg-amber-500",
  accepted: "bg-emerald-500",
}

const STATUS_BADGE_TONE: Record<string, string> = {
  pending: "bg-muted text-muted-foreground",
  running: "bg-blue-500/15 text-blue-500",
  awaiting_review: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  accepted: "bg-emerald-500/15 text-emerald-600",
}

const ROUND_TONE: Record<string, string> = {
  pending: "border-border text-muted-foreground",
  running: "border-blue-400/50 bg-blue-500/10 text-blue-500",
  succeeded: "border-emerald-400/40 bg-emerald-500/10 text-emerald-600",
  failed: "border-red-400/40 bg-red-500/10 text-red-500",
  cancelled: "border-zinc-400/40 bg-zinc-500/10 text-zinc-500",
}

/** Round chip glyph — the human decision (ledger) outranks the machine state. */
function roundGlyph(r: TaskRoundView): string {
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

function roundOverBudget(r: TaskRoundView, now: number, budgetMs: number): boolean {
  if (r.state !== "pending" && r.state !== "running") return false
  const started = Date.parse(r.exec.created_at)
  if (Number.isNaN(started)) return false
  return now - started > budgetMs
}

export interface PhaseTimelineProps {
  /** GET /:id 的 derived 字段（票 07 契约）。undefined = 旧 server → 不渲染。 */
  derived: TaskDerivedView | undefined | null
  /** 超预算阈值 ms；缺省 = phaseBudgetMs()（env NEXT_PUBLIC_PHASE_BUDGET_MS）。 */
  budgetMs?: number
  /** 可注入时钟（测试确定性）；缺省 Date.now()。 */
  now?: number
}

export function PhaseTimeline({ derived, budgetMs, now }: PhaseTimelineProps) {
  if (!derived) return null
  const budget = budgetMs ?? phaseBudgetMs()
  const t = now ?? Date.now()

  // ── v3 legacy：单行派生呈现（US16/AC3） ──
  if (!derived.isV4) {
    const st = derived.taskStatus
    const dot =
      st === "done" ? "bg-emerald-500"
        : st === "failed" ? "bg-red-500"
          : st === "aborted" ? "bg-zinc-500"
            : st === "running" || st === "awaiting_review" || st === "archiving" ? "bg-blue-500 animate-pulse"
              : "bg-muted-foreground/60"
    return (
      <section className="rounded-lg border border-border p-4" data-testid="phase-timeline">
        <header className="flex items-center gap-2 mb-2">
          <h3 className="text-sm font-semibold">Phase 时间线</h3>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">
            v3 legacy
          </span>
        </header>
        <div
          data-testid="phase-row-legacy"
          data-phase-status={st}
          className="flex items-center gap-2 text-sm"
        >
          <span className={`size-2 rounded-full shrink-0 ${dot}`} />
          <span className="font-medium">v3 单阶段（legacy）</span>
          <span className="text-xs text-muted-foreground">按旧链路整体执行一次</span>
          <span className="ml-auto text-xs text-muted-foreground">{st}</span>
        </div>
      </section>
    )
  }

  // ── v4：每 phase 一行 ──
  return (
    <section className="rounded-lg border border-border p-4" data-testid="phase-timeline">
      <header className="flex items-center justify-between gap-2 mb-2">
        <h3 className="text-sm font-semibold">Phase 时间线</h3>
        <span className="text-xs text-muted-foreground">{derived.phaseViews.length} 个 phase</span>
      </header>
      {derived.phaseViews.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-phase-empty>
          尚无 phase —— 拆分确认（对话出口）后出现。
        </p>
      ) : (
        <ol className="space-y-1.5">
          {derived.phaseViews.map((p: TaskPhaseView) => {
            const awaiting = p.status === "awaiting_review"
            return (
              <li
                key={p.index}
                data-testid={`phase-row-${p.index}`}
                data-phase-status={p.status}
                className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-2.5 py-1.5 text-sm ${
                  awaiting ? "border-amber-400/50 bg-amber-500/5" : "border-border"
                }`}
              >
                <span className={`size-2 rounded-full shrink-0 ${PHASE_DOT[p.status] ?? "bg-muted-foreground"}`} />
                <span className="text-xs text-muted-foreground shrink-0 tabular-nums">{p.index}.</span>
                <span className="font-medium truncate max-w-[240px]">{p.name}</span>
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${STATUS_BADGE_TONE[p.status] ?? "bg-muted text-muted-foreground"}`}
                  data-phase-status-label={p.status}
                >
                  {PHASE_STATUS_LABEL[p.status] ?? p.status}
                </span>
                <code className="text-[10px] text-muted-foreground truncate max-w-[200px]">{p.workflowRef}</code>
                <span className="ml-auto flex items-center gap-1 shrink-0">
                  {p.rounds.map((r) => {
                    const over = roundOverBudget(r, t, budget)
                    // ADR-0018: show the ACTUALLY-RAN workflow (fix rounds run
                    // task-fix while the phase binding stays the dev flow).
                    const ran = (r.exec.workflow_ref ?? p.workflowRef).replace(/^built-in\//, "")
                    const title = over
                      ? `R${r.roundIndex}（${ran}）已跑超预算（${Math.round(budget / 60000)} 分钟，advisory）`
                      : `R${r.roundIndex} · ${ran}${r.state}${r.decision ? ` · ${r.decision}` : ""}`
                    return (
                      <span
                        key={r.roundIndex}
                        data-testid={`phase-round-${p.index}-${r.roundIndex}`}
                        data-overbudget={String(over)}
                        title={title}
                        className={`text-[10px] px-1.5 py-0.5 rounded border tabular-nums ${ROUND_TONE[r.decision === "accepted" ? "succeeded" : r.decision === "rejected" ? "failed" : r.state] ?? ROUND_TONE[r.state] ?? ROUND_TONE.pending}`}
                      >
                        {`R${r.roundIndex} ${roundGlyph(r)}${over ? " ⏳" : ""}`}
                      </span>
                    )
                  })}
                </span>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
