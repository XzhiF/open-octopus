// packages/web-app/components/tasks/acceptance/playbook-panel.tsx
//
// 验收台「验收剧本」(acceptance v2.2, ADR-0022) — the human walkthrough
// checklist the server COMPILES from the round's contract files. Presentational
// + owns its own checkbox state (debounced persistence via PUT home-file).
//
// v2.2 用户反馈（2026-09-19）：probe 步不该让人肉复制粘贴——就地 [▶ 执行]，
// 同步拿 exit+tail 像复检一样出结果并自动盖章（exit 0→✓、非零/超时→✗，人工
// 可随时改判；note 前缀 🔬 区分机器留痕）。长列表配「展开全部/收起全部」，
// 收起态仍可逐条 ✓✗⊘。
//
// 还原基准 = .scratch/20260917-acceptance-playbook-proto (A′ 变体): 黄头条主角卡、
// 预算表、票级步(操作/预期/反假跑)、✓✗⊘ 三色后果条、carryover 首段、finePrint 折叠、
// coverage 诚实条。视觉语言与 verify-panel 同源 (pop 贴纸: border-[1.5px] border-pop-bd
// bg-pop-paper shadow-pop-sm; 盖章 pop-stamp; 尾注 pop-dim)。
//
// Honesty baked in: never auto-runs; a ✗ blocks 通过 (reported up via onGate);
// ⊘/✗ require a note (rides into reject feedback + next-round carryover).

"use client"

import { FoldHandle, useFold } from "../fold-context"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ClipboardCheck, ExternalLink, ChevronRight, ChevronDown, Play, Square, Wrench } from "lucide-react"
import { toast } from "sonner"
import {
  readChecks, saveChecks, runProbe, type PlaybookPayload, type PlaybookItem, type CheckDecision,
  type CheckEntry, type ProbeRunResult,
} from "@/lib/tasks-api"
import { formatDuration } from "@/lib/format"

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
  /** 台账竞态闸（2026-09-20）：父级提交决策前调用，把 debounce 窗里的最后一笔
   *  勾选立刻落盘并等写完成 —— server 的 ledger/硬闸读的是盘上文件，不能少最后一笔。 */
  registerFlush?: (fn: (() => Promise<void>) | null) => void
}

const KIND_LABEL: Record<string, string> = { walk: "走查", probe: "探针", claim: "核对" }

// ③ lifecycle 步文案：本任务配了 runbook，这些命令的职责已由「跑起来看」钮承担。
const LIFECYCLE_LABEL: Record<"start" | "ready" | "teardown", string> = {
  start: "起服务·预览负责", ready: "就绪轮询·预览负责", teardown: "收尾·预览负责",
}
const LIFECYCLE_HINT: Record<"start" | "ready" | "teardown", string> = {
  start: "此步起停服务由上方「跑起来看 ▶启动」统一做，剧本不再逐条点（命令仍可展开查看）",
  ready: "等服务就绪由「跑起来看」的 ready 探针轮询，无需在此跑",
  teardown: "收尾杀进程由「跑起来看 ■停止」的 down 步骤负责",
}

export function PlaybookPanel({
  taskId, batchRelDir, roundIndex, playbook, onGate, disabledReason, saving, onSaveStateChange, registerFlush,
}: PlaybookPanelProps) {
  const fold = useFold()
  const panelClosed = fold ? fold.closed("item-playbook", "info") : false
  const [checks, setChecks] = useState<Record<string, CheckEntry>>({})
  const [openFine, setOpenFine] = useState(false)
  // 收起的步骤 id 集（默认全展开 = v2.1 行为不变；「收起全部」一键瘦身）。
  const [collapsed, setCollapsed] = useState<Record<string, true>>({})
  // 探针执行：面板级串行（一次一条，防并发打同一服务/抢端口）。
  const [runningProbe, setRunningProbe] = useState<string | null>(null)
  // ② 连跑全部：整段按序跑，遇首个 ✗ 即停；cancelRef 让「停止」在步间生效。
  const [runningAll, setRunningAll] = useState(false)
  const cancelRef = useRef(false)
  // 探针输出 tail 只驻内存（持久的是 entry.probe 章 + note 里的现象行）。
  const [probeNow, setProbeNow] = useState<Record<string, ProbeRunResult>>({})
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirtyRef = useRef(false)
  // 台账竞态闸：在飞的 saveChecks promise（flush 时 await 它；快照直接读 checksRef）。
  const inflightRef = useRef<Promise<unknown> | null>(null)
  // Mirror of `checks` for event handlers — decides compute `next` synchronously
  // from this (updater purity: side effects like onGate/persist must NEVER run
  // inside a setState updater — React executes it in the PARENT's render pass →
  // "Cannot update a component while rendering a different component", 六单实证).
  const checksRef = useRef<Record<string, CheckEntry>>({})

  // (re)load persisted checks on task/round switch — a fresh server restart
  // re-reads the .md the panel wrote last time (durable truth).
  useEffect(() => {
    let cancelled = false
    dirtyRef.current = false
    setProbeNow({})
    if (!batchRelDir) { checksRef.current = {}; setChecks({}); onGate(summarize(playbook, {})); return }
    void readChecks(taskId, batchRelDir, roundIndex).then((f) => {
      // 用户在盘上清单返回前已经动过手 → 人的最新判断赢，不被迟到的旧快照盖掉
      //（否则 300ms debounce 定时器再落盘时会写出空的 checks）。
      if (cancelled || dirtyRef.current) return
      checksRef.current = f.checks ?? {}
      setChecks(f.checks ?? {})
      onGate(summarize(playbook, f.checks ?? {}))
    }).catch(() => { if (!cancelled) { checksRef.current = {}; onGate(summarize(playbook, {})) } })
    return () => { cancelled = true }
    // playbook recompute must re-summarize too (step count can shift)
  }, [taskId, batchRelDir, roundIndex, playbook, onGate])

  /** 立刻写盘（清 debounce 定时器 + 抓 checksRef 最新快照）；在飞 promise 记进
   *  inflightRef 供 flush await。失败不再静默 —— 台账/硬闸读的都是这个文件。 */
  const writeChecks = useCallback((): Promise<void> => {
    if (!batchRelDir) return Promise.resolve()
    dirtyRef.current = false
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    const p = saveChecks(taskId, batchRelDir, roundIndex, checksRef.current)
      .catch((err: unknown) => {
        toast.error(err instanceof Error ? `勾选保存失败：${err.message}` : "勾选保存失败 — 台账可能少记，请重试")
      })
      .finally(() => { inflightRef.current = null; onSaveStateChange(false) })
    inflightRef.current = p
    return p
  }, [taskId, batchRelDir, roundIndex, onSaveStateChange])

  const persist = useCallback(() => {
    if (!batchRelDir) return
    dirtyRef.current = true
    onSaveStateChange(true)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => { saveTimer.current = null; void writeChecks() }, 300)
  }, [batchRelDir, onSaveStateChange, writeChecks])

  /** flush = 决策提交前的竞态闸：把 debounce 窗里的最后一笔立刻落盘并等写完。 */
  const flush = useCallback(async (): Promise<void> => {
    if (saveTimer.current || dirtyRef.current) await writeChecks()
    else if (inflightRef.current) await inflightRef.current
  }, [writeChecks])

  useEffect(() => {
    registerFlush?.(flush)
    return () => registerFlush?.(null)
  }, [registerFlush, flush])

  // 卸载时清掉未落盘的 debounce 定时器 —— 组件已不在，旧快照不该晚到写盘。
  useEffect(() => () => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
  }, [])

  // Single mutation funnel — called from event handlers only (NEVER from an
  // updater): parent-facing side effects must happen outside the render pass.
  const commit = useCallback((next: Record<string, CheckEntry>) => {
    checksRef.current = next
    setChecks(next)
    onGate(summarize(playbook, next))
    persist()
  }, [onGate, playbook, persist])

  const decide = useCallback((id: string, decision: CheckDecision | null, note?: string, probe?: CheckEntry["probe"]) => {
    const prev = checksRef.current
    const next = { ...prev }
    if (decision === null) delete next[id]
    else next[id] = { decision, note: note ?? prev[id]?.note ?? "", at: new Date().toISOString(), ...(probe ? { probe } : {}) }
    commit(next)
  }, [commit])

  const setNote = useCallback((id: string, note: string) => {
    const cur = checksRef.current[id]
    if (!cur) return
    commit({ ...checksRef.current, [id]: { ...cur, note } })
  }, [commit])

  /** 跑一条探针 + 就地盖章（exit0→✓ / 其余→✗，人工可改判）。返回是否通过，供
   *  连跑决定续不停。已有判定被机器结果覆盖是有意为之——刚跑的证据比旧手感新，
   *  note 带 🔬 前缀，ledger 里机器留痕与人工笔迹可分。 */
  const stampProbe = useCallback(async (item: PlaybookItem): Promise<boolean> => {
    const cmd = item.probe?.command
    if (!cmd) return true
    setRunningProbe(item.id)
    try {
      const r = await runProbe(taskId, cmd)
      setProbeNow((m) => ({ ...m, [item.id]: r }))
      const at = new Date().toLocaleTimeString("zh-CN", { hour12: false })
      const dur = (r.duration_ms / 1000).toFixed(1)
      const stamp = { state: r.state, exit_code: r.exit_code, at: new Date().toISOString() }
      const note = r.state === "passed"
        ? `🔬 探针 exit 0 · ${dur}s · ${at}`
        : `🔬 探针 ${r.state === "timeout" ? "超时" : `exit ${r.exit_code}`} · ${dur}s · ${at} · ${lastMeaningful(r.tail).slice(0, 90)}`
      decide(item.id, r.state === "passed" ? "pass" : "fail", note, stamp)
      return r.state === "passed"
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setProbeNow((m) => ({ ...m, [item.id]: { state: "failed", exit_code: null, duration_ms: 0, tail: [msg] } }))
      return false
    } finally {
      setRunningProbe(null)
    }
  }, [taskId, decide])

  /** [▶ 执行] 单步复跑。连跑进行中禁用（串行防抢端口）。 */
  const runOne = useCallback(async (item: PlaybookItem) => {
    if (!item.probe?.command || item.lifecycle || runningProbe || runningAll || disabledReason) return
    await stampProbe(item)
  }, [stampProbe, runningProbe, runningAll, disabledReason])

  // 连跑只收「断言类」可跑步：有命令 + 非 lifecycle + 面板未禁。lifecycle 步
  // （起服/就绪/收尾）由「跑起来看」runbook 负责，剧本不逐条点（③）。
  const runnableItems = useMemo(
    () => playbook.sections.flatMap((s) => s.items).filter((i) => i.probe?.command && !i.lifecycle),
    [playbook],
  )

  /** ▶ 连跑全部：按剧本顺序逐条 stampProbe，任一 ✗ 即停（停在真问题处，不空跑
   *  尾部）；「停止」按钮置 cancelRef，在下一步开始前生效。 */
  const runAll = useCallback(async () => {
    if (runningAll || runningProbe || disabledReason) return
    setRunningAll(true)
    cancelRef.current = false
    for (const it of runnableItems) {
      if (cancelRef.current) break
      const ok = await stampProbe(it)
      if (!ok) break
    }
    setRunningAll(false)
  }, [runningAll, runningProbe, disabledReason, runnableItems, stampProbe])

  const allItems = useMemo(() => playbook.sections.flatMap((s) => s.items), [playbook])
  const expandAll = () => setCollapsed({})
  const collapseAll = () => setCollapsed(Object.fromEntries(allItems.map((i) => [i.id, true as const])))
  const allCollapsed = allItems.length > 0 && allItems.every((i) => collapsed[i.id])

  if (!playbook.available) {
    return (
      <div className="ap-card" data-testid="playbook-empty">
        <div className="ap-card-head">
          <ClipboardCheck className="size-3.5 text-[var(--ap-muted)]" />
          <span className="ap-card-title">核对清单</span>
          <span className="ap-card-count">本轮没有可生成的清单</span>
        </div>
        <div className="ap-card-body">
          <p className="text-[11px] leading-relaxed text-[var(--ap-muted)]">
            缺 {playbook.coverage.missing.join(" / ") || "契约文件"} —— 可以在上方「自动自检」用「配置命令」补一条，
            或在批次目录补 <code>e2e-test-plan.md</code>（含 Verification steps / Pass criteria）。
          </p>
          <p className="mt-1 text-[10.5px] leading-relaxed text-[var(--ap-muted)]">
            没有清单时不设硬闸 —— 你仍可直接拍板，或直接退回修改。
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="ap-card" data-acceptance-playbook data-testid="playbook-panel">
      {/* 清单头：进度 + 连跑 + 展开全部 */}
      <div className="ap-card-head">
        {fold && <FoldHandle id="item-playbook" closed={panelClosed} onToggle={() => fold.toggle("item-playbook", "info")} />}
        <ClipboardCheck className="size-3.5 text-[var(--ap-muted)]" />
        <span className="ap-card-title">核对清单</span>
        {panelClosed && (
          <span className="ap-card-count" data-fold-badge="item-playbook">
            {countOf(checks, "pass")}/{allItems.length}✓ · {countOf(checks, "fail")}✕ · {countOf(checks, "skip")}⊘
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {runnableItems.length > 0 && (
            <button
              type="button"
              onClick={runningAll ? () => { cancelRef.current = true } : () => void runAll()}
              disabled={!!disabledReason || (!!runningProbe && !runningAll)}
              data-testid="playbook-run-all"
              title={runningAll ? "再点=下一步后停止（当前步会跑完）" : `按剧本顺序连跑 ${runnableItems.length} 条断言探针，遇首个 ✕ 即停（起服/就绪/收尾归「试一试」）`}
              className={`ap-btn ap-btn-sm ${runningAll ? "ap-btn-coral" : "ap-btn-primary"}`}
            >
              {runningAll ? <><Square className="size-2.5" />停止</> : <><Play className="size-2.5" />连跑 {runnableItems.length}</>}
            </button>
          )}
          <button
            type="button"
            className="ap-card-action"
            onClick={allCollapsed ? expandAll : collapseAll}
            data-testid="playbook-toggle-all"
            title={allCollapsed ? "展开全部步骤明细" : "收起明细，只留标题 + 勾选（逐条速览）"}
          >
            {allCollapsed ? "展开全部" : "收起全部"}
          </button>
          <span className="ap-card-count" data-testid="playbook-count">
            <b>{countOf(checks, "pass")}</b>/{allItems.length}✓ · {countOf(checks, "skip")}⊘ · <span className="bad">{countOf(checks, "fail")}✕</span>
          </span>
        </div>
      </div>

      {!panelClosed && (
        <div className="ap-card-body">
          {playbook.goal && <div className="text-[11px] font-semibold leading-snug text-[var(--ap-ink-2)]">{playbook.goal}</div>}
          <div className="mt-1 flex items-center gap-2 text-[9.5px] text-[var(--ap-muted)]">
            <span>预算 {playbook.budget.steps} 步 · ~{playbook.budget.estMin}min</span>
            {playbook.budget.over && <span className="text-[var(--ap-amber)]">超预算 → 已降档</span>}
            <span className="ml-auto font-mono text-[9px] text-[var(--ap-muted-2)]">{separatorNote(playbook.budget.over)}</span>
          </div>
          {playbook.specRevised && (
            <div className="ap-check-note mt-2">⚠ round-report 含「Spec 修订」—— 下列预期以上轮修订后为准，核对时留意。</div>
          )}
          {disabledReason && <div className="ap-check-note mt-2">{disabledReason}</div>}

          {/* carryover 首段（上轮未结，最该先做） */}
          {playbook.carryover.length > 0 && (
            <div className="ap-carryover" data-testid="playbook-carryover">
              <div className="ap-carryover-title">上轮未结 · 先补这些（{playbook.carryover.length}）</div>
              {playbook.carryover.map((co) => (
                <div key={co.id} className="ap-carryover-item" data-step={co.id}>
                  <div className="flex items-baseline gap-2">
                    <span className="op">{co.op}</span>
                    <span className="meta">{co.decision === "failed" ? "上轮✕" : "上轮⊘"} · R{co.fromRound}</span>
                    <span className="ml-auto flex gap-1">
                      {(["pass", "skip", "fail"] as const).map((d) => (
                        <DecideBtn key={d} active={checks[co.id]?.decision === d} decision={d} disabled={!!disabledReason} onClick={() => decide(co.id, checks[co.id]?.decision === d ? null : d)} />
                      ))}
                    </span>
                  </div>
                  <div className="ap-carryover-expect">预期 · {co.expect}{co.note ? ` · 备注：${co.note}` : ""}</div>
                  {(checks[co.id]?.decision === "fail" || checks[co.id]?.decision === "skip") && (
                    <textarea
                      className="ap-note-input"
                      rows={1}
                      placeholder={checks[co.id]?.decision === "fail" ? "仍不过 —— 会再次退回并保票 reopened" : "再豁免一次，需写新原因"}
                      value={checks[co.id]?.note ?? ""}
                      onChange={(e) => setNote(co.id, e.target.value)}
                      data-testid={`carryover-note-${co.id}`}
                    />
                  )}
                </div>
              ))}
            </div>
          )}

          {/* 主体：按票分节 */}
          {playbook.sections
            .filter((s) => s.title.startsWith("上轮未结") === false || playbook.carryover.length === 0)
            .map((sec) => (
              <div key={sec.source + sec.title} className="ap-check-group">
                <div className="ap-check-group-title">
                  <span>{KIND_LABEL[sec.kind] ?? sec.kind} · {sec.title}</span>
                  <span className="gline" />
                  <span>{sec.items.length} 项</span>
                </div>
                {sec.items.map((it) => (
                  <StepRow
                    key={it.id} item={it} entry={checks[it.id]} disabled={!!disabledReason}
                    open={!collapsed[it.id]} onToggle={() => setCollapsed((c) => { const n = { ...c }; if (n[it.id]) delete n[it.id]; else n[it.id] = true; return n })}
                    onDecide={decide} onNote={setNote}
                    probe={probeNow[it.id]} probeRunning={runningProbe === it.id} onRunProbe={() => void runOne(it)}
                    runBlockedReason={disabledReason ?? (runningAll ? "连跑进行中 — 单步钮暂禁" : runningProbe && runningProbe !== it.id ? "另一条探针在跑 — 探针串行" : undefined)}
                  />
                ))}
              </div>
            ))}

          {/* finePrint 折叠（票内全部 AC，勾选不在这一层） */}
          {playbook.finePrint.length > 0 && (
            <div className="ap-fine">
              <button type="button" className="ap-fine-toggle" onClick={() => setOpenFine((v) => !v)} data-testid="playbook-fine-toggle">
                {openFine ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />} 票内 AC 细目（{playbook.finePrint.reduce((n, f) => n + f.acs.length, 0)} 条，仅供回溯，不在这一层勾选）
              </button>
              {openFine && (
                <div className="ap-fine-body" data-testid="playbook-fine">
                  {playbook.finePrint.map((f) => f.acs.map((a, i) => <div key={f.ticket + i} className="mb-0.5 break-inside-avoid">· [{f.ticket}] {a}</div>))}
                </div>
              )}
            </div>
          )}

          {saving && <div className="mt-2 text-right font-mono text-[9px] text-[var(--ap-muted-2)]">保存勾选…</div>}
          <div className="ap-coverage mt-2" data-testid="playbook-coverage">
            编译来源：{playbook.coverage.found.join(" · ") || "无"}{playbook.coverage.missing.length ? ` ｜ 缺：${playbook.coverage.missing.join(" · ")}` : ""}
          </div>
        </div>
      )}
    </div>
  )
}

// ── one walkthrough step ──────────────────────────────────────────────
function StepRow({ item, entry, disabled, open, onToggle, onDecide, onNote, probe, probeRunning, onRunProbe, runBlockedReason }: {
  item: PlaybookItem; entry?: CheckEntry; disabled: boolean; open: boolean
  onToggle: () => void
  onDecide: (id: string, d: CheckDecision | null, note?: string, probe?: CheckEntry["probe"]) => void
  onNote: (id: string, note: string) => void
  probe?: ProbeRunResult; probeRunning: boolean
  onRunProbe: () => void; runBlockedReason?: string
}) {
  const d = entry?.decision
  const needsNote = d === "fail" || d === "skip"
  return (
    <div className="ap-check-item" data-state={d} data-step={item.id} data-testid={`step-${item.id}`}>
      <button
        type="button"
        className="ap-check-main"
        onClick={onToggle}
        aria-expanded={open}
        title={open ? "收起本步明细" : "展开本步明细"}
        data-testid={`step-toggle-${item.id}`}
      >
        <span className="ap-check-circle">{d === "pass" ? "✓" : d === "fail" ? "✕" : d === "skip" ? "⊘" : ""}</span>
        <span className="ap-check-text">
          <b>{item.op}</b>
        </span>
      </button>
      <span className="ap-check-actions">
        {(["pass", "fail", "skip"] as const).map((k) => (
          <DecideBtn key={k} active={d === k} decision={k} disabled={disabled} onClick={() => onDecide(item.id, d === k ? null : k)} />
        ))}
        {item.probe?.command && (item.lifecycle ? (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-dashed border-[var(--ap-line-2)] px-1.5 py-0.5 font-mono text-[9px] text-[var(--ap-muted)]"
            data-testid={`probe-lifecycle-${item.id}`}
            title={LIFECYCLE_HINT[item.lifecycle]}
          >
            <Wrench className="size-2.5" />{LIFECYCLE_LABEL[item.lifecycle]}
          </span>
        ) : (
          <button
            type="button"
            onClick={onRunProbe}
            disabled={disabled || probeRunning || !!runBlockedReason}
            title={runBlockedReason ?? "在工作区执行这条探针（同步出结果，自动盖章，可改判）"}
            className="ap-decide"
            data-testid={`probe-run-${item.id}`}
          >
            {probeRunning ? "⏳" : <span className="inline-flex items-center gap-0.5"><Play className="size-2.5" />跑</span>}
          </button>
        ))}
        {(probe || entry?.probe) && (
          <span
            className={`ap-probe-stamp ${(probe?.state ?? entry?.probe?.state) === "passed" ? "pass" : "fail"}`}
            data-testid={`probe-stamp-${item.id}`}
            title={`机器探针 · exit ${probe?.exit_code ?? entry?.probe?.exit_code}${probe?.duration_ms != null ? ` · ${formatDuration(probe.duration_ms)}` : ""}`}
          >
            EXIT {probe?.exit_code ?? entry?.probe?.exit_code ?? "?"}
          </span>
        )}
      </span>
      {open && (
        <div className="ap-check-detail">
          {item.probe?.command && (
            <code className="ap-command" title={item.probe.command}>$ {item.probe.command}</code>
          )}
          <div className="ap-expect">
            <b>预期</b> · {item.expect}{item.evidence ? <span className="dim"> ｜ 反假跑：{item.evidence}</span> : null}
          </div>
          {d && <Consequence decision={d} ticketHint={item.id} />}
          {needsNote && (
            <textarea
              className="ap-note-input" rows={1}
              placeholder={d === "fail" ? "不过的实际现象（必填）— 进退回反馈 + 重开此票" : "为什么这次可以不验（必填）— 下轮仍会问"}
              value={entry?.note ?? ""} onChange={(e) => onNote(item.id, e.target.value)} data-testid={`note-${item.id}`}
            />
          )}
          {probe?.tail.length ? (
            <div className="ap-probe-tail" data-testid={`probe-tail-${item.id}`}>
              {probe.tail.slice(-20).map((l, i) => (
                <div key={i} className={/error|fail/i.test(l) ? "text-[#e0ab5a]" : undefined}>{l}</div>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

function DecideBtn({ active, decision, disabled, onClick }: { active: boolean; decision: CheckDecision; disabled: boolean; onClick: () => void }) {
  const map = {
    pass: { t: "✓", label: "通过" },
    fail: { t: "✕", label: "不过" },
    skip: { t: "⊘", label: "跳过" },
  }[decision]
  return (
    <button
      type="button" disabled={disabled} onClick={onClick} aria-label={map.label} title={map.label}
      className="ap-decide" data-active={active} data-d={decision} data-testid={`decide-${decision}`}
    >{map.t}</button>
  )
}

function Consequence({ decision, ticketHint }: { decision: CheckDecision; ticketHint: string }) {
  if (decision === "pass") return <div className="ap-consequence pass">→ 销账：后续轮次不再出现 · 写入验收记录 ✓ 节</div>
  if (decision === "fail") return <div className="ap-consequence fail">→ 硬闸：通过被拦 · 退回预填 · <b>票 {ticketHint.split(":")[1]} 将 reopened</b></div>
  return <div className="ap-consequence skip">→ 下轮 carryover 首段：补验或再豁免 · 最终轮未决 → 交付披露</div>
}

// ── helpers ───────────────────────────────────────────────────────────
function separatorNote(over: boolean): string {
  return over ? "已按预算降档" : "≤10min ✓"
}
function countOf(checks: Record<string, CheckEntry>, d: CheckDecision): number {
  return Object.values(checks).filter((c) => c.decision === d).length
}
/** 探针失败时给 note 找一条最能说明问题的输出（倒找第一条非引擎噪声行）。 */
function lastMeaningful(tail: string[]): string {
  for (let i = tail.length - 1; i >= 0; i--) {
    const l = (tail[i] ?? "").trim()
    if (l && !/^\[stderr\] Script failed|^Script (completed|failed)/.test(l)) return l
  }
  return "无输出"
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
