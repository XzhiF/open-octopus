// packages/web-app/components/tasks/acceptance/acceptance-plan-panel.tsx
//
// 验收方案面板（2026-10-30 AI-native 验收 · 原型 A「证据随行」）：
//
//   ┌ 左：核对清单（第 x 项 · 标题 · 通过标准摘要 · 证据件数 · 机器建议）
//   └ 右：选中项的证据台 ——
//        标题 / 用户故事 / 「这条要求什么」/「怎么验」（逐步就地跑或打开文件）/
//        运行结果终端 / 「证据」行（可打开批次文件）/ 核对点 / 底部结论条
//
// 数据来自 GET /:id/playbook（plan ready 时 server 用 acceptance-plan-rN.json
// 映射而来）。判定写入走 POST /:id/acceptance/check 单条写入口 —— 与主 Chat
// 引导共用一份盘上真相；TASK_ACCEPTANCE_CHECK_EVENT 到达即重读，双向同步。
//
// 纪律：机器只建议，人逐项确认；✕/⊘ 必须写原因；绝不批量代勾。

"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Check, FileText, Play, X } from "lucide-react"
import { toast } from "sonner"
import { TASK_ACCEPTANCE_CHECK_EVENT, TASK_ACCEPTANCE_PLAN_EVENT } from "@octopus/shared"
import {
  readChecks,
  recordAcceptanceCheck,
  regenerateAcceptancePlan,
  runProbe,
  type CheckDecision,
  type CheckEntry,
  type PlanEvidenceRef,
  type PlanHowTo,
  type PlaybookItem,
  type PlaybookPayload,
  type ProbeRunResult,
} from "@/lib/tasks-api"
import { subscribeSSE } from "@/lib/sse-manager"
import { getServerUrl } from "@/lib/server-config"

export interface PlanGate {
  pass: number
  fail: number
  skip: number
  undecided: number
  total: number
  failTickets: string[]
}

interface AcceptancePlanPanelProps {
  taskId: string
  batchRelDir: string | null
  roundIndex: number
  playbook: PlaybookPayload
  /** 主 Chat 是否正在引导（窗口横幅用）。 */
  guideActive?: boolean
  onGate: (g: PlanGate) => void
  disabledReason?: string
  /** 方案状态变化（generating→ready / failed）→ 父级重拉 playbook。 */
  onPlanEvent?: () => void
  /** 决策前竞态闸：单条写是即时的，这里恒为已完成。 */
  registerFlush?: (fn: (() => Promise<void>) | null) => void
  onSaveStateChange?: (saving: boolean) => void
  /** 打开 home 内的批次文件（.scratch/**）——证据行/步骤里的「打开文件」。 */
  onOpenFile?: (homeRelPath: string) => void
}

const VERDICT: Record<string, { label: string; cls: string; short: string }> = {
  pass: { label: "机器建议通过", short: "有证据", cls: "pass" },
  warn: { label: "机器建议先跑/留意", short: "建议先跑", cls: "warn" },
  human: { label: "需人工判断", short: "需你判断", cls: "human" },
}

const EVIDENCE_ICON: Record<string, string> = {
  diff: "±", test: "▷", report: "¶", docs: "•", preview: "▶",
}

/** home 内可打开的路径（.scratch/**）；绝对工作区路径只展示不开。 */
function isHomeRel(p?: string): boolean {
  return !!p && p.replace(/\\/g, "/").startsWith(".scratch/")
}

export function AcceptancePlanPanel({
  taskId, batchRelDir, roundIndex, playbook, guideActive, onGate, disabledReason,
  onPlanEvent, registerFlush, onSaveStateChange, onOpenFile,
}: AcceptancePlanPanelProps) {
  const items = useMemo(() => playbook.sections.flatMap((s) => s.items), [playbook])
  const [checks, setChecks] = useState<Record<string, CheckEntry>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [runningProbe, setRunningProbe] = useState<string | null>(null)
  const [probeNow, setProbeNow] = useState<Record<string, ProbeRunResult>>({})
  const checksRef = useRef<Record<string, CheckEntry>>({})
  const dirtyRef = useRef(false)

  const summarize = useCallback((next: Record<string, CheckEntry>): PlanGate => {
    let pass = 0, fail = 0, skip = 0
    const failTickets = new Set<string>()
    for (const it of items) {
      const d = next[it.id]?.decision
      if (d === "pass") pass++
      else if (d === "fail") { fail++; if (it.ticket && it.ticket !== "spec") failTickets.add(it.ticket) }
      else if (d === "skip") skip++
    }
    return {
      pass, fail, skip,
      undecided: Math.max(0, items.length - pass - fail - skip),
      total: items.length,
      failTickets: [...failTickets],
    }
  }, [items])

  const applyChecks = useCallback((next: Record<string, CheckEntry>) => {
    checksRef.current = next
    setChecks(next)
    onGate(summarize(next))
  }, [onGate, summarize])

  // 挂载 / 换轮 / 方案变化：读盘上真相。
  useEffect(() => {
    let cancelled = false
    dirtyRef.current = false
    setProbeNow({})
    if (!batchRelDir) { applyChecks({}); return }
    void readChecks(taskId, batchRelDir, roundIndex).then((f) => {
      if (cancelled || dirtyRef.current) return
      applyChecks(f.checks ?? {})
    })
    return () => { cancelled = true }
  }, [taskId, batchRelDir, roundIndex, playbook.plan?.generated_at, applyChecks])

  // 主 Chat 写入 → 重读；方案状态变化 → 通知父级重拉。
  useEffect(() => {
    if (!taskId) return
    const url = `${getServerUrl()}/api/tasks/events`
    const mine = (e: MessageEvent): boolean => {
      try { return (JSON.parse(e.data) as { task_id?: string }).task_id === taskId } catch { return false }
    }
    const unCheck = subscribeSSE(url, TASK_ACCEPTANCE_CHECK_EVENT, (e) => {
      if (!mine(e) || !batchRelDir) return
      void readChecks(taskId, batchRelDir, roundIndex).then((f) => applyChecks(f.checks ?? {}))
    })
    const unPlan = subscribeSSE(url, TASK_ACCEPTANCE_PLAN_EVENT, (e) => {
      if (!mine(e)) return
      onPlanEvent?.()
    })
    return () => { unCheck(); unPlan() }
  }, [taskId, batchRelDir, roundIndex, applyChecks, onPlanEvent])

  useEffect(() => {
    registerFlush?.(async () => { /* 单条写 = 即时落盘，无 debounce 需要 flush */ })
    return () => registerFlush?.(null)
  }, [registerFlush])

  // 默认选中：第一项未决；全决则第一项。
  useEffect(() => {
    if (selectedId && items.some((it) => it.id === selectedId)) return
    const firstUndecided = items.find((it) => !checks[it.id])
    setSelectedId((firstUndecided ?? items[0])?.id ?? null)
  }, [items, checks, selectedId])

  const selected = items.find((it) => it.id === selectedId) ?? null
  const selectedIndex = selected ? items.findIndex((it) => it.id === selected.id) : -1

  const decide = useCallback(async (item: PlaybookItem, decision: CheckDecision, note?: string) => {
    if (disabledReason || busyId) return
    if (decision !== "pass" && !(note ?? "").trim()) return
    setBusyId(item.id)
    onSaveStateChange?.(true)
    dirtyRef.current = true
    try {
      const res = await recordAcceptanceCheck(taskId, { item_id: item.id, decision, note: note?.trim() })
      applyChecks(res.checks.checks ?? {})
      const next = items.find((it) => it.id !== item.id && !(res.checks.checks ?? {})[it.id])
      if (next) setSelectedId(next.id)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "核对写入失败")
    } finally {
      setBusyId(null)
      onSaveStateChange?.(false)
    }
  }, [taskId, items, disabledReason, busyId, applyChecks, onSaveStateChange])

  const run = useCallback(async (item: PlaybookItem) => {
    const cmd = item.machine?.command?.trim()
      || item.howTo?.find((h) => h.kind === "run" && h.command?.trim())?.command?.trim()
    if (!cmd || runningProbe || disabledReason) return
    setRunningProbe(item.id)
    try {
      const r = await runProbe(taskId, cmd, 300)
      setProbeNow((m) => ({ ...m, [item.id]: r }))
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "机器证据执行失败")
    } finally {
      setRunningProbe(null)
    }
  }, [taskId, runningProbe, disabledReason])

  if (!items.length) {
    return <div className="ap-empty">方案里没有可核对的项 —— 可直接通过或退回修改。</div>
  }

  const plan = playbook.plan
  const gate = summarize(checks)
  const decided = gate.pass + gate.fail + gate.skip

  return (
    <div className="ap-plan" data-testid="acceptance-plan-panel" data-plan-status={plan?.status ?? "missing"}>
      <div className="ap-plan-grid">
        {/* ── 左：核对清单 ── */}
        <section className="ap-card ap-plan-list-card">
          <div className="ap-card-head">
            <span className="ap-card-title">核对 · 验收项</span>
            <span className="ap-card-count">
              <b>{gate.pass}</b>/{gate.total}✓
              {gate.skip > 0 && <> · ⊘{gate.skip}</>}
              {gate.fail > 0 && <> · <span className="bad">✕{gate.fail}</span></>}
            </span>
          </div>
          <div className="ap-plan-list">
            {items.map((it, i) => {
              const d = checks[it.id]?.decision
              const mv = it.machine ? VERDICT[it.machine.verdict] ?? VERDICT.human : null
              const evCount = it.evidenceRefs?.length ?? 0
              return (
                <button
                  key={it.id}
                  type="button"
                  className="ap-plan-item"
                  data-active={it.id === selectedId}
                  data-state={d ?? ""}
                  onClick={() => setSelectedId(it.id)}
                  data-testid={`plan-item-${it.id}`}
                >
                  <span className="ap-plan-idx">{d === "pass" ? "✓" : d === "fail" ? "✕" : d === "skip" ? "⊘" : ""}</span>
                  <span className="ap-plan-item-text">
                    <b>{it.title ?? it.op}</b>
                    <small>{it.expect}</small>
                    <span className="ap-plan-badges">
                      {evCount > 0 && <span className="tag">{evCount} 件证据</span>}
                      {mv && <span className={`tag ${mv.cls}`}>{mv.short}</span>}
                      {it.ticket && <span className="tag quiet">{it.ticket}</span>}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
          <div className="ap-plan-list-foot">
            点任一条在右边看证据与验法 · 已完成 {decided}/{gate.total}
            {guideActive && (
              <button
                type="button"
                className="ap-block-link"
                onClick={() => window.dispatchEvent(new Event("octopus:focus-desktop"))}
                data-testid="plan-guide-chip"
                title="回到主对话，让 Agent 带你逐项走"
              >
                主对话引导中 →
              </button>
            )}
          </div>
        </section>

        {/* ── 右：证据台 ── */}
        <section className="ap-card ap-plan-work" data-testid="plan-detail">
          {selected && (
            <>
              <div className="ap-plan-work-head">
                <span className="ap-eyebrow">第 {selectedIndex + 1} 项 / 共 {items.length} 项</span>
                {selected.machine && (
                  <span className={`ap-plan-verdict ${VERDICT[selected.machine.verdict]?.cls ?? "human"}`} title={selected.machine.why}>
                    机器 · {VERDICT[selected.machine.verdict]?.short ?? "需你判断"}
                  </span>
                )}
                <span className="ap-spacer" />
                {selected.ticket && <span className="ap-plan-ticket">{selected.ticket} 交付</span>}
              </div>

              <div className="ap-plan-work-body">
                <h2 className="ap-plan-title">{selected.title ?? selected.op}</h2>
                {selected.story && <p className="ap-plan-lead">{selected.story}</p>}

                <div className="ap-plan-sect-t">这条要求什么</div>
                <blockquote className="ap-plan-quote">{selected.expect}</blockquote>

                <div className="ap-plan-sect-t">怎么验 <span className="aside">每步都能就地做</span></div>
                <ol className="ap-plan-steps">
                  {(selected.howTo ?? []).map((h, i) => (
                    <StepRow
                      key={i}
                      index={i}
                      step={h}
                      disabled={!!disabledReason}
                      running={runningProbe === selected.id}
                      ranAlready={!!probeNow[selected.id]}
                      onRun={() => void run(selected)}
                      onOpen={onOpenFile}
                    />
                  ))}
                </ol>

                {probeNow[selected.id] && <ProbeTerminal result={probeNow[selected.id]} command={probeCommand(selected)} />}

                <div className="ap-plan-sect-t">
                  证据 <span className="aside">{selected.evidenceRefs?.length ?? 0} 件 · 均可点开</span>
                </div>
                <div className="ap-plan-ev-list">
                  {(selected.evidenceRefs ?? []).map((e, i) => (
                    <EvidenceRow key={i} ev={e} onOpen={onOpenFile} />
                  ))}
                  {!(selected.evidenceRefs ?? []).length && (
                    <div className="ap-empty">这一项没有登记证据 —— 按上面的「怎么验」走一遍，再下结论。</div>
                  )}
                </div>

                {(selected.criteria ?? []).length > 0 && (
                  <>
                    <div className="ap-plan-sect-t">核对点</div>
                    <ul className="ap-plan-criteria">
                      {(selected.criteria ?? []).map((c, i) => <li key={i}>{c}</li>)}
                    </ul>
                  </>
                )}

                {selected.machine && (
                  <div className={`ap-plan-machine ${VERDICT[selected.machine.verdict]?.cls ?? "human"}`} data-testid="plan-machine">
                    <span className="ap-plan-machine-tag">{VERDICT[selected.machine.verdict]?.label ?? "机器建议"}</span>
                    <span>{selected.machine.why}</span>
                    {probeCommand(selected) && (
                      <button
                        type="button"
                        className="ap-btn ap-btn-sm ap-btn-ghost"
                        disabled={!!disabledReason || runningProbe === selected.id}
                        onClick={() => void run(selected)}
                        data-testid="plan-run-probe"
                      >
                        {runningProbe === selected.id ? "⏳ 跑…" : <><Play className="size-2.5" /> 跑一下</>}
                      </button>
                    )}
                  </div>
                )}
              </div>

              <VerdictBar
                entry={checks[selected.id]}
                disabled={!!disabledReason || busyId === selected.id}
                undecided={gate.undecided}
                total={gate.total}
                onDecide={(d, note) => void decide(selected, d, note)}
              />
            </>
          )}
        </section>
      </div>

      {(playbook.planWarnings ?? []).length > 0 && (
        <div className="ap-coverage mt-2" data-testid="plan-warnings">
          方案提示：{playbook.planWarnings!.join(" · ")}
        </div>
      )}
      {plan?.status === "failed" && (
        <div className="ap-check-note warn mt-2" data-testid="plan-failed">
          <span className="q">!</span>
          <span>
            验收方案生成失败{plan.error ? `（${plan.error}）` : ""} —— 已回退旧清单，验收不受影响。
            <button
              type="button"
              className="ap-block-link"
              data-testid="plan-regenerate"
              onClick={() => {
                void regenerateAcceptancePlan(taskId)
                  .then((r) => {
                    if (!r.ok) toast.error(`重生成被拒：${r.reason ?? "未知原因"}`)
                    else { toast.success("已重新发起方案生成"); onPlanEvent?.() }
                  })
                  .catch((err: unknown) => toast.error(err instanceof Error ? err.message : "重生成失败"))
              }}
            >
              ↻ 重新生成
            </button>
          </span>
        </div>
      )}
    </div>
  )
}

function probeCommand(item: PlaybookItem): string | null {
  return item.machine?.command?.trim()
    || item.howTo?.find((h) => h.kind === "run" && h.command?.trim())?.command?.trim()
    || null
}

function StepRow({
  index, step, disabled, running, ranAlready, onRun, onOpen,
}: {
  index: number
  step: PlanHowTo
  disabled: boolean
  running: boolean
  ranAlready: boolean
  onRun: () => void
  onOpen?: (p: string) => void
}) {
  const canOpen = isHomeRel(step.path) && !!onOpen
  return (
    <li className="ap-plan-step">
      <span className="ap-plan-step-n">{index + 1}</span>
      <span className="ap-plan-step-main">
        <b>{step.text}</b>
        {(step.command || step.path) && (
          <code className="ap-command" title={step.command ?? step.path}>{step.command ?? step.path}</code>
        )}
        {step.expect && <small>预期：{step.expect}</small>}
      </span>
      <span className="ap-plan-step-act">
        {step.kind === "run" && step.command ? (
          <button type="button" className="ap-btn ap-btn-sm ap-btn-primary" disabled={disabled || running} onClick={onRun}>
            {running ? "⏳ 运行中" : ranAlready ? "✓ 再跑" : <><Play className="size-2.5" /> 运行</>}
          </button>
        ) : canOpen ? (
          <button type="button" className="ap-btn ap-btn-sm ap-btn-ghost" onClick={() => onOpen!(step.path!)}>
            打开文件
          </button>
        ) : null}
      </span>
    </li>
  )
}

function EvidenceRow({ ev, onOpen }: { ev: PlanEvidenceRef; onOpen?: (p: string) => void }) {
  const canOpen = isHomeRel(ev.path) && !!onOpen
  return (
    <div className={`ap-plan-ev ${ev.missing ? "missing" : ""}`} data-testid="plan-evidence">
      <span className={`ap-plan-ev-ico ${ev.kind}`}>{EVIDENCE_ICON[ev.kind] ?? "•"}</span>
      <span className="ap-plan-ev-main">
        <b>{ev.label}</b>
        <small>{ev.detail ?? ev.path ?? (ev.missing ? "缺证据（不编）" : "")}</small>
      </span>
      {ev.missing ? (
        <span className="ap-chip bad">缺证据</span>
      ) : canOpen ? (
        <button type="button" className="ap-btn ap-btn-sm ap-btn-ghost" onClick={() => onOpen!(ev.path!)}>
          <FileText className="size-2.5" /> 打开文件
        </button>
      ) : null}
    </div>
  )
}

function ProbeTerminal({ result, command }: { result: ProbeRunResult; command: string | null }) {
  return (
    <div className={`ap-plan-term ${result.state === "passed" ? "pass" : "fail"}`} data-testid="plan-probe-result">
      <div className="ap-plan-term-head">
        {result.state === "passed" ? <Check className="size-3" /> : <X className="size-3" />}
        运行结果 · {result.state === "passed" ? "exit 0" : result.state === "timeout" ? "超时" : `exit ${result.exit_code ?? "?"}`}
        <span> · {Math.round(result.duration_ms / 100) / 10}s</span>
        <span className="ap-plan-term-hint">机器只建议，结论由你定</span>
      </div>
      {command && <div className="ap-plan-term-cmd">$ {command}</div>}
      {result.tail.length > 0 && <pre className="ap-plan-term-tail">{result.tail.slice(-18).join("\n")}</pre>}
    </div>
  )
}

function VerdictBar({
  entry, disabled, undecided, total, onDecide,
}: {
  entry?: CheckEntry
  disabled: boolean
  undecided: number
  total: number
  onDecide: (d: CheckDecision, note?: string) => void
}) {
  const [pending, setPending] = useState<"fail" | "skip" | null>(null)
  const [note, setNote] = useState(entry?.note ?? "")
  const d = entry?.decision

  useEffect(() => {
    setPending(null)
    setNote(entry?.note ?? "")
  }, [entry?.decision, entry?.note, entry?.at])

  const hint = d === "fail"
    ? "会写进退回反馈，并重开对应票"
    : d === "skip"
      ? "会进入下一轮 carryover，最终轮未决要披露"
      : d === "pass"
        ? "记入验收记录 ✓ 节"
        : `未判 — 全部 ${total} 项有结论（或明确跳过）才能通过${undecided > 0 ? `（还差 ${undecided} 项）` : ""}`

  return (
    <div className="ap-plan-verdict-bar" data-testid="plan-decide">
      <span className="ap-plan-verdict-label">你的结论</span>
      <button
        type="button" className="ap-plan-vbtn pass" data-on={d === "pass"}
        disabled={disabled} onClick={() => onDecide("pass", entry?.note)} data-testid="plan-pass"
      >
        <Check className="size-3" /> 通过
      </button>
      <button
        type="button" className="ap-plan-vbtn fail" data-on={d === "fail"}
        disabled={disabled} onClick={() => setPending(pending === "fail" ? null : "fail")} data-testid="plan-fail"
      >
        <X className="size-3" /> 不通过
      </button>
      <button
        type="button" className="ap-plan-vbtn skip" data-on={d === "skip"}
        disabled={disabled} onClick={() => setPending(pending === "skip" ? null : "skip")} data-testid="plan-skip"
      >
        ⊘ 跳过
      </button>
      <span className="ap-plan-verdict-hint">{hint}</span>

      {pending && (
        <div className="ap-plan-note">
          <textarea
            className="ap-note-input" rows={2} autoFocus
            placeholder={pending === "fail" ? "哪里不对（必填）—— 会进退回反馈，并重开对应票" : "为什么这次可以不验（必填）—— 下轮仍会问"}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            data-testid="plan-note"
          />
          <button
            type="button" className="ap-btn ap-btn-sm ap-btn-coral"
            disabled={disabled || !note.trim()}
            onClick={() => { onDecide(pending, note); setPending(null) }}
            data-testid="plan-note-confirm"
          >
            确认{pending === "fail" ? "不通过" : "跳过"}
          </button>
        </div>
      )}
    </div>
  )
}
