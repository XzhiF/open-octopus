// packages/web-app/components/tasks/run-console/phase-surface.tsx
//
// 执行态控制台右半 —— 「当前 Phase 的一切」（2026-09-12 执行弹窗改版）。
// 五区去重的归宿：任务概要 goal / 发射门禁 / 盘上文件(固定分桶) / 轮次(分档：
// 0 不渲染 · 1 轮无框 · ≥2 轮立账) / 大事报(没事不显示) + 验收判决条，全在这一面。
// 一个事实只出现一次：本组件不渲染 phase 状态文字（rail 是唯一状态位）。

"use client"

import { useMemo, useState } from "react"
import { toast } from "sonner"
import type { Task, TaskExecutionBadge, TaskPhase } from "@octopus/shared"
import {
  type TaskDetail, type TaskPhaseView, type TaskRoundView,
} from "@/lib/tasks-api"
import type { LLMCallAggregates } from "@/lib/types"
import type { BatchTreeState } from "../authoring/use-batch-tree"
import { findSpecEntry, isRelativeScratchSpec } from "../authoring/use-batch-tree"
import { PhaseSpecDialog } from "../authoring/phase-spec-dialog"
import { WorkflowViewerDialog } from "../authoring/workflow-viewer-dialog"
import { ArtifactsCard, RUN_STATUS_LABEL, deepLinkTarget, timeStamp, AggInline } from "../execution-summary"
import { formatBytes, formatCost, formatDuration } from "@/lib/format"
import { clockShort, roundGlyph, roundTone, sumRunMs } from "./phase-status"
import { FoldBox, FoldHandle, useFold } from "../fold-context"
import type { SignalLine } from "./signal-build"

/** SSE 状态跳变一行（大事报在屏时垫底；权威态仍是 GET /:id）。 */
export interface StreamEvent {
  at: string
  glyph: string
  tone: string
  text: string
}

/** 控制台共享数据袋：console 顶层拉一次，喂 rail 与所有 surface。 */
export interface RunCtx {
  task: Task
  detail: TaskDetail | null
  specPhases: TaskPhase[]
  phaseViews: TaskPhaseView[]
  tree: BatchTreeState
  aggMap: Record<string, LLMCallAggregates>
  totalAgg: LLMCallAggregates | null
  runsById: Map<string, TaskExecutionBadge>
  /** 1s tick（仅 live 态推进；秒表与已等时长靠它）。 */
  now: number
  isLive: boolean
  events: StreamEvent[]
  /** 大事报信号（agent-events 榨出，console 顶层拉取；空 = 整块不渲染）。 */
  signals: SignalLine[]
  refetch: () => void
  onMutated: () => void
  /** 切到「验货台」tab（三栏证据面已收编为控制台 tab，2026-09-16）。 */
  openAcceptance: () => void
  /** 打开触发对话框（TriggerDialog，控制台单实例）。 */
  openTrigger: () => void
}

// ── 框皮肤统一走 ../fold-context 的 FoldBox（可折 + 折后一行结论）────────

/** 该轮次/运行的账目一行 → 统一走 AggInline（∑/↑/↓/⚡/🗡️·N 次请求·$，2026-09-16 定版）。 */

// ── 盘上文件（固定分桶，2026-09-19 降噪定稿）─────────────────────────
// 旧版把 issues 外每个文件铺一枚章 —— 验收C 实测 20 文件 = 18 枚章炸版。
// 新章数恒定 ≤5：spec ｜ 票 (issues/) ｜ 报告 (顶层 *report/review/finding*)
// ｜ 证据 (非 issues 子目录 + 游离顶层，单一目录时带目录名) ｜ 全部 N ▸。
// 桶章点击 = 打开 PhaseSpecDialog 并定位该桶最新一件；「全部」进树不定位。

export function FileChips({ ctx, phase }: { ctx: RunCtx; phase: TaskPhase }) {
  const { batches } = ctx.tree
  const specHit = findSpecEntry(batches, phase.specPath)
  const rel = isRelativeScratchSpec(phase.specPath)
  const norm = phase.specPath.replace(/\\/g, "/").replace(/^\.\//, "")
  const batch = useMemo(
    () => batches.find((b) => norm.startsWith(`${b.dir}/`)) ?? null,
    [batches, norm],
  )
  const [viewing, setViewing] = useState<{ file: string } | null>(null)

  const buckets = useMemo(() => {
    if (!batch) return null
    const strip = (p: string) => p.slice(batch.dir.length + 1).replace(/\\/g, "/")
    const notSpec = batch.files.filter((f) => !/(^|\/)spec\.md$/i.test(strip(f.path)))
    const tickets = notSpec.filter((f) => strip(f.path).startsWith("issues/"))
    const outside = notSpec.filter((f) => !strip(f.path).startsWith("issues/"))
    const isTop = (f: { path: string }) => !strip(f.path).includes("/")
    const reports = outside.filter((f) => isTop(f) && /(report|review|finding)/i.test(f.path))
    const evidence = outside.filter((f) => !reports.includes(f))
    const dirs = new Set(evidence.map((f) => { const s = strip(f.path); return s.includes("/") ? s.split("/")[0] : "" }))
    const sole = dirs.size === 1 && !dirs.has("") ? [...dirs][0] : null
    const newest = (arr: typeof batch.files) => arr.reduce<(typeof batch.files)[number] | null>((a, b) => (!a || b.mtime > a.mtime ? b : a), null)
    return {
      total: batch.files.length,
      tickets: { n: tickets.length, at: newest(tickets)?.path ?? "" },
      reports: { n: reports.length, at: newest(reports)?.path ?? "" },
      evidence: { n: evidence.length, at: newest(evidence)?.path ?? "", dir: sole },
    }
  }, [batch])

  const chip = (label: React.ReactNode, onClick: () => void, cls = "", title?: string, key?: string, testid?: string) => (
    <button
      key={key}
      data-testid={testid}
      onClick={onClick}
      title={title}
      className={`rounded-[7px] border-[1.5px] border-pop-bd bg-pop-bg px-1.5 py-0.5 font-mono text-[10.5px] transition-colors hover:bg-pop-yellow-soft ${cls}`}
    >
      {label}
    </button>
  )

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-phase-files={phase.index}>
      {rel ? (
        specHit
          ? chip(`📄 spec.md ${formatBytes(specHit.bytes)}`, () => setViewing({ file: specHit.path }), "text-pop-ink", specHit.path)
          : <span className="rounded-[7px] border-[1.5px] border-dashed border-pop-amber/70 bg-pop-amber-soft px-1.5 py-0.5 font-mono text-[10.5px] text-pop-ink" data-file-missing>📄 spec.md 未落盘</span>
      ) : (
        <span className="rounded-[7px] border-[1.5px] border-pop-bd/30 bg-pop-idle px-1.5 py-0.5 font-mono text-[10.5px] text-pop-dim" title={phase.specPath}>📄 绝对路径 spec · 磁盘不判定</span>
      )}
      {buckets && buckets.tickets.n > 0 && chip(
        <span><b className="font-black">🎫 票</b> <span className="text-pop-dim">×{buckets.tickets.n}</span></span>,
        () => setViewing({ file: buckets.tickets.at }), "", "issues/ 全量票", "b-issues", "file-bucket-issues",
      )}
      {buckets && buckets.reports.n > 0 && chip(
        <span><b className="font-black">📃 报告</b> <span className="text-pop-dim">×{buckets.reports.n}</span></span>,
        () => setViewing({ file: buckets.reports.at }), "", "round-report / code-review 等顶层报告", "b-reports", "file-bucket-reports",
      )}
      {buckets && buckets.evidence.n > 0 && chip(
        <span><b className="font-black">{buckets.evidence.dir ? `🧪 证据 ${buckets.evidence.dir}` : "📁 其他"}</b> <span className="text-pop-dim">×{buckets.evidence.n}</span></span>,
        () => setViewing({ file: buckets.evidence.at }), "", "非票非报告的产物（日志/数据/截图）", "b-evidence", "file-bucket-evidence",
      )}
      {buckets && buckets.total > 0 && chip(
        <b className="font-black">全部 {buckets.total} ▸</b>,
        () => setViewing({ file: specHit?.path ?? batch?.files[0]?.path ?? "" }),
        "border-pop-ink bg-pop-ink text-pop-bg shadow-pop-sm", "文件树全量", "b-all", "file-bucket-all",
      )}
      {viewing && (
        <PhaseSpecDialog
          task={ctx.task}
          phase={phase}
          initialActivePath={viewing.file}
          open
          onOpenChange={(o) => { if (!o) setViewing(null) }}
        />
      )}
    </div>
  )
}

// ── 轮次行（一次运行 = 一行；吸收原「执行记录」）──────────────────────

export function RoundRow({ ctx, exec, meta }: {
  ctx: RunCtx
  /** derived 轮次视图；legacy 行传 null，直接吃 executions 徽章。 */
  meta: { pv?: TaskPhaseView; r?: TaskRoundView }
  exec: TaskExecutionBadge
}) {
  const agg = ctx.aggMap[exec.id] ?? null
  const startedMs = exec.started_at ? Date.parse(exec.started_at) : Date.parse(exec.created_at)
  const isLive = ["pending", "running", "paused", "pending_approval", "pending_resume"].includes(exec.status)
  const duration = !Number.isNaN(startedMs)
    ? (exec.completed_at ? Math.max(0, Date.parse(exec.completed_at) - startedMs) : isLive ? Math.max(0, ctx.now - startedMs) : null)
    : null
  const error = ["failed", "aborted", "completed_with_failures"].includes(exec.status) ? exec.error_summary : null
  const link = deepLinkTarget(exec)
  const ran = meta.r ? (meta.r.exec.workflow_ref ?? meta.pv?.workflowRef ?? exec.workflow_ref) : exec.workflow_ref

  return (
    <div className="border-b-[1.5px] border-dashed border-pop-bd/15 py-1.5 last:border-b-0" data-run-child={exec.id}>
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <span className={`shrink-0 rounded-[7px] border-2 border-pop-bd px-1.5 py-px font-mono text-[10px] font-black ${meta.r ? roundTone(meta.r) : "bg-pop-idle text-pop-dim"}`}>
          {meta.r ? `R${meta.r.roundIndex} ${roundGlyph(meta.r)}` : "RUN"}
        </span>
        <span className="truncate font-mono text-[11px] text-pop-dim" title={ran}>{ran.replace(/^built-in\//, "")}</span>
        <span className="shrink-0 font-bold">{RUN_STATUS_LABEL[exec.status] ?? exec.status}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[10.5px] text-pop-ink">
          <span className="text-pop-dim" title={timeStamp(exec.started_at ?? exec.created_at)}>{clockShort(exec.started_at ?? exec.created_at)}</span>
          {duration != null && <span>{formatDuration(duration)}</span>}
          <AggInline agg={agg} />
        </span>
        {link && (
          <button
            // 新标签页打开——控制台弹窗留在原地（router.push 会把弹窗整个顶走，2026-09-19 用户拍板）
            onClick={() => window.open(link, "_blank", "noopener")}
            title="在工作区查看该次执行的流程图（新标签页）"
            className="shrink-0 rounded-[8px] border-2 border-pop-purple bg-pop-purple-soft px-2 py-0.5 font-mono text-[10px] font-black text-pop-purple shadow-pop-sm transition-transform hover:-translate-y-px"
            data-run-deeplink="execution"
          >
            流程图 <span className="font-normal">↗</span>
          </button>
        )}
      </div>
      {error && <div className="truncate pl-11 font-mono text-[10.5px] text-pop-red" title={error} data-run-error={exec.id}>{error}</div>}
      {/* composite 臂（detail 才载；undefined=没加载，绝不说「无子单元」） */}
      {(exec.children?.length ?? 0) > 0 && (
        <div className="ml-6 mt-1 space-y-1 border-l border-pop-bd/20 pl-2" data-run-arms={exec.id}>
          {(exec.children ?? []).map((arm) => (
            <div key={arm.id} className="flex items-center gap-2 text-[11px]" data-run-arm={arm.id}>
              <span className="truncate font-medium">{arm.name || arm.workflow_ref || `执行 ${arm.id.slice(0, 8)}`}</span>
              <span className="ml-auto shrink-0 text-pop-dim">{RUN_STATUS_LABEL[arm.status] ?? arm.status}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── 大事报（2026-09-20 定稿：只报你该知道的事，没事整块不存在）────────

const SIG_TONE: Record<SignalLine["kind"], string> = {
  bad: "border-pop-red bg-[#fff5f5]",
  loop: "border-pop-amber bg-pop-amber-soft",
  stall: "border-pop-cyan bg-pop-cyan-soft",
  out: "border-pop-green/60 bg-[#f6fffa]",
}

function SignalBox({ signals, events }: { signals: SignalLine[]; events: StreamEvent[] }) {
  const [openBad, setOpenBad] = useState(false)
  if (signals.length === 0) return null // 全绿 = 没有报告 —— 这就是报告本身
  return (
    <FoldBox id="signal" tag="大事报 / SIGNAL" badge={`${signals.length} 条 · ${signals[0].glyph} ${signals[0].text}`} tail="只在有事时出现" tone="border-pop-bd">
      <div className="space-y-1" data-testid="signal-box">
        {signals.map((l) => (
          <div key={l.text} className={`rounded-lg border-[1.5px] px-2 py-1 font-mono text-[11.5px] ${SIG_TONE[l.kind]}`} data-signal={l.kind}>
            <b className="mr-1.5 font-black">{l.glyph}</b>
            {l.text}
            {l.detail && (
              <button onClick={() => setOpenBad((v) => !v)} className="ml-2 rounded border-[1.5px] border-pop-bd/40 px-1 text-[9px] font-black text-pop-dim hover:bg-pop-paper" data-signal-expand>
                {openBad ? "收起" : "详情"}
              </button>
            )}
            {l.detail && openBad && <div className="mt-0.5 truncate text-[10.5px] text-pop-dim" title={l.detail}>{l.detail}</div>}
          </div>
        ))}
        {events.slice(-3).reverse().map((e, i) => (
          <div key={`s${i}`} className="truncate font-mono text-[10.5px] text-pop-dim" data-signal="status">
            <span>{e.at}</span> <span className={e.tone}>{e.glyph}</span> {e.text}
          </div>
        ))}
      </div>
    </FoldBox>
  )
}

// ── Phase 控制台（选中 phase 的全息面）──────────────────────────────

export function PhaseSurface({ ctx, pv }: { ctx: RunCtx; pv: TaskPhaseView }) {
  const specPhase = ctx.specPhases.find((p) => p.index === pv.index) ?? null
  const [wfOpen, setWfOpen] = useState(false)
  const fold = useFold()
  const closedOf = (id: string, group: "info" | "main" = "info") => (fold ? fold.closed(id, group) : false)
  const filesBadge = useMemo(() => {
    if (!specPhase) return ""
    const norm = specPhase.specPath.replace(/\\/g, "/").replace(/^\.\//, "")
    const b = ctx.tree.batches.find((x) => norm.startsWith(`${x.dir}/`))
    if (!b) return ""
    const strip = (p: string) => p.slice(b.dir.length + 1)
    return `${b.files.length} 件 · 票×${b.files.filter((f) => strip(f.path).startsWith("issues/")).length}`
  }, [specPhase, ctx.tree.batches])
  const liveRound = pv.rounds.find((r) => r.state === "running" || r.state === "pending") ?? null
  const awaiting = pv.status === "awaiting_review" && pv.awaitingRound != null
    ? pv.rounds.find((r) => r.roundIndex === pv.awaitingRound) ?? null
    : null
  const goal = ctx.task.task_spec?.goal
  const phases = ctx.specPhases
  // 已定时/等到点的大按钮让位（与 TriggerActions 同判据：游标与实例状态都在任务行上）。
  const armedFuture = !!ctx.task.next_fire_at && new Date(ctx.task.next_fire_at).getTime() > Date.now()
  const waitingForSlot = ctx.task.execution?.status === "pending"


  // 发射门禁（ready 语境）：只讲 client 拿得到的真相，服务端 ready/trigger 闸口为准。
  const gateRows: { ok: boolean | null; text: string }[] | null = specPhase ? (() => {
    const bound = phases.filter((p) => !!p.workflowRef).length
    const relPhases = phases.filter((p) => isRelativeScratchSpec(p.specPath))
    const landed = relPhases.filter((p) => !!findSpecEntry(ctx.tree.batches, p.specPath)).length
    const undecidable = phases.length - relPhases.length
    return [
      { ok: bound === phases.length && phases.length > 0, text: `每个 Phase 已绑定工作流（${bound}/${phases.length}）` },
      {
        ok: relPhases.length > 0 && landed === relPhases.length ? true : (ctx.tree.loading && ctx.tree.batches.length === 0 ? null : false),
        text: `spec.md 落盘（${landed}/${relPhases.length}${undecidable > 0 ? ` · ${undecidable} 个绝对路径不判定` : ""}）`,
      },
      { ok: ctx.task.project_ids.length > 0, text: `项目语境 · ${ctx.task.project_ids.join(", ") || "无"}` },
    ]
  })() : null

  return (
    <div className="flex flex-col gap-2.5" data-phase-surface={pv.index}>
      {/* 头部：名 + 工作流徽章 + slug（状态文字归 rail，不重复） */}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h2 className="min-w-0 truncate text-[15px] font-black">P{pv.index} · {pv.name}</h2>
        <button
          onClick={() => setWfOpen(true)}
          title={`${pv.workflowRef} — 点击查看 YAML`}
          className="shrink-0 rounded-[7px] border-2 border-pop-bd bg-pop-purple-soft px-1.5 py-0.5 font-mono text-[10px] font-black text-pop-purple shadow-pop-sm transition-colors hover:bg-pop-yellow-soft"
          data-v4-workflow-ref={pv.index}
        >
          ⚙ {pv.workflowRef.replace(/^built-in\//, "")}
        </button>
        <span className="shrink-0 font-mono text-[10.5px] text-pop-dim">{pv.slug}</span>
      </div>

      {/* LIVE 卡：当前在跑轮的一口呼吸（秒表 + 账目 + 流程图直达） */}
      {liveRound && (() => {
        const run = ctx.runsById.get(liveRound.exec.id) ?? null
        const startedMs = run?.started_at ? Date.parse(run.started_at) : Date.parse(liveRound.exec.created_at)
        const dur = !Number.isNaN(startedMs) ? Math.max(0, ctx.now - startedMs) : null
        const agg = ctx.aggMap[liveRound.exec.id] ?? null
        return (
          <section className="overflow-hidden rounded-[13px] border-2 border-pop-purple bg-pop-paper shadow-pop-sm" data-fold-box="live" data-fold-closed={closedOf("live", "main") ? "true" : undefined}>
            <header className="flex items-center gap-2 bg-pop-purple-soft px-3 py-1.5">
              {fold && <FoldHandle id="live" group="main" closed={closedOf("live", "main")} onToggle={() => fold.toggle("live", "main")} />}
              <span className="font-mono text-[9.5px] font-black tracking-[.09em] text-pop-purple">▶ LIVE ROUND · R{liveRound.roundIndex}</span>
              {closedOf("live", "main") && <span className="truncate font-mono text-[10px] font-black" data-fold-badge="live">{RUN_STATUS_LABEL[run?.status ?? "running"] ?? "执行中"}{dur != null ? ` · ${formatDuration(dur)}` : ""}</span>}
              {(() => {
                const liveLink = run ? deepLinkTarget(run) : null // 同上：workspace_id 在徽章上
                return liveLink ? (
                  <button
                    onClick={() => window.open(liveLink, "_blank", "noopener")}
                    title="在工作区查看进行中的流程图（新标签页打开）"
                    className="rounded-[10px] border-[2.5px] border-pop-bd bg-pop-purple px-2.5 py-0.5 font-mono text-[10px] font-black text-white shadow-pop-sm transition-transform hover:-translate-y-px"
                    data-run-deeplink="live"
                  >
                    执行流程图 <span className="font-normal">↗</span>
                  </button>
                ) : null
              })()}
              <span className="ml-auto font-mono text-[10px] text-pop-dim">{(liveRound.exec.workflow_ref ?? pv.workflowRef).replace(/^built-in\//, "")}</span>
            </header>
            <div className={closedOf("live", "main") ? "hidden" : "flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-[11.5px]"}>
              <span className="font-black text-pop-purple">{RUN_STATUS_LABEL[run?.status ?? liveRound.exec.status] ?? "执行中"}</span>
              <span className="font-mono text-pop-dim" title={timeStamp(run?.started_at ?? liveRound.exec.created_at)}>起 {clockShort(run?.started_at ?? liveRound.exec.created_at)}</span>
              {dur != null && <span className="font-mono font-black tabular-nums">{formatDuration(dur)}</span>}
              <AggInline agg={agg} className="font-mono" />
            </div>
          </section>
        )
      })()}

      {/* 待验收：交付报告 + 判决条 */}
      {awaiting && (() => {
        const run = ctx.runsById.get(awaiting.exec.id) ?? null
        const startedMs = run?.started_at ? Date.parse(run.started_at) : Date.parse(awaiting.exec.created_at)
        const dur = run?.completed_at && !Number.isNaN(startedMs) ? Math.max(0, Date.parse(run.completed_at) - startedMs) : null
        const agg = ctx.aggMap[awaiting.exec.id] ?? null
        const roundError = awaiting.state === "failed" && run
          ? (["failed", "aborted", "completed_with_failures"].includes(run.status) ? run.error_summary : null)
          : null
        return (
          <>
            {/* 单入口定稿（2026-09-19 用户拍板）：原先卡内紫字链「验货台核对实物 →」+
                卡外整行绿横幅 = 同一动作两入口 → 收敛为「整卡可点 + 卡头一枚绿章」。
                流程图章（V2 紫实心）坐它左边弱一档：查看 vs 主行动，层级分明。
                两章均 stopPropagation——别撞整卡热区。 */}
            {(() => {
              // workspace_id 只在执行徽章上（TaskRoundExec 不带），从 run 取。
              const flowLink = run ? deepLinkTarget(run) : null
              return (
                <section
                  className="cursor-pointer overflow-hidden rounded-[13px] border-2 border-pop-amber bg-pop-amber-soft shadow-pop-sm transition-transform hover:-translate-y-px hover:shadow-pop"
                  onClick={ctx.openAcceptance}
                  data-acceptance-open
                  data-testid="console-acceptance-card"
                  data-fold-box="deliver"
                  data-fold-closed={closedOf("deliver", "main") ? "true" : undefined}
                >
                  <header className="flex items-center gap-2 px-3 py-1.5 border-b-2 border-pop-bd/10">
                    {fold && <FoldHandle id="deliver" group="main" closed={closedOf("deliver", "main")} onToggle={() => fold.toggle("deliver", "main")} />}
                    <span className="font-mono text-[9.5px] font-black tracking-[.09em]">R{awaiting.roundIndex} 交付报告 · 机检结果</span>
                    {closedOf("deliver", "main") && (
                      <span className="truncate font-mono text-[10px] font-black" data-fold-badge="deliver">
                        {awaiting.state === "succeeded" ? "✓ 执行成功" : "✗ 执行失败"}{dur != null ? ` · 用时 ${formatDuration(dur)}` : ""}
                      </span>
                    )}
                    {flowLink && (
                      <button
                        onClick={(e) => { e.stopPropagation(); window.open(flowLink, "_blank", "noopener") }}
                        title="在工作区查看本轮执行的流程图（新标签页打开）"
                        className="ml-1 shrink-0 rounded-[10px] border-[2.5px] border-pop-bd bg-pop-purple px-2.5 py-1 font-mono text-[10.5px] font-black text-white shadow-pop-sm transition-transform hover:-translate-y-px"
                        data-run-deeplink="awaiting"
                      >
                        执行流程图 <span className="font-normal">↗</span>
                      </button>
                    )}
                    <span className="ml-auto font-mono text-[10px] text-pop-dim">{dur != null ? `用时 ${formatDuration(dur)}` : ""}</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); ctx.openAcceptance() }}
                      className="shrink-0 rounded-[10px] border-[2.5px] border-pop-bd bg-pop-green px-3 py-1 font-mono text-[11px] font-black text-white shadow-pop-sm transition-transform hover:-translate-y-px"
                      data-testid="console-open-acceptance"
                    >
                      → 去验货台验收
                    </button>
                  </header>
                  <div className={closedOf("deliver", "main") ? "hidden" : "space-y-1 px-3 py-2 text-[12px]"}>
                    <div className="flex items-center gap-2">
                      <span className={`font-black ${awaiting.state === "succeeded" ? "text-pop-green" : "text-pop-red"}`}>
                        {awaiting.state === "succeeded" ? "✓ 执行成功" : awaiting.state === "failed" ? "✗ 执行失败" : `○ ${awaiting.state}`}
                      </span>
                      <AggInline agg={agg} className="font-mono" />
                    </div>
                    <div className="font-mono text-[11px] text-pop-dim">实物 · 剧本 · 跑起来看 已就绪 — 点卡片任意处进入</div>
                    {roundError && (
                      <p className="break-words font-mono text-[11px] text-pop-red" data-acceptance-round-error>{roundError}</p>
                    )}
                  </div>
                </section>
              )
            })()}
          </>
        )
      })()}

      {/* 盘上文件（原草稿批次区的执行态替身） */}
      {specPhase && (
        <FoldBox id="files" tag="盘上文件" badge={filesBadge} tail={`批次目录 · ${specPhase.specPath.replace(/^\.\/|\/spec\.md$/g, "")}`} className="bg-pop-paper">
          <FileChips ctx={ctx} phase={specPhase} />
        </FoldBox>
      )}

      {/* 待执行：GOAL + 发射门禁 + 触发 CTA */}
      {ctx.task.status === "ready" && (
        <>
          {goal && (
            <FoldBox id="goal" tag="GOAL" badge={goal.length > 28 ? `${goal.slice(0, 28)}…` : goal}>
              <p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed">{goal}</p>
              {(ctx.task.task_spec?.ac?.length ?? 0) > 0 && (
                <p className="mt-1 font-mono text-[10.5px] text-pop-dim">验收标准 {ctx.task.task_spec!.ac!.length} 条 · 全文见 spec</p>
              )}
            </FoldBox>
          )}
          {gateRows && (
            <FoldBox id="gate" tag="发射门禁 / GATE" badge={`${gateRows.filter((g) => g.ok === true).length}/${gateRows.length} 绿`} tail="服务端闸口为准">
              <div className="space-y-1">
                {gateRows.map((g) => (
                  <div key={g.text} className="flex items-center gap-2 text-[12px]">
                    <span className={`font-black ${g.ok === true ? "text-pop-green" : g.ok === false ? "text-pop-red" : "text-pop-dim"}`}>
                      {g.ok === true ? "✓" : g.ok === false ? "✗" : "…"}
                    </span>
                    <span>{g.text}</span>
                  </div>
                ))}
              </div>
            </FoldBox>
          )}
          {pv === ctx.phaseViews.find((p) => p.status === "pending")
            && !armedFuture && !waitingForSlot && (
            <button
              onClick={ctx.openTrigger}
              className="pop-press flex w-full items-center justify-center gap-2 rounded-xl border-[2.5px] border-pop-bd bg-pop-green px-3 py-2.5 font-mono text-[13px] font-black tracking-[.05em] text-white shadow-pop-sm transition-all hover:bg-pop-green/90"
              data-task-trigger-big
            >
              ⚡ 触发执行 —— P{pv.index} 开跑
            </button>
          )}
        </>
      )}

      {/* 轮次分档（2026-09-19 降噪定稿）：0 轮不渲染；1 轮有卡（LIVE/交付）→ 框整个
          消失（卡即轮）；1 轮已判 → 细条一行；≥2 轮（打回史）→ 账本框才回来。 */}
      {pv.rounds.length >= 2 && (
        <FoldBox id="rounds" tag="轮次 / ROUNDS" badge={`${pv.rounds.length} 轮`} tail={`${pv.rounds.length} 轮`}>
          <div>
            {pv.rounds.map((r) => {
              const exec = ctx.runsById.get(r.exec.id) ?? null
              if (!exec) return null
              return <RoundRow key={r.exec.id} ctx={ctx} meta={{ pv, r }} exec={exec} />
            })}
          </div>
        </FoldBox>
      )}
      {pv.rounds.length === 1 && !liveRound && !awaiting && (() => {
        const r = pv.rounds[0]
        const exec = ctx.runsById.get(r.exec.id) ?? null
        return exec ? (
          <div className="rounded-[9px] border-[1.5px] border-dashed border-pop-bd/35 bg-pop-paper px-2" data-testid={`round-strip-${pv.index}`}>
            <RoundRow ctx={ctx} meta={{ pv, r }} exec={exec} />
          </div>
        ) : null
      })()}

      {(ctx.isLive || ctx.task.status === "awaiting_review") && <SignalBox signals={ctx.signals} events={ctx.events} />}

      <WorkflowViewerDialog taskId={ctx.task.id} workflowRef={pv.workflowRef} open={wfOpen} onOpenChange={setWfOpen} />
    </div>
  )
}

// ── 总战报（done/failed/aborted 默认面 + v3 legacy 面）───────────────

export function ReportSurface({ ctx }: { ctx: RunCtx }) {
  const { detail, totalAgg, task } = ctx
  const runs = detail?.executions ?? []
  const totalRounds = ctx.phaseViews.reduce((a, p) => a + p.rounds.length, 0) || runs.length
  const firstStart = runs.length ? Math.min(...runs.map((r) => r.started_at ? Date.parse(r.started_at) : Date.parse(r.created_at)).filter((n) => !Number.isNaN(n))) : NaN
  const endMs = task.completed_at ? Date.parse(task.completed_at) : ctx.now
  const wallMs = !Number.isNaN(firstStart) ? Math.max(0, endMs - firstStart) : null
  const { ms: runMs, count: runCount } = sumRunMs(runs, ctx.now)
  const models = totalAgg ? Object.entries(totalAgg.modelBreakdown).sort((a, b) => b[1].calls - a[1].calls) : []
  const calls = totalAgg?.totalCalls ?? 0

  const tiles: { v: string; k: string; cls: string; title?: string }[] = [
    {
      v: runCount > 0 ? formatDuration(runMs) : "—",
      k: "实际用时",
      cls: "bg-pop-green-soft",
      title: wallMs != null
        ? `实跑 ${runCount} 轮，不含排队/待验收等待 · 墙钟总跨度 ${formatDuration(wallMs)}`
        : "实跑轮次不含排队/待验收等待",
    },
    { v: totalAgg ? formatCost(totalAgg.totals.cost.usd, totalAgg.totals.cost.complete) : "—", k: "AI 总成本", cls: "bg-pop-yellow-soft" },
    { v: ctx.phaseViews.length > 0 ? `${ctx.phaseViews.filter((p) => p.status === "accepted").length}/${ctx.phaseViews.length}` : `${runs.length}`, k: ctx.phaseViews.length > 0 ? "phase 通过" : "运行数", cls: "bg-pop-cyan-soft" },
    { v: calls > 0 ? String(calls) : "—", k: "LLM 调用", cls: "bg-pop-purple-soft" },
  ]

  return (
    <div className="flex flex-col gap-2.5" data-report-surface>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[15px] font-black">任务战报</h2>
        {ctx.task.task_spec?.format === "v4" && ctx.phaseViews.length > 0 && (
          <span className="font-mono text-[10.5px] text-pop-dim">点左 rail 任意 phase 可回看该阶段全程</span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.k} className={`relative overflow-hidden rounded-xl border-[2.5px] border-pop-bd px-3 py-2 shadow-pop-sm ${t.cls}`} {...(t.title ? { title: t.title } : {})}>
            <div className="font-mono text-[20px] font-black leading-tight tabular-nums">{t.v}</div>
            <div className="font-mono text-[9px] font-bold tracking-[.1em] text-pop-dim">{t.k}</div>
          </div>
        ))}
      </div>

      {models.length > 0 && (
        <FoldBox id="models" tag="模型分布" badge={`${models.length} 模型 · ${totalAgg?.totalCalls ?? 0} 次`} tail={`${totalAgg?.totalCalls ?? 0} 次调用`}>
          <div className="space-y-1.5">
            {models.map(([m, b]) => {
              const share = calls > 0 ? b.calls / calls : 0
              return (
                <div key={m} className="flex items-center gap-2 font-mono text-[11px]">
                  <span className="w-[150px] truncate">{m}</span>
                  <span className="h-[9px] flex-1 overflow-hidden rounded-full border-[1.5px] border-pop-bd bg-pop-idle">
                    <i className="block h-full bg-pop-purple" style={{ width: `${Math.max(4, share * 100)}%` }} />
                  </span>
                  <span className="shrink-0 text-pop-dim">{formatCost(b.costUsd)} · {b.calls}×</span>
                </div>
              )
            })}
          </div>
        </FoldBox>
      )}

      <FoldBox id="ledger" tag="轮次账本（全部）" badge={`${runs.length} 次执行`} tail={runs.length > 0 || ctx.phaseViews.length > 0 ? "↗ 均为新标签页打开" : undefined}>
        {runs.length === 0 && ctx.phaseViews.length === 0 ? (
          <p className="py-0.5 text-[11px] text-pop-dim">任务尚未派发执行。</p>
        ) : (
          <div>
            {/* v4：优先 phase 账本（轮次 chips 带 ✓/✗ 判据）；未被轮次覆盖的
                根运行（辅助流等）按 RUN 行收尾 —— 一个事实只出现一次。 */}
            {(() => {
              const seen = new Set<string>()
              const rows: React.ReactNode[] = []
              for (const pv of ctx.phaseViews) {
                for (const r of pv.rounds) {
                  const exec = ctx.runsById.get(r.exec.id)
                  if (!exec || seen.has(exec.id)) continue
                  seen.add(exec.id)
                  rows.push(<RoundRow key={exec.id} ctx={ctx} meta={{ pv, r }} exec={exec} />)
                }
              }
              for (const e of runs) {
                if (seen.has(e.id)) continue
                rows.push(<RoundRow key={e.id} ctx={ctx} meta={{}} exec={e} />)
              }
              return rows
            })()}
          </div>
        )}
      </FoldBox>

      <ArtifactsCard taskId={task.id} />
    </div>
  )
}
