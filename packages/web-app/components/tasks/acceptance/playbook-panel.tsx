// packages/web-app/components/tasks/acceptance/playbook-panel.tsx
//
// 验收台「验收剧本」(acceptance v2.1, ADR-0022) — the human walkthrough
// checklist the server COMPILES from the round's contract files. Presentational
// + owns its own checkbox state (debounced persistence via PUT home-file).
//
// 还原基准 = .scratch/20260917-acceptance-playbook-proto (A′ 变体): 黄头条主角卡、
// 预算表、票级步(操作/预期/反假跑)、✓✗⊘ 三色后果条、carryover 首段、finePrint 折叠、
// coverage 诚实条。视觉语言与 verify-panel 同源 (pop 贴纸: border-2 border-pop-bd
// bg-pop-paper shadow-pop-sm; 盖章 pop-stamp; 尾注 pop-dim)。
//
// Honesty baked in: never auto-runs; a ✗ blocks 通过 (reported up via onGate);
// ⊘/✗ require a note (rides into reject feedback + next-round carryover).

"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ClipboardCheck, ExternalLink, ChevronRight, ChevronDown } from "lucide-react"
import {
  readChecks, saveChecks, type PlaybookPayload, type PlaybookItem, type CheckDecision, type CheckEntry,
} from "@/lib/tasks-api"

interface PlaybookPanelProps {
  taskId: string
  /** null when specPath is absolute / batch dir unresolvable — panel goes read-only. */
  batchRelDir: string | null
  roundIndex: number
  playbook: PlaybookPayload
  /** Report pass/fail/skip/undecided up so the parent can gate 验收通过 + preview it. */
  onGate: (g: { pass: number; fail: number; skip: number; undecided: number; total: number; failTickets: string[] }) => void
  /** disabled (e.g. workspace gone) — ticking is refused with a reason. */
  disabledReason?: string
  saving: boolean
  onSaveStateChange: (saving: boolean) => void
}

const KIND_LABEL: Record<string, string> = { walk: "走查", probe: "探针", claim: "核对" }

export function PlaybookPanel({
  taskId, batchRelDir, roundIndex, playbook, onGate, disabledReason, saving, onSaveStateChange,
}: PlaybookPanelProps) {
  const [checks, setChecks] = useState<Record<string, CheckEntry>>({})
  const [openFine, setOpenFine] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirtyRef = useRef(false)

  // (re)load persisted checks on task/round switch — a fresh server restart
  // re-reads the .md the panel wrote last time (durable truth).
  useEffect(() => {
    let cancelled = false
    dirtyRef.current = false
    if (!batchRelDir) { setChecks({}); onGate(summarize(playbook, {})); return }
    void readChecks(taskId, batchRelDir, roundIndex).then((f) => {
      if (!cancelled) { setChecks(f.checks ?? {}); onGate(summarize(playbook, f.checks ?? {})) }
    }).catch(() => { if (!cancelled) onGate(summarize(playbook, {})) })
    return () => { cancelled = true }
    // playbook recompute must re-summarize too (step count can shift)
  }, [taskId, batchRelDir, roundIndex, playbook, onGate])

  const persist = useCallback((next: Record<string, CheckEntry>) => {
    if (!batchRelDir) return
    dirtyRef.current = true
    onSaveStateChange(true)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      void saveChecks(taskId, batchRelDir, roundIndex, next)
        .catch(() => {/* toast handled upstream via saving=false + keep local */})
        .finally(() => { dirtyRef.current = false; onSaveStateChange(false) })
    }, 300)
  }, [taskId, batchRelDir, roundIndex, onSaveStateChange])

  const decide = useCallback((id: string, decision: CheckDecision | null, note?: string) => {
    setChecks((prev) => {
      const next = { ...prev }
      if (decision === null) delete next[id]
      else next[id] = { decision, note: note ?? next[id]?.note ?? "", at: new Date().toISOString() }
      onGate(summarize(playbook, next))
      persist(next)
      return next
    })
  }, [playbook, onGate, persist])

  const setNote = useCallback((id: string, note: string) => {
    setChecks((prev) => {
      const cur = prev[id]; if (!cur) return prev
      const next = { ...prev, [id]: { ...cur, note } }
      persist(next)
      return next
    })
  }, [persist])

  const allItems = useMemo(() => playbook.sections.flatMap((s) => s.items), [playbook])

  if (!playbook.available) {
    return (
      <div className="rounded-[13px] border-2 border-dashed border-pop-bd/40 bg-pop-paper p-3 text-[11.5px] text-muted-foreground" data-testid="playbook-empty">
        <div className="flex items-center gap-2">
          <ClipboardCheck className="size-3.5 text-pop-dim" />
          <span className="font-mono text-[10px] font-black tracking-[.09em] text-pop-dim">验收剧本</span>
        </div>
        <p className="mt-1.5">本轮无可编译的契约结构（缺 {playbook.coverage.missing.join(" / ") || "契约文件"}）。</p>
        <p className="mt-1 text-[10.5px]">在批次目录放 <code>e2e-test-plan.md</code> 或末张 <code>NN-e2e-*.md</code>（含 Verification steps / Pass criteria），或用上方「配置命令」把手测指引写成复检。</p>
      </div>
    )
  }

  return (
    <div className="rounded-[13px] border-[2.5px] border-pop-bd bg-pop-paper shadow-pop overflow-hidden" data-acceptance-playbook data-testid="playbook-panel">
      {/* 主角头（黄软条，与 verify-panel 头语言一致） */}
      <div className="flex items-center gap-2 border-b-2 border-pop-bd/10 bg-pop-amber-soft px-3 py-2">
        <ClipboardCheck className="size-3.5 text-pop-ink" />
        <span className="font-mono text-[9.5px] font-black tracking-[.09em] text-pop-ink">人工走查 · 验收剧本</span>
        <span className="ml-auto font-mono text-[9.5px] text-pop-ink/70 tabular-nums" data-testid="playbook-count">
          {countOf(checks, "pass")}/{allItems.length}✓ · {countOf(checks, "skip")}⊘ · {countOf(checks, "fail")}✗
        </span>
      </div>

      <div className="space-y-2 p-3">
        {/* 目标 + 预算表 */}
        {playbook.goal && <div className="text-[11px] font-semibold text-pop-ink leading-snug">{playbook.goal}</div>}
        <div className="flex items-center gap-2 rounded-lg border border-pop-bd/30 bg-pop-idle/40 px-2 py-1">
          <span className="font-mono text-[9px] text-pop-dim">预算</span>
          <b className="font-mono text-[10.5px]">{playbook.budget.steps} 步 · ~{playbook.budget.estMin}min</b>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-pop-idle">
            <div className="h-full rounded-full bg-pop-green" style={{ width: `${Math.min(100, (playbook.budget.estMin / 10) * 100)}%` }} />
          </div>
          <span className="font-mono text-[9px] text-pop-dim">{playbook.budget.over ? "超预算→已降档" : "≤10min ✓"}</span>
        </div>
        {playbook.specRevised && (
          <div className="rounded-md border border-pop-amber/40 bg-pop-amber-soft px-2 py-1 text-[10.5px] text-pop-ink/80">
            ⚠ round-report 含「Spec 修订」—— 下列预期以上轮修订后为准,核对时留意。
          </div>
        )}
        {disabledReason && (
          <div className="rounded-md border border-pop-amber/40 bg-pop-amber-soft px-2 py-1 text-[10.5px] text-pop-ink/80">{disabledReason}</div>
        )}

        {/* carryover 首段（上轮未结，最该先做） */}
        {playbook.carryover.length > 0 && (
          <div className="rounded-lg border border-pop-purple/40 bg-pop-purple-soft/50 p-2" data-testid="playbook-carryover">
            <div className="font-mono text-[9px] font-black tracking-[.08em] text-pop-purple mb-1.5">上轮未结 · 先补这些（{playbook.carryover.length}）</div>
            {playbook.carryover.map((co) => (
              <div key={co.id} className="mb-1.5 text-[11px]" data-step={co.id}>
                <div className="flex items-baseline gap-1.5">
                  <span className="font-semibold">{co.op}</span>
                  <span className="ml-auto font-mono text-[9px] text-pop-dim">{co.decision === "failed" ? "上轮✗" : "上轮⊘"} · R{co.fromRound}</span>
                </div>
                <div className="mt-0.5 rounded-r border-l-[3px] border-pop-amber bg-pop-amber-soft/60 px-2 py-0.5 text-[10.5px] text-pop-ink/75">预期 · {co.expect}{co.note ? ` · 备注：${co.note}` : ""}</div>
                <div className="mt-1 flex gap-1">
                  {(["pass", "skip", "fail"] as const).map((d) => (
                    <DecideBtn key={d} active={checks[co.id]?.decision === d} decision={d} disabled={!!disabledReason} onClick={() => decide(co.id, checks[co.id]?.decision === d ? null : d)} />
                  ))}
                </div>
                {(checks[co.id]?.decision === "fail" || checks[co.id]?.decision === "skip") && (
                  <textarea className="mt-1 w-full rounded border border-dashed border-pop-bd/40 p-1 text-[10.5px]" rows={1}
                    placeholder={checks[co.id]?.decision === "fail" ? "仍不过 —— 会再次打回并保票 reopened" : "再豁免一次，需写新原因"}
                    value={checks[co.id]?.note ?? ""} onChange={(e) => setNote(co.id, e.target.value)} data-testid={`carryover-note-${co.id}`} />
                )}
              </div>
            ))}
          </div>
        )}

        {/* 主体：按票分节 */}
        {playbook.sections.filter((s) => s.title.startsWith("上轮未结") === false || playbook.carryover.length === 0).map((sec) => (
          <div key={sec.source + sec.title} className="rounded-lg border border-pop-bd/20">
            <div className="flex items-center gap-2 border-b border-pop-bd/15 bg-pop-idle/30 px-2 py-1">
              <span className="font-mono text-[9px] font-black tracking-wide text-pop-dim">{KIND_LABEL[sec.kind] ?? sec.kind}</span>
              <span className="text-[10.5px] font-semibold text-pop-ink/80">{sec.title}</span>
              <span className="ml-auto font-mono text-[8.5px] text-pop-dim truncate max-w-[40%]" title={sec.source}>{sec.source}</span>
            </div>
            <div className="p-2 space-y-2">
              {sec.items.map((it) => (
                <StepRow key={it.id} item={it} entry={checks[it.id]} disabled={!!disabledReason} onDecide={decide} onNote={setNote} />
              ))}
            </div>
          </div>
        ))}

        {/* finePrint 折叠（票内全部 AC，勾选不在这一层） */}
        {playbook.finePrint.length > 0 && (
          <div className="rounded-lg border border-dashed border-pop-bd/30">
            <button className="flex w-full items-center gap-1.5 px-2 py-1 text-[10.5px] font-semibold text-pop-dim hover:bg-pop-idle/30" onClick={() => setOpenFine((v) => !v)} data-testid="playbook-fine-toggle">
              {openFine ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />} 票内 AC 细目（{playbook.finePrint.reduce((n, f) => n + f.acs.length, 0)} 条，仅供回溯，不在这层勾选）
            </button>
            {openFine && (
              <div className="border-t border-pop-bd/15 p-2 columns-2 gap-4 text-[10px] font-mono text-pop-dim" data-testid="playbook-fine">
                {playbook.finePrint.map((f) => f.acs.map((a, i) => <div key={f.ticket + i} className="break-inside-avoid mb-0.5">· [{f.ticket}] {a}</div>))}
              </div>
            )}
          </div>
        )}

        {saving && <div className="text-right font-mono text-[9px] text-pop-dim">保存勾选…</div>}
        <div className="font-mono text-[8.5px] text-pop-dim" data-testid="playbook-coverage">
          编译来源：{playbook.coverage.found.join(" · ") || "无"}{playbook.coverage.missing.length ? ` ｜ 缺：${playbook.coverage.missing.join(" · ")}` : ""}
        </div>
      </div>
    </div>
  )
}

// ── one walkthrough step ──────────────────────────────────────────────
function StepRow({ item, entry, disabled, onDecide, onNote }: {
  item: PlaybookItem; entry?: CheckEntry; disabled: boolean
  onDecide: (id: string, d: CheckDecision | null, note?: string) => void
  onNote: (id: string, note: string) => void
}) {
  const d = entry?.decision
  const needsNote = d === "fail" || d === "skip"
  return (
    <div className={`rounded-md border p-2 transition-colors ${d === "fail" ? "border-pop-red bg-pop-red/5" : d === "pass" ? "border-pop-green/30 bg-pop-green-soft/30" : "border-pop-bd/20 bg-pop-paper"}`} data-step={item.id} data-testid={`step-${item.id}`}>
      <div className="flex items-baseline gap-1.5">
        <span className="text-[11.5px] font-semibold text-pop-ink leading-snug">{item.op}</span>
        <span className="ml-auto shrink-0 font-mono text-[8.5px] text-pop-dim">{item.id.split(":").slice(1, 2)[0]}</span>
      </div>
      {item.probe?.command && (
        <code className="mt-1 block truncate rounded bg-pop-ink px-1.5 py-0.5 font-mono text-[10px] text-pop-bg" title={item.probe.command}>$ {item.probe.command}</code>
      )}
      <div className="mt-1 rounded-r border-l-[3px] border-pop-amber bg-pop-amber-soft/50 px-2 py-0.5 text-[10.5px] text-pop-ink/75">
        <b>预期</b> · {item.expect}{item.evidence ? <span className="text-pop-dim"> ｜ 反假跑：{item.evidence}</span> : null}
      </div>
      <div className="mt-1.5 flex gap-1">
        {(["pass", "fail", "skip"] as const).map((k) => (
          <DecideBtn key={k} active={d === k} decision={k} disabled={disabled} onClick={() => onDecide(item.id, d === k ? null : k)} />
        ))}
      </div>
      {d && <Consequence decision={d} ticketHint={item.id} />}
      {needsNote && (
        <textarea className="mt-1 w-full rounded border border-dashed border-pop-bd/40 p-1 text-[10.5px]" rows={1}
          placeholder={d === "fail" ? "不过的实际现象（必填）— 进打回反馈 + 重开此票" : "为什么这次可以不验（必填）— 下轮仍会问"}
          value={entry?.note ?? ""} onChange={(e) => onNote(item.id, e.target.value)} data-testid={`note-${item.id}`} />
      )}
    </div>
  )
}

function DecideBtn({ active, decision, disabled, onClick }: { active: boolean; decision: CheckDecision; disabled: boolean; onClick: () => void }) {
  const map = {
    pass: { t: "✓ 通过", on: "bg-pop-green text-white border-pop-green" },
    fail: { t: "✗ 不过", on: "bg-pop-red text-white border-pop-red" },
    skip: { t: "⊘ 跳过", on: "bg-pop-dim text-white border-pop-dim" },
  }[decision]
  return (
    <button disabled={disabled} onClick={onClick}
      className={`rounded-md border px-2 py-0.5 text-[10px] font-bold transition-colors ${active ? map.on : "border-pop-bd/30 bg-pop-idle/40 text-pop-dim hover:bg-pop-idle"} disabled:opacity-40`}
      data-testid={`decide-${decision}`}>{map.t}</button>
  )
}

function Consequence({ decision, ticketHint }: { decision: CheckDecision; ticketHint: string }) {
  const base = "mt-1.5 rounded-r border-l-[3px] px-2 py-0.5 text-[10px]"
  if (decision === "pass") return <div className={`${base} border-pop-green text-pop-green`}>→ 销账：后续轮次不再出现 · 写入台账 ✓ 节</div>
  if (decision === "fail") return <div className={`${base} border-pop-red text-pop-red`}>→ 硬闸：通过被拦 · 打回预填 · <b>票 {ticketHint.split(":")[1]} 将 reopened</b></div>
  return <div className={`${base} border-pop-amber text-pop-amber`}>→ 下轮 carryover 首段：补验或再豁免 · 最终轮未决 → 交付披露</div>
}

// ── helpers ───────────────────────────────────────────────────────────
function countOf(checks: Record<string, CheckEntry>, d: CheckDecision): number {
  return Object.values(checks).filter((c) => c.decision === d).length
}
function summarize(playbook: PlaybookPayload, checks: Record<string, CheckEntry>) {
  const total = playbook.sections.flatMap((s) => s.items).length
  const pass = countOf(checks, "pass"), fail = countOf(checks, "fail"), skip = countOf(checks, "skip")
  // fail 项 → 票名基（id = walk|probe|claim:<base>:<n>；plan/spec 兜底非真票，滤掉）。
  const failTickets = Array.from(new Set(
    Object.entries(checks).filter(([, c]) => c.decision === "fail")
      .map(([id]) => /^(?:walk|probe|claim):([^:]+):\d+$/.exec(id)?.[1])
      .filter((t): t is string => !!t && t !== "plan" && t !== "spec"),
  ))
  return { pass, fail, skip, undecided: Math.max(0, total - pass - fail - skip), total, failTickets }
}
