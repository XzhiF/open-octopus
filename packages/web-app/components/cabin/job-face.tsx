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
import type { CabinAttentionItem, CabinJob, CabinJobEvent, CabinJobKind } from '@octopus/shared'
import {
  getCabinJob, getCabinUsage, listCabinJobs, noteCabinJob, setCabinFocus, setCabinJobPriority,
  type CabinJobView,
} from '@/lib/cabin-api'
import { abortTask, getTask, pauseTask, resumeTask, type TaskDetail } from '@/lib/tasks-api'
import { withDeadline } from '@/lib/with-deadline'
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

/** 作业面（详情 + 派生状态）的单请求预算：接口吊死时给出错误与重试，
 *  不能永远停在「载入作业…」（2026-11-14 用户）。 */
export const JOB_FACE_TIMEOUT_MS = 8_000

const KIND_META = {
  task: { label: '任务', icon: ListTodo, tone: 'text-pop-cyan border-pop-cyan/40' },
  workflow: { label: '工作流', icon: GitBranch, tone: 'text-pop-violet border-pop-violet/40' },
  subagent: { label: '子代理', icon: Bot, tone: 'text-pop-purple border-pop-purple/40' },
} as const

// 「对接」页签的三个角色：你 / 汐音 / 执行者。方向由事件类型决定，
// 不靠 actor 猜（actor 只用于展示，事件类型才是协议事实）。
type RelayRole = 'you' | 'xiyin' | 'doer'

const RELAY_ROLE: Record<RelayRole, { label: string }> = {
  you: { label: '你' },
  xiyin: { label: '汐音' },
  doer: { label: '执行者' },
}

/** 事件类型 → 交接方向（人输入：你→汐音；派发类：汐音→执行者；回报类：执行者→汐音）。 */
function relayRoute(kind: string): [RelayRole, RelayRole] {
  if (kind === 'human_input') return ['you', 'xiyin']
  if (kind === 'report' || kind === 'attention' || kind === 'handback') return ['doer', 'xiyin']
  return ['xiyin', 'doer']
}

/** human_input 里的「提优先」事件：payload = { action: 'priority', priority }。 */
function priorityOf(event: CabinJobEvent): number | null {
  const payload = event.payload as Record<string, unknown> | null
  return payload && payload.action === 'priority' && typeof payload.priority === 'number'
    ? payload.priority
    : null
}

/** 时间线一行的正文：优先写明「做了什么」，而不是重复类型标签「人输入」。 */
function relayText(event: CabinJobEvent): string {
  const priority = priorityOf(event)
  if (priority !== null) return `提优先 → P${priority}`
  return summaryOf(event) || traceKind(event.kind).label
}

/** 连续的「提优先」折叠成一条（P2 → P6 · 5 次）：它们是一串同义操作，
 *  逐条铺开只会把真正的一次交接挤出屏幕。其余事件互不合并。 */
interface RelayGroup {
  key: string
  first: CabinJobEvent
  last: CabinJobEvent
  count: number
}

function groupRelay(timeline: readonly CabinJobEvent[]): RelayGroup[] {
  const groups: RelayGroup[] = []
  for (const event of timeline) {
    const prev = groups[groups.length - 1]
    if (priorityOf(event) !== null && prev && priorityOf(prev.last) !== null) {
      prev.last = event
      prev.count += 1
      continue
    }
    groups.push({ key: event.id, first: event, last: event, count: 1 })
  }
  return groups
}

/** 超时类失败才有「连接被占满」的提示（其它失败原因不同，不要误导）。 */
function isTimeoutMessage(message: string): boolean {
  return message.includes('超时')
}

/** 载入态的自证：秒数在走 = 页面与计时器都还活着；秒数停住才说明真卡死。
 *  配合 JOB_FACE_TIMEOUT_MS（到点必出「失败 + 重试」），用户永远能区分
 *  「还在载入」和「已经放弃了」。 */
function LoadingElapsed({ label, testId }: { label: string; testId?: string }) {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      setSeconds(Math.floor((Date.now() - startedAt) / 1000))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [])
  return (
    <span className="flex items-center gap-1" data-testid={testId}>
      {label}…<span className="opacity-60">已 {seconds}s</span>
    </span>
  )
}

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
  /** 编队行里**已经**有的作业摘要：详情接口回来之前就拿它画头部。
   *  没有它时载入态只能写「载入作业…」——用户分不清「哪件作业在载入」和
   *  「卡住了」（2026-11-14 用户）。 */
  hint?: { title: string; kind: CabinJobKind; status?: string | null } | null
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
  const [loadError, setLoadError] = useState<string | null>(null)
  /** 对接页签：派发原文默认收 3 行（原文往往是整段需求）。 */
  const [promptOpen, setPromptOpen] = useState(false)

  const tab: CockpitTab = controlled && cockpit ? cockpit.tab : innerTab
  const changeTab = useCallback((next: CockpitTab) => {
    if (!controlled) setInnerTab(next)
    cockpit?.onTabChange(next)
  }, [controlled, cockpit])

  const load = useCallback(async () => {
    // 详情是**唯一**的面级关键路径：它回来就能整面渲染（标题/事件/页签）。
    // 派生状态（status/priority/transport）来自整舱作业列表，只是锦上添花 ——
    // 单独预算、失败不挡详情。旧的 Promise.all 会把两条绑在一起：列表一慢，
    // 详情明明已经到了，面还在「载入作业…」（2026-11-14 用户）。
    let detail: { job: CabinJob; events: CabinJobEvent[] }
    try {
      detail = await withDeadline(null, JOB_FACE_TIMEOUT_MS, '作业详情', (s) => getCabinJob(cabinId, jobId, s))
    } catch (err) {
      // 保留上一份快照；没有快照时界面显示这句原因 + 重试。
      setLoadError(err instanceof Error ? err.message : '作业加载失败')
      return
    }
    setJob(detail.job)
    setEvents(detail.events)
    setLoadError(null)
    try {
      const list = await withDeadline(null, JOB_FACE_TIMEOUT_MS, '作业列表', (s) => listCabinJobs(cabinId, s))
      setJobView(list.find((j) => j.id === jobId) ?? null)
    } catch {
      // 列表没回来：沿用上一份 jobView（没有就省略派生读数，不猜、不挡面）。
    }
  }, [cabinId, jobId])

  useEffect(() => {
    setJob(null)
    setJobView(null)
    setEvents([])
    setNoteOpen(false)
    setLoadError(null)
    // 旧窗行为：换作业回到概览。cockpit 的页签是受控的（URL 决定），不重置。
    if (!controlled) setInnerTab('overview')
    void load()
  }, [load, controlled])

  // ── 本作业消耗（只有 cockpit 头部要 ¥；旧窗不多打一个请求）──────────
  const currency = useBillingCurrency()
  const loadUsage = useCallback(async () => {
    if (variant !== 'cockpit') return
    try {
      const payload = await withDeadline(null, JOB_FACE_TIMEOUT_MS, '作业消耗', (s) => getCabinUsage(cabinId, s))
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
    withDeadline(null, JOB_FACE_TIMEOUT_MS, '任务实体', (s) => getTask(taskId, s)).then(
      (t) => { if (alive) setTaskEntity(t) },
      () => { /* 任务可能已删 / 请求吊死：运行·变更·验收退回明确空态，不挡面 */ },
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
  // 全域作业面：五个页签**统一等高**（面体高度固定，内容撑满它）——
  // 否则空页签矮、满页签高，切换时整块面跳高度（2026-11-15 用户）。
  // 旧窗变体保持原样（它有自己固定的 500 / 520px 窗格）。
  const frameOf = (extra?: string) => (cockpitMode ? cn('ck12-tab', extra) : extra)
  const fillOf = (fallback?: string) => (cockpitMode ? 'ck12-tabfill' : fallback)
  const emptyOf = (extra?: string) =>
    cn(
      'rounded-lg border-[1.5px] border-dashed border-pop-bd p-6 text-center text-[11.5px] text-pop-dim',
      cockpitMode && 'ck12-tabfill grid place-items-center',
      extra,
    )

  if (!job) {
    const retry = (
      <button
        type="button"
        className="ck12-rail-retry"
        data-testid="cockpit-face-job-retry"
        onClick={() => { setLoadError(null); void load() }}
      >重试</button>
    )
    if (cockpitMode) {
      const hint = cockpit?.hint ?? null
      return (
        <>
          {/* 有编队行摘要就先画真实头部（类型/标题/状态/页签）：用户点的是
              「这一件作业」，载入中也必须能看见是哪一件，而不是一行占位。
              没有摘要（窗口变体/深链）才退回占位标题。 */}
          {hint ? (
            <CockpitJobHeader
              kind={hint.kind}
              title={hint.title}
              status={hint.status ?? null}
              tab={tab}
              onTabChange={changeTab}
              onClose={onClose}
              cabinName={cockpit?.cabinName ?? null}
            />
          ) : (
            <CockpitJobHeader loading onClose={onClose} />
          )}
          <div className="ck12-face-body">
            {loadError ? (
              <div className="ck12-face-empty" data-testid="cockpit-face-job-error">
                作业加载失败 · {loadError}
                {retry}
                {isTimeoutMessage(loadError) && (
                  <span className="ck12-face-hint">
                    接口本身是毫秒级：超时多半是浏览器连接被占满（同时开着多个座舱
                    标签页/窗口时，每站只有 6 条连接）。关掉其它页面后点重试即可。
                  </span>
                )}
              </div>
            ) : (
              <div className="ck12-face-empty">
                <LoadingElapsed label="载入作业" testId="cockpit-face-job" />
              </div>
            )}
          </div>
        </>
      )
    }
    return (
      <div className="grid h-full min-h-40 place-items-center text-[12px] text-pop-dim">
        {loadError ? (
          <span
            className="flex flex-col items-center gap-2"
            data-testid="cabin-job-load-error"
          >
            作业加载失败 · {loadError}
            {retry}
            {isTimeoutMessage(loadError) && (
              <span className="ck12-face-hint">
                超时多半是浏览器连接被占满（同时开着多个页面/窗口）。关掉其它页面后点重试。
              </span>
            )}
          </span>
        ) : <LoadingElapsed label="载入作业" testId="cabin-job-loading" />}
      </div>
    )
  }

  const kind = KIND_META[job.kind]
  const KindIcon = kind.icon
  // 派生状态优先用列表（最新真值）；列表没回来时退回编队行摘要里的状态。
  const status = jobView?.status ?? cockpit?.hint?.status ?? null
  const tone = jobTone(status)
  const taskForRun = job.kind === 'task' ? taskEntity : null
  const subagentRun = job.kind === 'subagent' && !!job.ref_id

  // 运行 tab 只给摘要；「打开运行 →」开作业坞同款运行窗（DAG + 日志 + YAML）。
  // 任务类作业取当前一轮执行（运行中的优先，否则最新一轮）。
  const runTarget: CabinRunTarget | null = (() => {
    if (job.kind === 'workflow') {
      if (!job.ref_id || !workspaceId) return null
      return { executionId: job.ref_id, workspaceId, title: job.title, status: status ?? undefined }
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
  const relayGroups = groupRelay(timeline)
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
                    const text = relayText(event)
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
                        {relayText(event)}
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
        <div data-testid="cabin-job-relay" className={cockpitMode ? 'ck12-relay' : undefined}>
          <section className={cockpitMode ? 'ck12-pane' : undefined}>
            <header className={cockpitMode ? 'ck12-pane-h' : 'mb-2 flex items-center gap-2 text-[10px] text-pop-dim'}>
              <b>对接 · 交接时间线</b>
              <span className={cockpitMode ? 'ck12-pane-tag' : 'font-mono text-[9.5px]'}>
                {timeline.length} EVENTS
              </span>
              {/* 跨舱只读：投递只对入口舱开放，不给用户「能投到别的舱」的错觉。 */}
              {cabinId === entryCabinId && (
                <button
                  type="button"
                  data-testid="cockpit-relay-main-chat"
                  onClick={() => window.dispatchEvent(new CustomEvent('octopus:cabin-main-chat'))}
                  className={cockpitMode
                    ? 'ck12-relay-go'
                    : 'ml-auto inline-flex items-center gap-1 text-[10px] text-pop-cyan hover:underline'}
                >
                  <MessageSquare className="size-3" />去主对话
                </button>
              )}
            </header>

            <div className={cockpitMode ? 'ck12-pane-b is-tight' : undefined}>
              {/* 派发原文 = 时间线的第 0 条（你 → 汐音），长文默认收 3 行，可展开。 */}
              {job.prompt && (
                <div className="ck12-relay-spec">
                  <div className="h">
                    <b>你 → 汐音</b>
                    <span>派发原文</span>
                    {mandate && <span className="k">{mandate.strength}</span>}
                    {mandate?.basis && <span>{mandate.basis}</span>}
                    {mandate?.scope && <span>scope: {mandate.scope}</span>}
                    {job.prompt.length > 120 && (
                      <button
                        type="button"
                        className="ck12-relay-more"
                        data-testid="cockpit-relay-prompt-toggle"
                        onClick={() => setPromptOpen((open) => !open)}
                      >{promptOpen ? '收起' : '展开原文'}</button>
                    )}
                  </div>
                  <p className={promptOpen ? undefined : 'is-clamp'}>{job.prompt}</p>
                </div>
              )}

              {timeline.length === 0 ? (
                <div className={cockpitMode ? 'ck12-face-empty' : 'rounded-lg border-[1.5px] border-dashed border-pop-bd p-6 text-center text-[11.5px] text-pop-dim'}>
                  还没有交接事件 · 派发后这里留痕
                </div>
              ) : (
                <div className="ck12-rtl" data-testid="cockpit-relay-timeline">
                  {relayGroups.map((group) => {
                    const event = group.last
                    const k = traceKind(event.kind)
                    const [from, to] = relayRoute(event.kind)
                    const firstPriority = priorityOf(group.first)
                    const lastPriority = priorityOf(group.last)
                    const text = group.count > 1 && firstPriority !== null && lastPriority !== null
                      ? `提优先 P${firstPriority} → P${lastPriority} · ${group.count} 次`
                      : relayText(event)
                    return (
                      <div
                        className="ck12-rrow"
                        key={group.key}
                        data-testid={`cabin-relay-event-${group.key}`}
                      >
                        <i className={cn('ck12-rrow-d', k.dot)} aria-hidden="true" />
                        <span className="ck12-rrow-t">{clockLabel(event.created_at)}</span>
                        <span className="ck12-rrow-route">
                          <b className={`is-${from}`}>{RELAY_ROLE[from].label}</b>
                          <ArrowRight className="ck12-rrow-arrow" aria-hidden="true" />
                          <b className={`is-${to}`}>{RELAY_ROLE[to].label}</b>
                        </span>
                        <span className="ck12-rrow-k">{k.label}</span>
                        <span className="ck12-rrow-x" title={text}>{text}</span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      {tab === 'run' && (
        <div data-testid="cabin-job-run" className={frameOf()}>
          {job.kind === 'subagent' ? (
            subagentRun ? (
              <div className={cn('overflow-hidden rounded-lg border-[1.5px] border-pop-bd', fillOf('h-[500px]'))}>
                <SubagentWindow
                  sessionId={job.session_id ?? mainSessionId ?? null}
                  agentId={job.ref_id}
                />
              </div>
            ) : (
              <div className={emptyOf()}>
                这条作业还没有可看的运行现场（缺子代理）
              </div>
            )
          ) : runTarget ? (
            <div className={fillOf()}>
              <CabinRunSummary target={runTarget} />
            </div>
          ) : (
            <div className={emptyOf()}>
              {job.kind === 'task' && taskForRun
                ? '这一轮还没有执行 · 跑起来后这里给执行摘要'
                : '这条作业还没有可看的运行现场（缺执行 / 任务）'}
            </div>
          )}
        </div>
      )}

      {tab === 'changes' && (
        <div data-testid="cabin-job-changes" className={frameOf()}>
          {taskForRun ? (
            <div className={cn('overflow-hidden rounded-lg border-[1.5px] border-pop-bd bg-pop-paper', fillOf('h-[500px]'))}>
              <ChangesWindow task={taskForRun} />
            </div>
          ) : (
            <div className={emptyOf()}>
              {cockpitMode ? `这条${kind.label}作业没有交付变更账本` : '只有任务类作业有变更账本'}
            </div>
          )}
        </div>
      )}

      {tab === 'accept' && (
        <div data-testid="cabin-job-accept" className={frameOf()}>
          {taskForRun ? (
            <div className={cn('overflow-y-auto rounded-lg border-[1.5px] border-pop-bd bg-pop-paper', fillOf('max-h-[520px]'))}>
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
            <div className={emptyOf()}>
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
