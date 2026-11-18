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

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowRight, Bot, ChevronDown, GitBranch, ListTodo, MessageSquare,
} from 'lucide-react'
import type { CabinAttentionItem, CabinJob, CabinJobEvent, CabinJobKind } from '@octopus/shared'
import {
  getCabinJob, getCabinUsage, listCabinJobs,
  type CabinJobView,
} from '@/lib/cabin-api'
import { getTask, type TaskDetail } from '@/lib/tasks-api'
import { getSession } from '@/lib/agent/api'
import type { AgentMessage } from '@/lib/agent/types'
import { withDeadline } from '@/lib/with-deadline'
import { useBillingCurrency } from '@/lib/billing-currency'
import { formatCost } from '@/lib/format'
import { cn } from '@/lib/utils'
import { SubagentWindow } from '@/components/chat-workbench/subagent-window'
import { ChangesWindow } from '@/components/chat-workbench/changes-window'
import { AcceptanceWindow } from '@/components/chat-workbench/acceptance-window'
import { CabinRunSummary, type CabinRunTarget } from './modules/CabinRunSummary'
import { clockLabel, openTaskInChat } from './modules/ui'
import { pctFromPhases } from './job-progress'
import { jobStatusLabel, jobTone } from './job-status'
import { traceKind } from './trace-meta'
import {
  COCKPIT_TABS, COCKPIT_TAB_LABELS, type CockpitTab,
} from '@/components/cockpit/state/cockpit-state'
import {
  CockpitElapsed, CockpitJobHeader, CockpitJobTabs,
} from '@/components/cockpit/face/CockpitJobHeader'
import { CockpitJobFiles } from '@/components/cockpit/face/CockpitJobFiles'
import { CockpitJobDebug } from '@/components/cockpit/face/CockpitJobDebug'
import { CockpitJobDialog } from '@/components/cockpit/face/CockpitJobDialog'
import { CockpitJobProject } from '@/components/cockpit/face/CockpitJobProject'
import { projectNameFromKey } from '@/components/cockpit/projects/project-model'
import { PHASE_PILL, PHASE_STATUS_LABEL } from '@/components/tasks/run-console/phase-status'

/** classic 作业窗页签 = v12 五页签 + 文件（2026-11-17 用户：作战详情要能像
 *  作业坞那样查 task home）。debug 仍只在全域面出现。 */
const WINDOW_TABS: readonly CockpitTab[] = ['overview', 'relay', 'run', 'changes', 'accept', 'files']

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

/** 事件类型 → 交接方向（人输入/决策：你→汐音；派发类：汐音→执行者；回报类：执行者→汐音）。 */
function relayRoute(kind: string): [RelayRole, RelayRole] {
  if (kind === 'human_input' || kind === 'decision') return ['you', 'xiyin']
  if (kind === 'report' || kind === 'attention' || kind === 'handback') return ['doer', 'xiyin']
  return ['xiyin', 'doer']
}

/** actor 是展示字段，不是协议：未知值原样露出，不硬猜成某个角色。 */
function actorLabel(actor: string | null | undefined): string {
  if (!actor) return '—'
  if (actor === 'human') return '你'
  if (actor === 'orchestrator') return '汐音'
  if (actor === 'doer') return '执行者'
  if (actor === 'system') return '系统'
  return actor
}

/** 事件时间 HH:MM（原型 .ev .t；非法时间给 —，不猜）。 */
function hmOf(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 概览「交接统计」的固定词序：先派发后回报，人输入/决策单列。 */
const STAT_KINDS = ['dispatch', 'brief', 'report', 'attention', 'handback', 'human_input', 'decision', 'resume'] as const

function countKinds(events: readonly CabinJobEvent[]): Map<string, number> {
  const counts = new Map<string, number>()
  const seenDecisions = new Set<string>()
  for (const event of events) {
    // 决策账本是同一决策跨 stage 的多行：统计按 decisionId 算一次。
    const decisionId = decisionIdOf(event)
    if (decisionId) {
      if (seenDecisions.has(decisionId)) continue
      seenDecisions.add(decisionId)
    }
    counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1)
  }
  return counts
}

/** 对接气泡的正文：不同事件把 payload 里真正有信息量的字段摊开，没值才退回摘要。 */
function relayBody(event: CabinJobEvent): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>
  if (priorityOf(event) !== null) return `提优先 → P${priorityOf(event)}`
  switch (event.kind) {
    case 'dispatch': {
      const title = typeof payload.title === 'string' ? payload.title : ''
      const mandate = payload.mandate as { strength?: string } | null
      return [title ? `派发「${title}」` : '已派发', mandate?.strength ? `授权 ${mandate.strength}` : '']
        .filter(Boolean).join(' · ')
    }
    case 'brief': {
      const brief = payload.brief as { goal?: string; done_when?: unknown[]; autonomy?: string } | null
      const goal = brief?.goal ?? (typeof payload.goal === 'string' ? payload.goal : '')
      const done = Array.isArray(brief?.done_when) ? brief.done_when.length : 0
      return [goal || '意图已编译', done > 0 ? `完成条件 ${done} 条` : '', brief?.autonomy ? `托管 ${brief.autonomy}` : '']
        .filter(Boolean).join(' · ')
    }
    case 'decision': {
      const choice = typeof payload.choice === 'string' ? payload.choice : ''
      const note = typeof payload.note === 'string' ? payload.note : ''
      const stage = typeof payload.stage === 'string' ? payload.stage : ''
      const relayed = stage === 'relayed' || stage === 'acked' ? '已转达执行者' : ''
      return [choice ? `选择「${choice}」` : '已作出决策', note, relayed].filter(Boolean).join(' · ')
    }
    case 'resume':
      return '解除阻塞 · 恢复推进'
    default:
      return summaryOf(event) || traceKind(event.kind).label
  }
}

/** 舱主会话里汐音发给用户的卡：里程碑（任务状态）、提问、决策回执。
 *  对接的最后一跳就是它们 —— 执行者只回报汐音，汐音再挑该说的告诉人。 */
const MIRROR_KIND_LABEL: Record<string, string> = {
  'cabin.author_ask': '提问',
  'cabin.author_ask_receipt': '回执',
  'cabin.decision_receipt': '回执',
  'cabin.init': '舱务',
}

function mirrorText(message: AgentMessage): string {
  const activity = message.activity
  // 决策回执的 title 只是「决策已转达」；真正的内容是选择本身。
  if (activity?.kind === 'cabin.decision_receipt') {
    const receipt = (activity.payload as { decisionReceipt?: { choice?: string } } | undefined)?.decisionReceipt
    const choice = receipt?.choice?.trim()
    return choice ? `决策已转达 · 「${choice}」` : '决策已转达'
  }
  const parts = [activity?.title?.trim(), activity?.message?.trim()].filter(Boolean)
  if (parts.length > 0) return parts.join(' · ')
  return message.content.replace(/^\[[^\]]*\]\s*/, '').split('\n')[0]?.trim() ?? ''
}

/** human_input 里的「提优先」事件：payload = { action: 'priority', priority }。 */
function priorityOf(event: CabinJobEvent): number | null {
  const payload = event.payload as Record<string, unknown> | null
  return payload && payload.action === 'priority' && typeof payload.priority === 'number'
    ? payload.priority
    : null
}

/** 决策账本是一条决策跨多个 stage（decided → relayed → acked 各落一行）：
 *  同一个 decisionId 在对接里只算一次发言，位置留在第一次、内容取最新 stage。 */
function decisionIdOf(event: CabinJobEvent): string | null {
  const payload = event.payload as Record<string, unknown> | null
  return event.kind === 'decision' && typeof payload?.decisionId === 'string'
    ? payload.decisionId
    : null
}

/** 连续的「提优先」折叠成一条（P2 → P6 · 5 次）：它们是一串同义操作，
 *  逐条铺开只会把真正的一次交接挤出屏幕。决策按 decisionId 去重（跨 stage）。 */
interface RelayGroup {
  key: string
  first: CabinJobEvent
  last: CabinJobEvent
  count: number
}

/** 对接里的一条发言：三跳（你/汐音/执行者）合流后的最小渲染单元。 */
interface RelayLine {
  key: string
  at: string
  from: RelayRole
  to: RelayRole
  kindLabel: string
  text: string
  /** 来自舱主会话的任务卡（汐音 → 你），不是 job ledger。 */
  mirror?: boolean
}

function groupRelay(timeline: readonly CabinJobEvent[]): RelayGroup[] {
  const groups: RelayGroup[] = []
  const decisions = new Map<string, RelayGroup>()
  for (const event of timeline) {
    const prev = groups[groups.length - 1]
    if (priorityOf(event) !== null && prev && priorityOf(prev.last) !== null) {
      prev.last = event
      prev.count += 1
      continue
    }
    const decisionId = decisionIdOf(event)
    if (decisionId) {
      const hit = decisions.get(decisionId)
      if (hit) {
        hit.last = event
        hit.count += 1
        continue
      }
      const group = { key: event.id, first: event, last: event, count: 1 }
      decisions.set(decisionId, group)
      groups.push(group)
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
  /** 项目名（编队行 project_keys 派生；有它时副行写「项目 · 分支 · 编号」）。 */
  projectName?: string | null
  /** 本作业的 attention（fleet 已按 job_id 合并；只用于「当前在做」文案）。 */
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
  workspaceId: string | null
  jobId: string
  variant: 'window' | 'cockpit'
  /** 判断「对接」页签是否可投递；跨舱（≠ cabinId）时隐藏「去主对话」。 */
  entryCabinId: string
  onMutated?: () => void
  /** 旧窗：舱主会话（subagent 运行现场的回退，旧行为逐字保留）。 */
  mainSessionId?: string | null
  cockpit?: JobFaceCockpitControls
}

export function JobFace({
  cabinId,
  workspaceId,
  jobId,
  variant,
  entryCabinId,
  onMutated,
  mainSessionId,
  cockpit,
}: JobFaceProps) {
  const controlled = variant === 'cockpit' && !!cockpit
  const [job, setJob] = useState<CabinJob | null>(null)
  const [jobView, setJobView] = useState<CabinJobView | null>(null)
  const [events, setEvents] = useState<CabinJobEvent[]>([])
  const [innerTab, setInnerTab] = useState<CockpitTab>('overview')
  const [taskEntity, setTaskEntity] = useState<TaskDetail | null>(null)
  /** 舱主会话消息：对接里「汐音 → 你」那一跳的原始来源（任务卡）。 */
  const [mainMessages, setMainMessages] = useState<AgentMessage[]>([])
  const [usageCost, setUsageCost] = useState<{ usd: number; complete: boolean } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** 对接页签：派发原文默认收 3 行（原文往往是整段需求）。 */
  const [promptOpen, setPromptOpen] = useState(false)
  /** 对接页签：「我的回复」下拉（跳转到对应记录）。 */
  const [jumpOpen, setJumpOpen] = useState(false)
  const [jumpFlash, setJumpFlash] = useState<string | null>(null)
  /** 对接滚动容器：跟 chat 一样默认贴底；人往上翻后不抢滚动。 */
  const relayBodyRef = useRef<HTMLDivElement | null>(null)
  const jumpWrapRef = useRef<HTMLDivElement | null>(null)
  const relayStuckRef = useRef(true)
  const lastRelayScrollTopRef = useRef(0)

  const tab: CockpitTab = controlled && cockpit ? cockpit.tab : innerTab
  const changeTab = useCallback((next: CockpitTab) => {
    if (!controlled) setInnerTab(next)
    cockpit?.onTabChange(next)
  }, [controlled, cockpit])

  const load = useCallback(async () => {
    // 详情是**唯一**的面级关键路径：它回来就能整面渲染（标题/事件/页签）。
    // 派生状态（status/transport）来自整舱作业列表，只是锦上添花 ——
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
  // v21 七轮：「对话」页签读任务主会话（= 通讯台里这条任务的线程）。
  // workflow / subagent 没有主会话 → null，页签给明确空态。
  const dialogSessionId = taskEntity?.source_chat_session_id ?? null
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

  // 对接最后一跳：汐音 → 你。数据是舱主会话里带本任务 taskId 的事件卡
  // （任务里程碑 / 提问 / 决策回执）—— 执行者只回报汐音，汐音挑该说的
  // 告诉人。只在对接页拉取（概览不占连接池）；读不到就少这一跳，
  // 不影响前两跳（不伪造成「已转达」）。
  useEffect(() => {
    let alive = true
    setMainMessages([])
    if (!mainSessionId || !taskId || tab !== 'relay') return
    const pull = () => {
      withDeadline(null, JOB_FACE_TIMEOUT_MS, '舱主会话', () => getSession(mainSessionId, { limit: 200 })).then(
        (session) => { if (alive) setMainMessages(session.messages.items) },
        () => { /* 保留上一份快照 */ },
      )
    }
    pull()
    const timer = window.setInterval(pull, 10_000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [mainSessionId, taskId, tab])

  // 对接默认落到最新一条（与 chat 同逻辑）：打开页签 → 贴底；
  // 人往上翻后新内容不抢滚动，翻回底部才继续跟。
  useEffect(() => {
    if (tab !== 'relay') { relayStuckRef.current = true; return }
    relayStuckRef.current = true
    lastRelayScrollTopRef.current = 0
    const el = relayBodyRef.current
    if (!el) return
    const frame = window.requestAnimationFrame(() => { el.scrollTop = el.scrollHeight })
    return () => window.cancelAnimationFrame(frame)
  }, [tab])

  useEffect(() => {
    if (tab !== 'relay') return
    const el = relayBodyRef.current
    if (!el) return
    const frame = window.requestAnimationFrame(() => {
      if (relayStuckRef.current) el.scrollTop = el.scrollHeight
    })
    return () => window.cancelAnimationFrame(frame)
  }, [tab, events.length, mainMessages.length, promptOpen, job?.prompt])

  // 「我的回复」下拉：点空白 / Esc 收起；离开对接页签也收起。
  useEffect(() => {
    if (!jumpOpen) return
    const onDown = (event: MouseEvent) => {
      if (jumpWrapRef.current && !jumpWrapRef.current.contains(event.target as Node)) setJumpOpen(false)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setJumpOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [jumpOpen])

  useEffect(() => {
    if (tab !== 'relay') setJumpOpen(false)
  }, [tab])

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
              onClose={onClose}
              cabinName={cockpit?.cabinName ?? null}
              projectName={cockpit?.projectName ?? null}
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
  const jobStatusText = jobStatusLabel(status)
  const toneEmoji = ({ run: '⚡', wait: '❗', blocked: '💦', ended: '✅', idle: '●' } as const)[tone]

  // ── 概览统计（2026-11-17 用户：概览不看事件流，看统计）────────────────
  // 每个数都是真账本/真任务实体；缺数据就不出那一格，不补 0、不猜。
  const kindCounts = countKinds(timeline)
  const kindStats = STAT_KINDS
    .map((kind) => ({ kind, meta: traceKind(kind), n: kindCounts.get(kind) ?? 0 }))
    .filter((entry) => entry.n > 0)
  /** 语义交接数（决策已按 decisionId 去重），不是账本行数。 */
  const kindTotal = kindStats.reduce((sum, entry) => sum + entry.n, 0)
  const execs = taskEntity?.executions ?? []
  const execDone = execs.filter((exec) => ['completed', 'completed_with_failures'].includes(exec.status)).length
  const execFailed = execs.filter((exec) => ['failed', 'aborted', 'interrupted', 'rejected', 'cancelled'].includes(exec.status)).length
  const execLive = execs.filter((exec) => ['pending', 'running', 'paused'].includes(exec.status)).length
  const goal = taskEntity?.task_spec?.goal ?? null
  const acList = taskEntity?.task_spec?.ac ?? []

  // ── cockpit 头部派生（§1.5，缺就省略）────────────────────────────────
  const lastEvent = timeline[timeline.length - 1]
  // 「在做」只写真实发生的事：最近事件摘要 → attention 标题；都没有就省略
  // （不要再回退成状态文案——行1 已经显示状态了，重复一次是噪音）。
  const doing = (lastEvent ? summaryOf(lastEvent) : '') || cockpit?.attention?.title || null
  const branch = job.kind === 'task' ? (taskEntity?.task_spec?.branch ?? null) : null
  const executor = shortId(job.session_id ?? job.ref_id)
  // 原型 .ph 副行的「编号」：任务 / 作业自己的 ref 短号（不是会话 id）。
  const jobNo = shortId(job.ref_id ?? job.id)
  // 项目锚点：task 用 project_ids（classic 的「N 项目」同源）；其它用编队行 keys。
  const taskProjects = taskEntity?.project_ids ?? []
  const jobProjects = job.kind === 'task' && taskProjects.length > 0
    ? taskProjects
    : (jobView?.project_keys ?? [])
  const projectName = cockpit?.projectName
    ?? (jobProjects.length > 0 ? projectNameFromKey(jobProjects[0]) : null)
  const costLabel = usageCost ? formatCost(usageCost.usd, usageCost.complete, currency) : null

  // v21 五轮（用户）：详情头部右上不再放任何动作按钮 —— 暂停/中止 / 谈 / 决断 /
  // 调试 / 舱籍都回到各自入口（作业坞、左栏行 💬、右栏「要我处理」、详情页签、HUD 舱籍）。

  // ── 概览块（两种宿主共用；2026-11-17 用户：概览看统计，不再铺事件流）──
  // 统计只读真账本：kind 计数来自 cabin_job_events，执行/阶段来自任务实体。
  const kpiGrid = (
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
      {execs.length > 0 && (
        <div className="ck12-jstat">
          <div className="l">执行</div>
          <div className="v">{execs.length} 轮</div>
        </div>
      )}
    </div>
  )

  const kindChips = (
    <div className="ck12-jchips" data-testid="cabin-job-stats">
      <span>交接 <b>{kindTotal}</b></span>
      {kindStats.map(({ kind: statKind, meta, n }) => (
        <span key={statKind}>{meta.label} <b>{n}</b></span>
      ))}
      {execs.length > 0 && (
        <>
          <span>执行 <b>{execs.length}</b></span>
          {execDone > 0 && <span>完成 <b>{execDone}</b></span>}
          {execLive > 0 && <span>进行中 <b>{execLive}</b></span>}
          {execFailed > 0 && <span>失败 <b>{execFailed}</b></span>}
        </>
      )}
    </div>
  )

  const lastHandoff = lastEvent ? (
    <div className="ck12-jmandate" data-testid="cabin-job-last-handoff">
      <div className="h">
        <b>最近交接</b>
        <span className="k">{traceKind(lastEvent.kind).label}</span>
        <span>{actorLabel(lastEvent.actor)}</span>
        <span>{clockLabel(lastEvent.created_at)}</span>
      </div>
      <p>{relayBody(lastEvent)}</p>
    </div>
  ) : null

  const taskSummary = (goal || acList.length > 0) ? (
    <div className="ck12-jmandate" data-testid="cabin-job-task-summary">
      <div className="h">
        <b>任务摘要</b>
        <span className="k">AC {acList.length > 0 ? acList.length : '—'}</span>
      </div>
      {goal && <p>{goal}</p>}
      {acList.length > 0 && (
        <ul className="ck12-jac">
          {acList.map((item, index) => (
            <li key={index}><span aria-hidden="true">◇</span>{item}</li>
          ))}
        </ul>
      )}
    </div>
  ) : null

  const mandateBlock = (mandate || job.prompt) ? (
    <div className="ck12-jmandate">
      <div className="h">
        <b>派发授权</b>
        {mandate && <span className="k">{mandate.strength}</span>}
        {mandate?.scope && <span>scope: {mandate.scope}</span>}
      </div>
      {job.prompt && <p>{job.prompt}</p>}
    </div>
  ) : null

  const progressBar = pct !== null ? (
    <div className="ck12-jbar2" aria-hidden="true">
      <i style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  ) : null

  const phaseChips = phaseViews.length > 0 ? (
    <div className="ck12-jchips">
      <span>阶段 <b>{acceptedPhases}/{phaseViews.length}</b></span>
      <span>类型 <b>{kind.label}</b></span>
    </div>
  ) : null

  /** 阶段统计：每一 phase 的名字 / 当前轮 / 派生态 —— 概览里最有用的一组读数。 */
  const phaseList = phaseViews.length > 0 ? (
    <div className="ck12-jmandate" data-testid="cabin-job-phases">
      <div className="h">
        <b>阶段</b>
        <span className="k">{acceptedPhases}/{phaseViews.length} 已通过</span>
      </div>
      <ul className="ck12-jphase">
        {phaseViews.map((phase) => (
          <li key={phase.index}>
            <span className="p">P{phase.index}</span>
            <span className="n" title={phase.slug}>{phase.name || phase.slug || `phase ${phase.index}`}</span>
            <span className="r">{phase.currentRound != null ? `R${phase.currentRound}` : '—'}</span>
            <span className={cn('s', PHASE_PILL[phase.status])}>{PHASE_STATUS_LABEL[phase.status] ?? phase.status}</span>
          </li>
        ))}
      </ul>
    </div>
  ) : null

  // 对接链路：执行者 → 汐音（job events）+ 汐音 → 你（舱主会话任务卡）+
  // 你 → 汐音（输入/决策）。三跳按时间合流；提优先已折叠、决策跨 stage
  // 已去重，计数按「发言」不是账本行数。
  const doerLabel = job.kind === 'subagent' ? '子代理' : '执行者'
  const mirrorCards = taskId
    ? mainMessages.filter((message) =>
      message.displayType === 'event' && message.activity?.taskId === taskId)
    : []

  const eventLines: RelayLine[] = relayGroups.map((group) => {
    const event = group.last
    const [from, to] = relayRoute(event.kind)
    const firstPriority = priorityOf(group.first)
    const lastPriority = priorityOf(group.last)
    const text = group.count > 1 && firstPriority !== null && lastPriority !== null
      ? `提优先 P${firstPriority} → P${lastPriority} · ${group.count} 次`
      : relayBody(event)
    return {
      key: event.id,
      at: event.created_at,
      from,
      to,
      kindLabel: traceKind(event.kind).label,
      text,
    }
  })
  const mirrorLines: RelayLine[] = mirrorCards.map((message) => ({
    key: `mirror-${message.id}`,
    at: message.created_at,
    from: 'xiyin',
    to: 'you',
    kindLabel: MIRROR_KIND_LABEL[message.activity?.kind ?? ''] ?? '回告',
    text: mirrorText(message),
    mirror: true,
  }))
  const relayLines = [...eventLines, ...mirrorLines].sort((a, b) => a.at.localeCompare(b.at))
  const linesFrom = (lane: RelayRole) => relayLines.filter((line) => line.from === lane)
  const lastOf = (lines: RelayLine[]) => (lines.length > 0 ? lines[lines.length - 1].at : null)
  const youLines = linesFrom('you')
  const xiyinLines = linesFrom('xiyin')
  const doerLines = linesFrom('doer')
  const youCount = youLines.length + (job.prompt ? 1 : 0)
  const xiyinCount = xiyinLines.length
  const doerCount = doerLines.length
  const lastYou = lastOf(youLines) ?? (job.prompt ? job.created_at : null)
  const lastXiyin = lastOf(xiyinLines)
  const lastDoer = lastOf(doerLines)

  /** 「我的回复」= 派发原文 + 你 → 汐音 的 human_input / decision 行。
   *  下拉里按时间排；点一条滚到对应记录并闪一下。 */
  const youEntries = [
    ...(job.prompt
      ? [{ key: 'prompt', at: job.created_at, kindLabel: '派发原文', text: job.prompt }]
      : []),
    ...youLines.map((line) => ({
      key: line.key, at: line.at, kindLabel: line.kindLabel, text: line.text,
    })),
  ]

  const jumpToReply = (key: string) => {
    setJumpOpen(false)
    // 人主动跳到某条记录：先解除「贴底」，别让下一次事件把视口拽回最新。
    relayStuckRef.current = false
    const target = relayBodyRef.current?.querySelector<HTMLElement>(`[data-relay-key="${key}"]`)
    if (!target) return
    if (typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
    setJumpFlash(key)
    window.setTimeout(() => setJumpFlash((current) => (current === key ? null : current)), 1400)
  }

  const panes = (
    <>
      {tab === 'dialog' && <CockpitJobDialog sessionId={dialogSessionId} />}
      {tab === 'overview' && (cockpitMode ? (
        // v21 三轮（原型 .panel 详情·概览）：kv 读数 + 当前在做 + 最近事件。
        <div data-testid="cabin-job-overview" className="ck12-dossier-ov">
          <div className="ck12-kv">
            <div className="ck12-kvi">
              <div className="k">状态</div>
              <div className="v is-a">{toneEmoji} {jobStatusText}</div>
            </div>
            {pct !== null && (
              <div className="ck12-kvi">
                <div className="k">进度</div>
                <div className="v">{Math.round(pct)}%</div>
              </div>
            )}
            {executor && (
              <div className="ck12-kvi">
                <div className="k">执行者</div>
                <div className="v">{executor}</div>
              </div>
            )}
            {branch && (
              <div className="ck12-kvi">
                <div className="k">分支</div>
                <div className="v is-g">{branch}</div>
              </div>
            )}
            <div className="ck12-kvi">
              <div className="k">用时</div>
              <div className="v"><CockpitElapsed start={job.created_at} end={job.ended_at} /></div>
            </div>
            {costLabel && (
              <div className="ck12-kvi">
                <div className="k">消耗</div>
                <div className="v is-gr">{costLabel}</div>
              </div>
            )}
          </div>

          {doing && (
            <>
              <div className="ck12-sect">当前在做</div>
              <div className="ck12-doing">{doing}</div>
            </>
          )}

          <div className="ck12-sect">最近事件</div>
          {timeline.length === 0 ? (
            <div className="ck12-dossier-empty">暂无事件</div>
          ) : (
            timeline.slice(-4).map((event) => (
              <div
                key={event.id}
                className={`ck12-ev${event.kind === 'attention' ? ' is-attention' : ''}`}
              >
                <span className="t">{hmOf(event.created_at)}</span>
                <span className="w">{actorLabel(event.actor)}</span>
                <span className="x">{summaryOf(event)}</span>
              </div>
            ))
          )}
        </div>
      ) : (
        // classic 作业窗：同一条统计主线，单列往下排。不再画事件流 ——
        // 那部分信息在「对接」里按三方发言看，概览只负责读数。
        <div data-testid="cabin-job-overview" className="cabin-job-overview">
          {kpiGrid}
          {progressBar}
          {phaseChips}
          {phaseList}
          {kindChips}
          {lastHandoff}
          {taskSummary}
          {mandateBlock}
          {timeline.length === 0 && execs.length === 0 && !goal && acList.length === 0 && (
            <div className="rounded-lg border-[1.5px] border-dashed border-pop-bd p-6 text-center text-[11.5px] text-pop-dim">
              还没有统计 · 派发后这里开始累计。
            </div>
          )}
        </div>
      ))}

      {tab === 'relay' && (
        <div data-testid="cabin-job-relay" className={cockpitMode ? 'ck12-relay' : 'cabin-relay'}>
          <section className={cockpitMode ? 'ck12-pane' : 'cabin-relay-pane'}>
            <header className={cockpitMode ? 'ck12-pane-h' : 'cabin-relay-h'}>
              <b>对接 · 三方通讯</b>
              <span className={cockpitMode ? 'ck12-pane-tag' : 'cabin-relay-count'}>
                {relayLines.length + (job.prompt ? 1 : 0)} 条
              </span>
              {/* 我的回复：下拉跳转（派发原文 + human_input / decision），
                  不改变时间线本身 —— 只负责滚到对应记录。 */}
              {youEntries.length > 0 && (
                <div className="cabin-relay-jump" ref={jumpWrapRef}>
                  <button
                    type="button"
                    className="cabin-relay-jump-btn"
                    data-testid="cabin-relay-jump"
                    aria-expanded={jumpOpen}
                    onClick={() => setJumpOpen((open) => !open)}
                  >
                    <MessageSquare className="size-3" />
                    我的回复 {youEntries.length}
                    <ChevronDown className="size-3" aria-hidden="true" />
                  </button>
                  {jumpOpen && (
                    <div className="cabin-relay-jump-pop" role="menu" data-testid="cabin-relay-jump-pop">
                      {youEntries.map((entry) => (
                        <button
                          key={entry.key}
                          type="button"
                          role="menuitem"
                          className="cabin-relay-jump-row"
                          data-testid={`cabin-relay-jump-${entry.key}`}
                          onClick={() => jumpToReply(entry.key)}
                        >
                          <span className="t">{clockLabel(entry.at)}</span>
                          <span className="k">{entry.kindLabel}</span>
                          <span className="x" title={entry.text}>{entry.text}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {/* 跨舱只读：投递只对入口舱开放，不给用户「能投到别的舱」的错觉。 */}
              {cabinId === entryCabinId && job.kind === 'task' && job.ref_id && (
                <button
                  type="button"
                  data-testid="cockpit-relay-task-chat"
                  onClick={() => openTaskInChat(job.ref_id as string)}
                  className={cockpitMode
                    ? 'ck12-relay-go ml-auto'
                    : 'cabin-relay-go'}
                >
                  <MessageSquare className="size-3" />任务对话
                </button>
              )}
              {cabinId === entryCabinId && (
                <button
                  type="button"
                  data-testid="cockpit-relay-main-chat"
                  onClick={() => window.dispatchEvent(new CustomEvent('octopus:cabin-main-chat'))}
                  className={cockpitMode
                    ? 'ck12-relay-go'
                    : 'cabin-relay-go'}
                >
                  <MessageSquare className="size-3" />去主对话
                </button>
              )}
            </header>

            <div
              ref={relayBodyRef}
              className={cockpitMode ? 'ck12-pane-b is-tight' : 'cabin-relay-body'}
              data-testid="cabin-relay-body"
              onScroll={(event) => {
                const el = event.currentTarget
                const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32
                // 只把「向上翻」当人想离开最新；程序性贴底（scrollTop 增大）
                // 不能让 onScroll 把 sticky 关掉，否则数据后到就停在半截。
                if (atBottom) relayStuckRef.current = true
                else if (el.scrollTop < lastRelayScrollTopRef.current - 2) relayStuckRef.current = false
                lastRelayScrollTopRef.current = el.scrollTop
              }}
            >
              {/* 三方在场：角色 + 发言数 + 最后一句时间（title 里带时间，不挤版面）。 */}
              <div className="cabin-relay-map" data-testid="cabin-relay-map">
                <span className="party is-you" title={lastYou ? `最后一句 ${clockLabel(lastYou)}` : undefined}>
                  <b>你</b>
                  <em>指挥 · {youCount} 条</em>
                </span>
                <ArrowRight className="link" aria-hidden="true" />
                <span className="party is-xiyin" title={lastXiyin ? `最后一句 ${clockLabel(lastXiyin)}` : undefined}>
                  <i aria-hidden="true" />
                  <b>汐音</b>
                  <em>调度 · {xiyinCount} 条</em>
                </span>
                <ArrowRight className="link" aria-hidden="true" />
                <span className="party is-doer" title={lastDoer ? `最后一句 ${clockLabel(lastDoer)}` : undefined}>
                  <b>{doerLabel}</b>
                  <em>{jobStatusText} · {doerCount} 条</em>
                </span>
                <span className="tail">你指挥汐音 · 汐音调度{doerLabel}</span>
              </div>

              {/* 完整链路：执行者的回报不会直接落到人，必经汐音汇总这一跳。 */}
              <div className="cabin-relay-chain" data-testid="cabin-relay-chain">
                <span>完整链路</span>
                <b>你</b><i>→</i><b>汐音</b><i>→</i><b>{doerLabel}</b><i>→</i><b>汐音</b><i>→</i><b>你</b>
              </div>

              <div className="cabin-relay-flow" data-testid="cockpit-relay-timeline">
                {/* 派发原文 = 第 0 条（你 → 汐音），长文默认收 3 行，可展开。 */}
                {job.prompt && (
                  <div
                    className={cn('cabin-rm is-you', jumpFlash === 'prompt' && 'is-jump-flash')}
                    data-testid="cabin-relay-prompt"
                    data-relay-key="prompt"
                  >
                    <div className="cabin-rm-h">
                      <b>你 → 汐音</b>
                      <span className="k">派发原文</span>
                      {mandate && <span className="k">{mandate.strength}</span>}
                      {mandate?.scope && <span className="k">{mandate.scope}</span>}
                      <span className="t">
                        {job.prompt.length > 120 && (
                          <button
                            type="button"
                            className="cabin-rm-more"
                            data-testid="cockpit-relay-prompt-toggle"
                            onClick={() => setPromptOpen((open) => !open)}
                          >{promptOpen ? '收起' : '展开原文'}</button>
                        )}
                      </span>
                    </div>
                    <p className={promptOpen ? undefined : 'is-clamp'}>{job.prompt}</p>
                  </div>
                )}

                {relayLines.length === 0 && !job.prompt ? (
                  <div className={cockpitMode ? 'ck12-face-empty' : 'cabin-relay-empty'}>
                    还没有交接事件 · 派发后这里留痕
                  </div>
                ) : (
                  relayLines.map((line) => {
                    const fromLabel = line.from === 'doer' ? doerLabel : RELAY_ROLE[line.from].label
                    const toLabel = line.to === 'doer' ? doerLabel : RELAY_ROLE[line.to].label
                    return (
                      <div
                        className={cn('cabin-rm', `is-${line.from}`, line.mirror && 'is-mirror', jumpFlash === line.key && 'is-jump-flash')}
                        key={line.key}
                        data-relay-key={line.key}
                        data-testid={`cabin-relay-event-${line.key}`}
                      >
                        <div className="cabin-rm-h">
                          <b>{fromLabel} → {toLabel}</b>
                          <span className="k">{line.kindLabel}</span>
                          <span className="t">{clockLabel(line.at)}</span>
                        </div>
                        <p title={line.text}>{line.text}</p>
                      </div>
                    )
                  })
                )}
              </div>

              <div className="cabin-relay-foot">
                {doerLabel}不直接找你：它的回报先到汐音，汐音汇总后再找你；要它做什么，也由汐音转达。
              </div>
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
      {tab === 'files' && (
        <div
          data-testid={cockpitMode ? 'cockpit-job-files' : 'cabin-job-files'}
          className={cockpitMode ? frameOf() : 'h-full min-h-0'}
        >
          <CockpitJobFiles taskId={job.kind === 'task' ? job.ref_id : null} />
        </div>
      )}
      {tab === 'debug' && cockpitMode && (
        <div data-testid="cockpit-job-debug" className={frameOf()}>
          <CockpitJobDebug sessionId={job.session_id} />
        </div>
      )}
      {tab === 'project' && cockpitMode && (
        <div data-testid="cockpit-job-project-pane" className={frameOf()}>
          <CockpitJobProject
            cabinId={cabinId}
            projects={jobProjects}
            branch={branch}
          />
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
          onClose={onClose}
          branch={branch}
          projectName={projectName}
          jobNo={jobNo}
          doing={doing}
          executor={executor}
          cabinName={cockpit?.cabinName ?? null}
          startedAt={job.created_at}
          endedAt={job.ended_at}
          costLabel={costLabel}
        />
        <div className="ck12-face-body" data-testid="cockpit-face-job">
          {/* 原型 .dtabs 在滚动正文里（.pb）—— 页签跟着内容滚走，不是常驻条。 */}
          <CockpitJobTabs tab={tab} onTabChange={changeTab} />
          {panes}
        </div>
      </>
    )
  }

  // ── 旧窗（2026-11-17 用户：提优先/聚焦/备注不常用且看不到效果，摘掉）──────
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
        {jobView?.transport && <span className="font-mono text-[10px] text-pop-dim">· {jobView.transport}</span>}
      </div>

      <div className="mb-2.5 flex shrink-0 gap-1 border-b-[1.5px] border-pop-bd" role="tablist">
        {WINDOW_TABS.map((key) => (
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

      <div className={cn('min-h-0 flex-1', !cockpitMode && 'cabin-job-scope')}>{panes}</div>
    </div>
  )
}
