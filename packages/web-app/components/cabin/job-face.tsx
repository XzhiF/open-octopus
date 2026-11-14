'use client'

// S4 owns this file —— 从 CabinJobDetail 抽出的五页签主体（props 驱动）。
//
// 两种宿主：
//   · variant="window"  —— classic-v3 作业详情窗。DOM/行为与抽取前逐字一致
//     （CabinV3 / CabinModulesP3 是回归闸门），所有 useCabinContext() 的读取
//     都变成了 props。
//   · variant="cockpit" —— 全域座舱的作业面：头部换成 CockpitJobHeader，
//     五页签主体原样复用；页签是受控的（CockpitState 的 tab/URL 同步）。
//
// 数据：GET /api/cabins/:id/jobs/:jid（job + events，10s 轮询）+ listCabinJobs
// （派生 status）；task 类作业再取任务实体（运行/变更/验收都要）。
// 本文件**不读 useCabinContext()**（§3.4 的 critical 修正）。

import { useCallback, useEffect, useState } from 'react'
import {
  Activity, ArrowRight, Bot, GitBranch, ListTodo, MessageSquare, Star, Zap,
} from 'lucide-react'
import { toast } from 'sonner'
import type { CabinAttentionItem, CabinJob, CabinJobEvent } from '@octopus/shared'
import {
  getCabinJob, getCabinUsage, listCabinJobs, noteCabinJob, setCabinFocus, setCabinJobPriority,
  type CabinJobView,
} from '@/lib/cabin-api'
import { abortTask, getTask, pauseTask, resumeTask, type TaskDetail } from '@/lib/tasks-api'
import { useBillingCurrency } from '@/lib/billing-currency'
import { formatCost } from '@/lib/format'
import { cn } from '@/lib/utils'
import { SubagentWindow } from '@/components/chat-workbench/subagent-window'
import { ChangesWindow } from '@/components/chat-workbench/changes-window'
import { AcceptanceWindow } from '@/components/chat-workbench/acceptance-window'
import { CabinRunSummary, type CabinRunTarget } from './modules/CabinRunSummary'
import { clockLabel } from './modules/ui'
import { pctFromPhases } from './job-progress'
import { isEndedJob, jobStatusLabel, jobTone } from './job-status'
import { traceKind } from './trace-meta'
import {
  COCKPIT_TABS, COCKPIT_TAB_LABELS, type CockpitTab,
} from '@/components/cockpit/state/cockpit-state'
import {
  CockpitElapsed, CockpitJobHeader, TaskRunActions, tabForAttentionStage,
} from '@/components/cockpit/face/CockpitJobHeader'

const KIND_META = {
  task: { label: '任务', icon: ListTodo, tone: 'text-pop-cyan border-pop-cyan/40' },
  workflow: { label: '工作流', icon: GitBranch, tone: 'text-pop-violet border-pop-violet/40' },
  subagent: { label: '子代理', icon: Bot, tone: 'text-pop-purple border-pop-purple/40' },
} as const

function summaryOf(event: CabinJobEvent): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>
  for (const key of ['summary', 'text', 'message', 'reason', 'detail', 'prompt', 'stage']) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

function shortId(value: string | null | undefined): string | null {
  if (!value) return null
  return value.slice(0, 8)
}

/** 仅 cockpit 需要的面级数据/控件（window 不传）。 */
export interface JobFaceCockpitControls {
  /** 舱名（由 CockpitFace 从 fleet 行带下来；缺省时行2 省略该段）。 */
  cabinName?: string | null
  /** 本作业的 attention（fleet 已按 job_id 合并；没有就不显示「去处理」）。 */
  attention?: CabinAttentionItem | null
  tab: CockpitTab
  onTabChange(tab: CockpitTab): void
  /** 关闭 = 收面（select(null)）。 */
  onClose(): void
  /** 验收通过/打回后（CockpitFace 用来落下一行「需要你」）。 */
  onAcceptanceMutated?(): void
}

export interface JobFaceProps {
  cabinId: string
  cabinVersion: number
  workspaceId: string | null
  jobId: string
  variant: 'window' | 'cockpit'
  /** 判断「对接」页签是否可投递；跨舱（≠ cabinId）时隐藏「去主对话」。 */
  entryCabinId: string
  onMutated?: () => void
  /** 旧窗：舱主会话（subagent 运行现场的回退，旧行为逐字保留）。 */
  mainSessionId?: string | null
  /** 旧窗：当前聚焦作业。undefined = 舱还没加载完（聚焦按钮点了不生效）。 */
  focusedJobId?: string | null
  cockpit?: JobFaceCockpitControls
}

export function JobFace({
  cabinId,
  cabinVersion,
  workspaceId,
  jobId,
  variant,
  entryCabinId,
  onMutated,
  mainSessionId,
  focusedJobId,
  cockpit,
}: JobFaceProps) {
  const controlled = variant === 'cockpit' && !!cockpit
  const [job, setJob] = useState<CabinJob | null>(null)
  const [jobView, setJobView] = useState<CabinJobView | null>(null)
  const [events, setEvents] = useState<CabinJobEvent[]>([])
  const [innerTab, setInnerTab] = useState<CockpitTab>('overview')
  const [noteOpen, setNoteOpen] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [taskEntity, setTaskEntity] = useState<TaskDetail | null>(null)
  const [usageCost, setUsageCost] = useState<{ usd: number; complete: boolean } | null>(null)

  const tab: CockpitTab = controlled && cockpit ? cockpit.tab : innerTab
  const changeTab = useCallback((next: CockpitTab) => {
    if (!controlled) setInnerTab(next)
    cockpit?.onTabChange(next)
  }, [controlled, cockpit])

  const load = useCallback(async () => {
    try {
      const [detail, list] = await Promise.all([
        getCabinJob(cabinId, jobId),
        listCabinJobs(cabinId),
      ])
      setJob(detail.job)
      setEvents(detail.events)
      setJobView(list.find((j) => j.id === jobId) ?? null)
    } catch {
      /* 保留上一份快照 */
    }
  }, [cabinId, jobId])

  useEffect(() => {
    setJob(null)
    setJobView(null)
    setEvents([])
    setNoteOpen(false)
    // 旧窗行为：换作业回到概览。cockpit 的页签是受控的（URL 决定），不重置。
    if (!controlled) setInnerTab('overview')
    void load()
  }, [load, controlled])

  // ── 本作业消耗（只有 cockpit 头部要 ¥；旧窗不多打一个请求）──────────
  const currency = useBillingCurrency()
  const loadUsage = useCallback(async () => {
    if (variant !== 'cockpit') return
    try {
      const payload = await getCabinUsage(cabinId)
      const row = payload.byJob.find((entry) => entry.job_id === jobId)
      if (row && row.totals.cost.usd != null) {
        setUsageCost({ usd: row.totals.cost.usd, complete: row.totals.cost.complete })
        return
      }
      const subagent = payload.subagents.runs.find((entry) => entry.job_id === jobId)
      setUsageCost(
        subagent && subagent.cost.usd != null
          ? { usd: subagent.cost.usd, complete: subagent.cost.complete }
          : null,
      )
    } catch {
      setUsageCost(null) // 拿不到就省略该段（不写 0 / --）
    }
  }, [variant, cabinId, jobId])

  useEffect(() => {
    void loadUsage()
    const timer = window.setInterval(() => {
      void load()
      void loadUsage()
    }, 10_000)
    return () => window.clearInterval(timer)
  }, [load, loadUsage])

  // 运行/变更/验收都要任务实体（RunWindow 自己解析当前轮）。
  const taskId = job?.kind === 'task' ? job.ref_id : null
  useEffect(() => {
    let alive = true
    setTaskEntity(null)
    if (!taskId) return
    getTask(taskId).then(
      (t) => { if (alive) setTaskEntity(t) },
      () => { /* 任务可能已删 */ },
    )
    return () => { alive = false }
  }, [taskId])

  const bump = async () => {
    if (!job) return
    setBusy('priority')
    try {
      await setCabinJobPriority(cabinId, job.id, (jobView?.priority ?? job.priority) + 1)
      toast.success(`已提优先 · P${(jobView?.priority ?? job.priority) + 1}`)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '提优先失败')
    } finally {
      setBusy(null)
    }
  }

  const toggleFocus = async () => {
    if (!job) return
    if (focusedJobId === undefined) return // 舱还没加载完：旧行为就是静默不动
    setBusy('focus')
    try {
      const focused = focusedJobId === job.id
      await setCabinFocus(cabinId, cabinVersion, focused ? null : job.id)
      toast.success(focused ? '已退出聚焦' : `已聚焦「${job.title}」`)
      onMutated?.()
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '聚焦失败')
    } finally {
      setBusy(null)
    }
  }

  const saveNote = async () => {
    if (!job) return
    const text = note.trim()
    if (!text) return
    try {
      await noteCabinJob(cabinId, job.id, text)
      setNote('')
      setNoteOpen(false)
      await load()
      toast.success('备注已落到 trace')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '备注失败')
    }
  }

  /** task 类作业的暂停/恢复/中止：只用 lib/tasks-api 现有函数。 */
  const runTaskAction = async (action: 'pause' | 'resume' | 'abort') => {
    if (!taskId) return
    setBusy(action)
    try {
      if (action === 'pause') await pauseTask(taskId)
      else if (action === 'resume') await resumeTask(taskId)
      else await abortTask(taskId)
      toast.success(
        action === 'pause' ? '已暂停这一轮' : action === 'resume' ? '已继续运行' : '已中止任务',
      )
      await load()
      onMutated?.()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBusy(null)
    }
  }

  const cockpitMode = variant === 'cockpit'
  const onClose = cockpit?.onClose ?? (() => {})

  if (!job) {
    if (cockpitMode) {
      return (
        <>
          <CockpitJobHeader loading onClose={onClose} />
          <div className="ck12-face-body">
            <div className="ck12-face-empty" data-testid="cockpit-face-job">载入作业…</div>
          </div>
        </>
      )
    }
    return <div className="grid h-full min-h-40 place-items-center text-[12px] text-pop-dim">载入作业…</div>
  }

  const kind = KIND_META[job.kind]
  const KindIcon = kind.icon
  const status = jobView?.status
  const tone = jobTone(status)
  const taskForRun = job.kind === 'task' ? taskEntity : null
  const subagentRun = job.kind === 'subagent' && !!job.ref_id

  // 运行 tab 只给摘要；「打开运行 →」开作业坞同款运行窗（DAG + 日志 + YAML）。
  // 任务类作业取当前一轮执行（运行中的优先，否则最新一轮）。
  const runTarget: CabinRunTarget | null = (() => {
    if (job.kind === 'workflow') {
      if (!job.ref_id || !workspaceId) return null
      return { executionId: job.ref_id, workspaceId, title: job.title, status }
    }
    if (job.kind !== 'task' || !taskEntity) return null
    const executions = taskEntity?.executions ?? []
    const current = executions.find((e) => ['pending', 'running', 'paused'].includes(e.status)) ?? executions[0]
    if (!current) return null
    return {
      executionId: current.id,
      workspaceId: current.workspace_id,
      title: job.title,
      workflowRef: current.workflow_ref,
      phaseIndex: current.phase_index,
      roundIndex: current.round_index,
      status: current.status,
      taskId: taskEntity.id,
    }
  })()

  const timeline = [...events].sort((a, b) => a.created_at.localeCompare(b.created_at))
  const userIn = timeline.filter((e) => e.kind === 'human_input')
  const outbound = timeline.filter((e) => ['dispatch', 'note', 'resume'].includes(e.kind))
  const inbound = timeline.filter((e) => ['report', 'attention', 'handback'].includes(e.kind))
  const mandate = job.mandate

  // 概览右栏的真实读数：v4 phaseViews 才有进度（没有就不画条、不写 %）。
  const phaseViews = taskEntity?.derived?.phaseViews ?? []
  const pct = pctFromPhases(phaseViews)
  const acceptedPhases = phaseViews.filter((phase) => phase.status === 'accepted').length
  const priorityLabel = `P${jobView?.priority ?? job.priority}`
  const jobStatusText = jobStatusLabel(status)

  // ── cockpit 头部派生（§1.5，缺就省略）────────────────────────────────
  const lastEvent = timeline[timeline.length - 1]
  // 「在做」只写真实发生的事：最近事件摘要 → attention 标题；都没有就省略
  // （不要再回退成状态文案——行1 已经显示状态了，重复一次是噪音）。
  const doing = (lastEvent ? summaryOf(lastEvent) : '') || cockpit?.attention?.title || null
  const branch = job.kind === 'task' ? (taskEntity?.task_spec?.branch ?? null) : null
  const executor = shortId(job.session_id ?? job.ref_id)
  const costLabel = usageCost ? formatCost(usageCost.usd, usageCost.complete, currency) : null
  const goTab = cockpit?.attention ? tabForAttentionStage(cockpit.attention.stage) : null

  const cockpitActions = (
    <>
      {job.kind === 'task' && (
        <TaskRunActions
          status={status}
          busy={busy}
          onPause={() => { void runTaskAction('pause') }}
          onResume={() => { void runTaskAction('resume') }}
          onAbort={() => { void runTaskAction('abort') }}
        />
      )}
      {job.kind === 'workflow' && (
        <button
          type="button"
          className="ck12-jh-btn"
          data-testid="cockpit-job-open-run"
          onClick={() => changeTab('run')}
        >
          看运行 →
        </button>
      )}
      {job.kind === 'subagent' && (
        <button
          type="button"
          className="ck12-jh-btn"
          data-testid="cockpit-job-open-subagent"
          onClick={() => changeTab('run')}
        >
          子代理 →
        </button>
      )}
    </>
  )

  const panes = (
    <>
      {tab === 'overview' && (cockpitMode ? (
        // 全域概览（v12 .sgrid.jg-over）：左「汐音 ↔ 作业」事件轨迹，右「作业状态」
        // 读数（状态 / 进度 / 耗时 / 消耗 / 优先 + 舱/执行者/分支 + 派发授权）。
        // 每个数都来自真字段；phaseViews 缺失时进度整段不画。
        <div data-testid="cabin-job-overview" className="ck12-sgrid ck12-jg-over">
          <section className="ck12-pane">
            <header className="ck12-pane-h">
              <b>汐音 ↔ 作业</b>
              <span className="ck12-pane-tag">{timeline.length} EVENTS</span>
            </header>
            <div className="ck12-pane-b is-tight">
              {timeline.length === 0 ? (
                <div className="ck12-face-empty">还没有事件 · 派发后这里留痕</div>
              ) : (
                <div className="ck12-jtl">
                  {timeline.map((event) => {
                    const k = traceKind(event.kind)
                    const text = summaryOf(event) || k.label
                    return (
                      <div
                        key={event.id}
                        className="ck12-jrow"
                        data-testid={`cabin-job-event-${event.id}`}
                      >
                        <i className={cn('ck12-jrow-d', k.dot)} aria-hidden="true" />
                        <span className="ck12-jrow-t">{clockLabel(event.created_at)}</span>
                        <span className="ck12-jrow-a" title={event.actor ?? undefined}>
                          {event.actor ?? '—'}
                        </span>
                        <span className="ck12-jrow-k">{k.label}</span>
                        <span className="ck12-jrow-x" title={text}>{text}</span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </section>

          <section className="ck12-pane">
            <header className="ck12-pane-h">
              <b>作业状态</b>
              <span className="ck12-pane-tag" data-tone={tone}>{jobStatusText}</span>
            </header>
            <div className="ck12-pane-b is-tight">
              <div className="ck12-jstats">
                <div className="ck12-jstat">
                  <div className="l">状态</div>
                  <div className="v">{jobStatusText}</div>
                </div>
                {pct !== null && (
                  <div className="ck12-jstat">
                    <div className="l">进度</div>
                    <div className="v is-cyan">{pct}%</div>
                  </div>
                )}
                <div className="ck12-jstat">
                  <div className="l">耗时</div>
                  <div className="v"><CockpitElapsed start={job.created_at} end={job.ended_at} /></div>
                </div>
                {costLabel && (
                  <div className="ck12-jstat">
                    <div className="l">消耗</div>
                    <div className="v is-amber">{costLabel}</div>
                  </div>
                )}
                <div className="ck12-jstat">
                  <div className="l">优先</div>
                  <div className="v">{priorityLabel}</div>
                </div>
              </div>

              {(cockpit?.cabinName || executor || branch || jobView?.iteration_code) && (
                <div className="ck12-jfacts">
                  {cockpit?.cabinName && <span>舱 <b>{cockpit.cabinName}</b></span>}
                  {executor && <span>执行者 <b>{executor}</b></span>}
                  {branch && <span>分支 <b>{branch}</b></span>}
                  {jobView?.iteration_code && <span>迭代 <b>{jobView.iteration_code}</b></span>}
                </div>
              )}

              {pct !== null && (
                <div className="ck12-jbar2" aria-hidden="true">
                  <i style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
                </div>
              )}

              {phaseViews.length > 0 && (
                <div className="ck12-jchips">
                  <span>阶段 <b>{acceptedPhases}/{phaseViews.length}</b></span>
                  <span>类型 <b>{kind.label}</b></span>
                </div>
              )}

              {(mandate || job.prompt) && (
                <div className="ck12-jmandate">
                  <div className="h">
                    <b>派发授权</b>
                    {mandate && <span className="k">{mandate.strength}</span>}
                    {mandate?.scope && <span>scope: {mandate.scope}</span>}
                  </div>
                  {job.prompt && <p>{job.prompt}</p>}
                </div>
              )}
            </div>
          </section>
        </div>
      ) : (
        <div data-testid="cabin-job-overview">
          {(mandate || job.prompt) && (
            <div className="mb-2.5 rounded-lg border-[1.5px] border-pop-bd bg-pop-idle px-3 py-2">
              <div className="mb-1 flex flex-wrap items-center gap-2 text-[10px] text-pop-dim">
                <span className="font-bold text-pop-ink">派发授权</span>
                {mandate && <span className="rounded border border-pop-bd px-1.5 py-px font-mono text-[9px]">{mandate.strength}</span>}
                {mandate?.scope && <span className="truncate">scope: {mandate.scope}</span>}
              </div>
              {job.prompt && <div className="text-[11px] leading-relaxed text-pop-dim">{job.prompt}</div>}
            </div>
          )}
          {timeline.length === 0 ? (
            <div className="rounded-lg border-[1.5px] border-dashed border-pop-bd p-6 text-center text-[11.5px] text-pop-dim">
              还没有事件 · 派发后这里留痕
            </div>
          ) : (
            <ol className="relative space-y-1 border-l border-pop-bd/70 pl-3">
              {timeline.map((event) => {
                const k = traceKind(event.kind)
                return (
                  <li key={event.id} className="relative" data-testid={`cabin-job-event-${event.id}`}>
                    <i className={cn('absolute -left-[17px] top-2 size-2 rounded-full', k.dot)} />
                    <div className="flex items-start gap-2 rounded-lg border border-pop-bd bg-pop-idle px-2.5 py-1.5">
                      <span className="shrink-0 font-mono text-[9.5px] text-pop-dim">{clockLabel(event.created_at)}</span>
                      <span className={cn(
                        'shrink-0 rounded px-1.5 py-px text-[9px] font-bold',
                        'bg-white/[0.06] text-pop-dim',
                      )}>{k.label}</span>
                      <span className="min-w-0 flex-1 text-[11px] text-pop-ink">
                        {summaryOf(event) || k.label}
                        {event.actor && <span className="ml-1.5 text-[9.5px] text-pop-dim">· {event.actor}</span>}
                      </span>
                    </div>
                  </li>
                )
              })}
            </ol>
          )}
        </div>
      ))}

      {tab === 'relay' && (
        <div data-testid="cabin-job-relay">
          <div className="mb-2 flex items-center gap-1.5 text-[10px] text-pop-dim">
            <span className="rounded border border-pop-cyan/40 px-1.5 py-px text-pop-cyan">你</span>
            <ArrowRight className="size-2.5" />
            <span className="rounded border border-pop-pink/40 px-1.5 py-px text-pop-pink">汐音</span>
            <ArrowRight className="size-2.5" />
            <span className="rounded border border-pop-violet/40 px-1.5 py-px text-pop-violet">执行者</span>
            {/* 跨舱只读：投递只对入口舱开放，不给用户「能投到别的舱」的错觉。 */}
            {cabinId === entryCabinId && (
              <button
                type="button"
                data-testid="cockpit-relay-main-chat"
                onClick={() => window.dispatchEvent(new CustomEvent('octopus:cabin-main-chat'))}
                className="ml-auto inline-flex items-center gap-1 text-[10px] text-pop-cyan hover:underline"
              >
                <MessageSquare className="size-3" />去主对话
              </button>
            )}
          </div>
          <div className="grid gap-2 md:grid-cols-3">
            <div className="rounded-lg border border-pop-cyan/30 bg-pop-cyan/[0.04] p-2.5">
              <div className="mb-1.5 text-[10px] font-bold text-pop-cyan">你 → 汐音</div>
              <div className="text-[11px] leading-relaxed text-pop-ink">
                {job.prompt || '（派发时没有留下原文）'}
              </div>
              {mandate && (
                <div className="mt-1.5 font-mono text-[9.5px] text-pop-dim">
                  {mandate.strength}{mandate.basis ? ` · ${mandate.basis}` : ''}
                </div>
              )}
              {userIn.length > 0 && (
                <ul className="mt-1.5 space-y-1 border-t border-pop-cyan/20 pt-1.5">
                  {userIn.map((e) => (
                    <li key={e.id} className="text-[10.5px] leading-relaxed text-pop-dim">
                      <span className="mr-1 font-mono text-[9px]">{clockLabel(e.created_at)}</span>
                      {summaryOf(e) || traceKind(e.kind).label}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="rounded-lg border border-pop-pink/30 bg-pop-pink/[0.04] p-2.5">
              <div className="mb-1.5 text-[10px] font-bold text-pop-pink">汐音 → 执行者</div>
              {outbound.length === 0 ? <div className="text-[10.5px] text-pop-dim">暂无派发事件</div> : (
                <ul className="space-y-1">
                  {outbound.map((e) => (
                    <li key={e.id} className="text-[10.5px] leading-relaxed text-pop-ink">
                      <span className="mr-1 font-mono text-[9px] text-pop-dim">{clockLabel(e.created_at)}</span>
                      {summaryOf(e) || traceKind(e.kind).label}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="rounded-lg border border-pop-violet/30 bg-pop-violet/[0.04] p-2.5">
              <div className="mb-1.5 text-[10px] font-bold text-pop-violet">执行者 → 汐音</div>
              {inbound.length === 0 ? <div className="text-[10.5px] text-pop-dim">还没有回报</div> : (
                <ul className="space-y-1">
                  {inbound.map((e) => (
                    <li key={e.id} className="text-[10.5px] leading-relaxed text-pop-ink">
                      <span className="mr-1 font-mono text-[9px] text-pop-dim">{clockLabel(e.created_at)}</span>
                      {summaryOf(e) || traceKind(e.kind).label}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      {tab === 'run' && (
        <div data-testid="cabin-job-run">
          {job.kind === 'subagent' ? (
            subagentRun ? (
              <div className="h-[500px] overflow-hidden rounded-lg border-[1.5px] border-pop-bd">
                <SubagentWindow
                  sessionId={job.session_id ?? mainSessionId ?? null}
                  agentId={job.ref_id}
                />
              </div>
            ) : (
              <div className="rounded-lg border-[1.5px] border-dashed border-pop-bd p-6 text-center text-[11.5px] text-pop-dim">
                这条作业还没有可看的运行现场（缺子代理）
              </div>
            )
          ) : runTarget ? (
            <CabinRunSummary target={runTarget} />
          ) : (
            <div className="rounded-lg border-[1.5px] border-dashed border-pop-bd p-6 text-center text-[11.5px] text-pop-dim">
              {job.kind === 'task' && taskForRun
                ? '这一轮还没有执行 · 跑起来后这里给执行摘要'
                : '这条作业还没有可看的运行现场（缺执行 / 任务）'}
            </div>
          )}
        </div>
      )}

      {tab === 'changes' && (
        <div data-testid="cabin-job-changes">
          {taskForRun ? (
            <div className="h-[500px] overflow-hidden rounded-lg border-[1.5px] border-pop-bd bg-pop-paper">
              <ChangesWindow task={taskForRun} />
            </div>
          ) : (
            <div className="rounded-lg border-[1.5px] border-dashed border-pop-bd p-6 text-center text-[11.5px] text-pop-dim">
              {cockpitMode ? `这条${kind.label}作业没有交付变更账本` : '只有任务类作业有变更账本'}
            </div>
          )}
        </div>
      )}

      {tab === 'accept' && (
        <div data-testid="cabin-job-accept">
          {taskForRun ? (
            <div className="max-h-[520px] overflow-y-auto rounded-lg border-[1.5px] border-pop-bd bg-pop-paper">
              <AcceptanceWindow
                task={taskForRun}
                onMutated={() => {
                  onMutated?.()
                  cockpit?.onAcceptanceMutated?.()
                  void load()
                }}
                onOpenChanges={() => changeTab('changes')}
              />
            </div>
          ) : (
            <div className="rounded-lg border-[1.5px] border-dashed border-pop-bd p-6 text-center text-[11.5px] text-pop-dim">
              {cockpitMode ? `这条${kind.label}作业没有交付验收单` : '只有任务类作业可验收'}
            </div>
          )}
        </div>
      )}
    </>
  )

  if (cockpitMode) {
    return (
      <>
        <CockpitJobHeader
          kind={job.kind}
          title={job.title}
          status={status}
          tab={tab}
          onTabChange={changeTab}
          onClose={onClose}
          branch={branch}
          doing={doing}
          executor={executor}
          cabinName={cockpit?.cabinName ?? null}
          startedAt={job.created_at}
          endedAt={job.ended_at}
          costLabel={costLabel}
          onGoHandle={goTab ? () => changeTab(goTab) : undefined}
          actions={cockpitActions}
        />
        <div className="ck12-face-body" data-testid="cockpit-face-job">{panes}</div>
      </>
    )
  }

  // ── 旧窗（DOM/行为逐字不变）──────────────────────────────────────────
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="cabin-job-detail">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className={cn('inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9.5px] font-bold', kind.tone)}>
          <KindIcon className="size-2.5" />{kind.label}
        </span>
        <b className="min-w-0 truncate text-[13px] text-pop-ink">{job.title}</b>
        <span className={cn(
          'inline-flex items-center gap-1 rounded-full px-2 py-px text-[9.5px] font-bold',
          tone === 'run' ? 'bg-pop-green/15 text-pop-green'
            : tone === 'wait' ? 'bg-pop-amber/15 text-pop-amber'
              : tone === 'blocked' ? 'bg-pop-red/15 text-pop-red'
                : 'bg-white/[0.06] text-pop-dim',
        )}>
          <i className={cn('size-1.5 rounded-full', {
            run: 'bg-pop-green', wait: 'bg-pop-amber', blocked: 'bg-pop-red', ended: 'bg-pop-dim', idle: 'bg-pop-dim',
          }[tone])} />
          {jobStatusLabel(status)}
        </span>
        {jobView?.iteration_code && <span className="font-mono text-[10px] text-pop-dim">{jobView.iteration_code}</span>}
        {jobView?.transport && <span className="font-mono text-[10px] text-pop-dim">· {jobView.transport}</span>}
        <span className="ml-auto flex shrink-0 flex-wrap gap-1.5">
          <button
            type="button"
            disabled={busy === 'priority' || isEndedJob(status)}
            onClick={() => { void bump() }}
            data-testid="cabin-job-priority"
            className="inline-flex items-center gap-1 rounded-md border-[1.5px] border-pop-bd px-2 py-1 text-[10.5px] text-pop-dim transition-colors hover:text-pop-ink disabled:opacity-40"
          >
            <Zap className="size-3" />提优先 P{(jobView?.priority ?? job.priority)}
          </button>
          <button
            type="button"
            disabled={busy === 'focus' || isEndedJob(status)}
            onClick={() => { void toggleFocus() }}
            data-testid="cabin-job-focus"
            className={cn(
              'inline-flex items-center gap-1 rounded-md border-[1.5px] px-2 py-1 text-[10.5px] transition-colors disabled:opacity-40',
              focusedJobId === job.id
                ? 'border-pop-violet bg-pop-violet/10 text-pop-violet'
                : 'border-pop-bd text-pop-dim hover:text-pop-ink',
            )}
          >
            <Star className="size-3" />{focusedJobId === job.id ? '聚焦中' : '聚焦'}
          </button>
          <button
            type="button"
            onClick={() => setNoteOpen((v) => !v)}
            data-testid="cabin-job-note"
            className="inline-flex items-center gap-1 rounded-md border-[1.5px] border-pop-bd px-2 py-1 text-[10.5px] text-pop-dim transition-colors hover:text-pop-ink"
          >
            <Activity className="size-3" />备注
          </button>
        </span>
      </div>

      {noteOpen && (
        <div className="mb-2 flex items-center gap-2" data-testid="cabin-job-note-row">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void saveNote() }}
            placeholder="给这条作业记一笔（落 cabin_job_events）"
            className="h-7 flex-1 rounded-md border border-pop-bd bg-pop-bg px-2 text-[11.5px] text-pop-ink outline-none focus:border-pop-pink/60"
          />
          <button
            type="button"
            onClick={() => { void saveNote() }}
            disabled={!note.trim()}
            className="rounded-md border-[1.5px] border-pop-bd px-2 py-1 text-[11px] text-pop-dim hover:text-pop-ink disabled:opacity-40"
          >
            记一笔
          </button>
        </div>
      )}

      <div className="mb-2.5 flex shrink-0 gap-1 border-b-[1.5px] border-pop-bd" role="tablist">
        {COCKPIT_TABS.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            data-testid={`cabin-job-tab-${key}`}
            onClick={() => changeTab(key)}
            className={cn(
              '-mb-[1.5px] border-b-2 px-3 py-1.5 text-[12px] transition-colors',
              tab === key
                ? 'border-pop-pink font-semibold text-pop-ink'
                : 'border-transparent text-pop-dim hover:text-pop-ink',
            )}
          >
            {COCKPIT_TAB_LABELS[key]}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1">{panes}</div>
    </div>
  )
}
