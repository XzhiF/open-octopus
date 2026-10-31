"use client"

// 验收方案面板（2026-10-30 AI-native 验收；2026-10-31 两层化）：
//
//   ┌ 左：两层清单
//   │   · 你要验的（cases，1–3 条场景）—— 可判定，逐条给结论
//   │   · 本轮验证了什么（checks，机器证据）—— 只读，不要求逐项签
//   └ 右：选中项详情
//        场景：故事 / 起点 / 通过标准 / 步骤（打开 → 操作 → 看什么）/ 证据 / 结论
//        证据：覆盖的 AC / 证据件 / 按需复核命令（只按用户点名重跑）
//
// 数据来自 GET /:id/playbook（plan ready 时 server 用 acceptance-plan-rN.json
// 映射而来）。判定写入走 POST /:id/acceptance/check 单条写入口 —— 与主 Chat
// 引导共用一份盘上真相；TASK_ACCEPTANCE_CHECK_EVENT 到达即重读，双向同步。
//
// 纪律：人只签场景；机器证据只读。✕/⊘ 必须写原因；绝不批量代勾。

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Check, FileText, Play, X } from "lucide-react"
import { toast } from "sonner"
import { TASK_ACCEPTANCE_CHECK_EVENT, TASK_ACCEPTANCE_PLAN_EVENT } from "@octopus/shared"
import {
  readChecks,
  recordAcceptanceCheck,
  runProbe,
  type CheckDecision,
  type CheckEntry,
  type PlanEvidenceRef,
  type PlanStep,
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

const EVIDENCE_ICON: Record<string, string> = {
  diff: "±", test: "▷", report: "¶", docs: "•", preview: "▶",
}

const STEP_LABEL: Record<PlanStep["kind"], string> = {
  open: "打开",
  do: "操作",
  observe: "看",
}

type ProbeNow = { result: ProbeRunResult; command: string }

/** home 内可打开的路径（.scratch/**）；绝对工作区路径只展示不开。 */
function isHomeRel(p?: string): boolean {
  return !!p && p.replace(/\\/g, "/").startsWith(".scratch/")
}

function isHttpUrl(p?: string): boolean {
  return !!p && /^https?:\/\//i.test(p)
}

export function AcceptancePlanPanel({
  taskId, batchRelDir, roundIndex, playbook, guideActive, onGate, disabledReason,
  onPlanEvent, registerFlush, onSaveStateChange, onOpenFile,
}: AcceptancePlanPanelProps) {
  const items = useMemo(() => playbook.sections.flatMap((s) => s.items), [playbook])
  /** 人验收场景（可判定）。缺 tier（历史 payload）时按场景处理。 */
  const cases = useMemo(() => items.filter((it) => it.tier !== "check"), [items])
  /** 机器证据（只读）。 */
  const evidence = useMemo(() => items.filter((it) => it.tier === "check"), [items])

  const [checks, setChecks] = useState<Record<string, CheckEntry>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [runningProbe, setRunningProbe] = useState<string | null>(null)
  const [probeNow, setProbeNow] = useState<Record<string, ProbeNow>>({})
  const checksRef = useRef<Record<string, CheckEntry>>({})
  const dirtyRef = useRef(false)

  const summarize = useCallback((next: Record<string, CheckEntry>): PlanGate => {
    let pass = 0, fail = 0, skip = 0
    const failTickets = new Set<string>()
    for (const it of cases) {
      const d = next[it.id]?.decision
      if (d === "pass") pass++
      else if (d === "fail") {
        fail++
        const tickets = it.tickets?.length ? it.tickets : it.ticket ? [it.ticket] : []
        for (const t of tickets) if (t !== "spec") failTickets.add(t)
      } else if (d === "skip") skip++
    }
    return {
      pass, fail, skip,
      undecided: Math.max(0, cases.length - pass - fail - skip),
      total: cases.length,
      failTickets: [...failTickets],
    }
  }, [cases])

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

  // 默认选中：第一条未决场景；全决则第一条场景；没有场景再看第一条证据。
  useEffect(() => {
    if (selectedId && items.some((it) => it.id === selectedId)) return
    const firstUndecided = cases.find((it) => !checks[it.id])
    setSelectedId((firstUndecided ?? cases[0] ?? evidence[0])?.id ?? null)
  }, [items, cases, evidence, checks, selectedId])

  const selected = items.find((it) => it.id === selectedId) ?? null
  const selectedIsCase = !!selected && selected.tier !== "check"
  const caseIndex = selectedIsCase ? cases.findIndex((it) => it.id === selected!.id) : -1
  const evidenceIndex = selected && !selectedIsCase ? evidence.findIndex((it) => it.id === selected.id) : -1

  const decide = useCallback(async (item: PlaybookItem, decision: CheckDecision, note?: string) => {
    if (disabledReason || busyId) return
    if (item.tier === "check") return
    if (decision !== "pass" && !(note ?? "").trim()) return
    setBusyId(item.id)
    onSaveStateChange?.(true)
    dirtyRef.current = true
    try {
      const res = await recordAcceptanceCheck(taskId, { item_id: item.id, decision, note: note?.trim() })
      applyChecks(res.checks.checks ?? {})
      const next = cases.find((it) => it.id !== item.id && !(res.checks.checks ?? {})[it.id])
      if (next) setSelectedId(next.id)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "核对写入失败")
    } finally {
      setBusyId(null)
      onSaveStateChange?.(false)
    }
  }, [taskId, cases, disabledReason, busyId, applyChecks, onSaveStateChange])

  const run = useCallback(async (item: PlaybookItem, command?: string) => {
    const cmd = (command ?? probeCommand(item) ?? "").trim()
    if (!cmd || runningProbe || disabledReason) return
    setRunningProbe(item.id)
    try {
      const r = await runProbe(taskId, cmd, 300)
      setProbeNow((m) => ({ ...m, [item.id]: { result: r, command: cmd } }))
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
        {/* ── 左：两层清单 ── */}
        <section className="ap-card ap-plan-list-card">
          <div className="ap-card-head">
            <span className="ap-card-title">验收 · 场景</span>
            <span className="ap-card-count">
              <b>{gate.pass}</b>/{gate.total}✓
              {gate.skip > 0 && <> · ⊘{gate.skip}</>}
              {gate.fail > 0 && <> · <span className="bad">✕{gate.fail}</span></>}
              {evidence.length > 0 && <span className="quiet"> · 证据 {evidence.length}</span>}
            </span>
          </div>
          <div className="ap-plan-list">
            <div className="ap-plan-group" data-testid="plan-group-cases">
              你要验的 <span className="n">{cases.length}</span>
              <span className="hint">场景 · 逐条判定</span>
            </div>
            {cases.map((it) => {
              const d = checks[it.id]?.decision
              const evCount = it.evidenceRefs?.length ?? 0
              const steps = it.steps?.length ?? it.howTo?.length ?? 0
              return (
                <button
                  key={it.id}
                  type="button"
                  className="ap-plan-item"
                  data-tier="case"
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
                      {steps > 0 && <span className="tag">{steps} 步</span>}
                      {evCount > 0 && <span className="tag">{evCount} 件证据</span>}
                      {it.tickets?.length ? <span className="tag quiet">{it.tickets.join(" · ")}</span>
                        : it.ticket ? <span className="tag quiet">{it.ticket}</span> : null}
                    </span>
                  </span>
                </button>
              )
            })}

            {evidence.length > 0 && (
              <>
                <div className="ap-plan-group" data-testid="plan-group-evidence">
                  本轮验证了什么 <span className="n">{evidence.length}</span>
                  <span className="hint">机器证据 · 只读</span>
                </div>
                {evidence.map((it) => {
                  const refs = it.evidenceRefs ?? []
                  const missing = refs.filter((e) => e.missing).length
                  return (
                    <button
                      key={it.id}
                      type="button"
                      className="ap-plan-item"
                      data-tier="check"
                      data-active={it.id === selectedId}
                      onClick={() => setSelectedId(it.id)}
                      data-testid={`plan-item-${it.id}`}
                    >
                      <span className="ap-plan-idx">▣</span>
                      <span className="ap-plan-item-text">
                        <b>{it.title ?? it.op}</b>
                        <small>{it.evidence ?? it.expect}</small>
                        <span className="ap-plan-badges">
                          <span className={`tag ${missing ? "a" : "quiet"}`}>
                            {missing ? `缺 ${missing} 件证据` : `${refs.length} 件证据`}
                          </span>
                          {it.tickets?.length ? <span className="tag quiet">{it.tickets.join(" · ")}</span> : null}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </>
            )}
          </div>
          <div className="ap-plan-list-foot">
            人只验场景 · 已判定 {decided}/{gate.total}
            {guideActive && (
              <button
                type="button"
                className="ap-block-link"
                onClick={() => window.dispatchEvent(new Event("octopus:focus-desktop"))}
                data-testid="plan-guide-chip"
                title="回到主对话，让 Agent 带你逐条走场景"
              >
                主对话引导中 →
              </button>
            )}
          </div>
        </section>

        {/* ── 右：详情台 ── */}
        <section className="ap-card ap-plan-work" data-testid="plan-detail">
          {selected && (selectedIsCase ? (
            <CaseDetail
              item={selected}
              caseIndex={caseIndex}
              caseTotal={cases.length}
              entry={checks[selected.id]}
              probe={probeNow[selected.id]}
              running={runningProbe === selected.id}
              disabledReason={disabledReason}
              busy={busyId === selected.id}
              undecided={gate.undecided}
              onRun={(cmd) => void run(selected, cmd)}
              onOpenFile={onOpenFile}
              onDecide={(d, note) => void decide(selected, d, note)}
            />
          ) : (
            <EvidenceDetail
              item={selected}
              evidenceIndex={evidenceIndex}
              evidenceTotal={evidence.length}
              probe={probeNow[selected.id]}
              running={runningProbe === selected.id}
              disabledReason={disabledReason}
              onRun={() => void run(selected)}
              onOpenFile={onOpenFile}
            />
          ))}
        </section>
      </div>

      {(playbook.planWarnings ?? []).length > 0 && (
        <div className="ap-coverage mt-2" data-testid="plan-warnings">
          方案提示：{playbook.planWarnings!.join(" · ")}
        </div>
      )}
    </div>
  )
}

// ── 场景详情 ─────────────────────────────────────────────────────────

function CaseDetail({
  item, caseIndex, caseTotal, entry, probe, running, disabledReason, busy, undecided,
  onRun, onOpenFile, onDecide,
}: {
  item: PlaybookItem
  caseIndex: number
  caseTotal: number
  entry?: CheckEntry
  probe?: ProbeNow
  running: boolean
  disabledReason?: string
  busy: boolean
  undecided: number
  onRun: (command?: string) => void
  onOpenFile?: (p: string) => void
  onDecide: (d: CheckDecision, note?: string) => void
}) {
  const steps = item.steps ?? []
  return (
    <>
      <div className="ap-plan-work-head">
        <span className="ap-eyebrow">场景 {caseIndex + 1} / {caseTotal}</span>
        <span className="ap-plan-verdict human">人验收</span>
        <span className="ap-spacer" />
        {item.tickets?.length ? <span className="ap-plan-ticket">{item.tickets.join(" · ")} 交付</span> : null}
      </div>

      <div className="ap-plan-work-body">
        <h2 className="ap-plan-title">{item.title ?? item.op}</h2>
        {item.story && <p className="ap-plan-lead">{item.story}</p>}

        <div className="ap-plan-sect-t">这条要求什么</div>
        <blockquote className="ap-plan-quote">{item.expect}</blockquote>

        {item.setup && (
          <>
            <div className="ap-plan-sect-t">起点</div>
            <p className="ap-plan-lead">{item.setup}</p>
          </>
        )}

        <div className="ap-plan-sect-t">怎么验 <span className="aside">按顺序做一遍</span></div>
        {steps.length > 0 ? (
          <ol className="ap-plan-steps">
            {steps.map((step, i) => (
              <StepRow
                key={i}
                index={i}
                step={step}
                disabled={!!disabledReason}
                running={running}
                ranAlready={!!probe}
                onRun={onRun}
                onOpen={onOpenFile}
              />
            ))}
          </ol>
        ) : (
          <ol className="ap-plan-steps">
            {(item.howTo ?? []).map((h, i) => (
              <li key={i} className="ap-plan-step">
                <span className="ap-plan-step-n">{i + 1}</span>
                <span className="ap-plan-step-main">
                  <b>{h.text}</b>
                  {(h.command || h.path) && (
                    <code className="ap-command" title={h.command ?? h.path}>{h.command ?? h.path}</code>
                  )}
                  {h.expect && <small>预期：{h.expect}</small>}
                </span>
                <span className="ap-plan-step-act" />
              </li>
            ))}
          </ol>
        )}

        {probe && <ProbeTerminal result={probe.result} command={probe.command} />}

        <div className="ap-plan-sect-t">
          证据 <span className="aside">{item.evidenceRefs?.length ?? 0} 件 · 均可点开</span>
        </div>
        <div className="ap-plan-ev-list">
          {(item.evidenceRefs ?? []).map((e, i) => (
            <EvidenceRow key={i} ev={e} onOpen={onOpenFile} />
          ))}
          {!(item.evidenceRefs ?? []).length && (
            <div className="ap-empty">这一条没有登记证据 —— 按上面的步骤走一遍再下结论。</div>
          )}
        </div>
      </div>

      <VerdictBar
        entry={entry}
        disabled={!!disabledReason || busy}
        undecided={undecided}
        total={caseTotal}
        onDecide={onDecide}
      />
    </>
  )
}

// ── 机器证据详情（只读） ─────────────────────────────────────────────

function EvidenceDetail({
  item, evidenceIndex, evidenceTotal, probe, running, disabledReason, onRun, onOpenFile,
}: {
  item: PlaybookItem
  evidenceIndex: number
  evidenceTotal: number
  probe?: ProbeNow
  running: boolean
  disabledReason?: string
  onRun: () => void
  onOpenFile?: (p: string) => void
}) {
  const cmd = probeCommand(item)
  return (
    <>
      <div className="ap-plan-work-head">
        <span className="ap-eyebrow">机器证据 {evidenceIndex + 1} / {evidenceTotal}</span>
        <span className="ap-plan-verdict pass">只读</span>
        <span className="ap-spacer" />
        {item.tickets?.length ? <span className="ap-plan-ticket">{item.tickets.join(" · ")}</span> : null}
      </div>

      <div className="ap-plan-work-body">
        <h2 className="ap-plan-title">{item.title ?? item.op}</h2>
        <p className="ap-plan-lead">这是本轮已经记录过的验证，不需要你逐项确认；需要新结果时可以点名重跑。</p>

        <div className="ap-plan-sect-t">覆盖</div>
        {(item.criteria ?? []).length > 0 ? (
          <ul className="ap-plan-criteria">
            {(item.criteria ?? []).map((c, i) => <li key={i}>{c}</li>)}
          </ul>
        ) : (
          <blockquote className="ap-plan-quote">{item.expect}</blockquote>
        )}

        <div className="ap-plan-sect-t">
          证据 <span className="aside">{item.evidenceRefs?.length ?? 0} 件 · 均可点开</span>
        </div>
        <div className="ap-plan-ev-list">
          {(item.evidenceRefs ?? []).map((e, i) => (
            <EvidenceRow key={i} ev={e} onOpen={onOpenFile} />
          ))}
          {!(item.evidenceRefs ?? []).length && (
            <div className="ap-empty">这一项没有登记证据指针 —— 它只是覆盖声明，按需复核。</div>
          )}
        </div>

        {cmd && (
          <>
            <div className="ap-plan-sect-t">按需复核 <span className="aside">只在你点名时执行</span></div>
            <div className="ap-plan-machine pass" data-testid="plan-check-run">
              <span className="ap-plan-machine-tag">复核命令</span>
              <code className="ap-command" title={cmd}>{cmd}</code>
              <button
                type="button"
                className="ap-btn ap-btn-sm ap-btn-ghost"
                disabled={!!disabledReason || running}
                onClick={onRun}
                data-testid="plan-run-probe"
              >
                {running ? "⏳ 跑…" : <><Play className="size-2.5" /> 跑一下</>}
              </button>
            </div>
          </>
        )}

        {probe && <ProbeTerminal result={probe.result} command={probe.command} />}
      </div>
    </>
  )
}

// ── 小件 ─────────────────────────────────────────────────────────────

function probeCommand(item: PlaybookItem): string | null {
  return item.recheck?.trim()
    || item.probe?.command?.trim()
    || item.steps?.find((s) => s.command?.trim())?.command?.trim()
    || item.machine?.command?.trim()
    || item.howTo?.find((h) => h.kind === "run" && h.command?.trim())?.command?.trim()
    || null
}

function StepRow({
  index, step, disabled, running, ranAlready, onRun, onOpen,
}: {
  index: number
  step: PlanStep
  disabled: boolean
  running: boolean
  ranAlready: boolean
  onRun: (command?: string) => void
  onOpen?: (p: string) => void
}) {
  const canOpenFile = isHomeRel(step.target) && !!onOpen
  const isUrl = isHttpUrl(step.target)
  const command = step.command?.trim()
  return (
    <li className="ap-plan-step" data-step-kind={step.kind}>
      <span className="ap-plan-step-n">{index + 1}</span>
      <span className="ap-plan-step-main">
        <span className="ap-plan-step-kind">{STEP_LABEL[step.kind] ?? step.kind}</span>
        <b>{step.text}</b>
        {step.value && <code className="ap-command" title={step.value}>{step.value}</code>}
        {step.target && <code className="ap-command" title={step.target}>{step.target}</code>}
        {step.expect && <small>预期：{step.expect}</small>}
      </span>
      <span className="ap-plan-step-act">
        {command ? (
          <button type="button" className="ap-btn ap-btn-sm ap-btn-primary" disabled={disabled || running} onClick={() => onRun(command)}>
            {running ? "⏳ 运行中" : ranAlready ? "✓ 再跑" : <><Play className="size-2.5" /> 运行</>}
          </button>
        ) : canOpenFile ? (
          <button type="button" className="ap-btn ap-btn-sm ap-btn-ghost" onClick={() => onOpen!(step.target!)}>
            打开文件
          </button>
        ) : isUrl ? (
          <a className="ap-btn ap-btn-sm ap-btn-ghost" href={step.target} target="_blank" rel="noreferrer">
            打开
          </a>
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
        <span className="ap-plan-term-hint">机器证据只读；结论仍由场景决定</span>
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
        : `未判 — ${total} 条场景都有结论（或明确跳过）才能通过${undecided > 0 ? `（还差 ${undecided} 条）` : ""}`

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
            type="button"
            className="ap-btn ap-btn-sm ap-btn-coral"
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
