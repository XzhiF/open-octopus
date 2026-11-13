'use client'

// classic-v3 作业详情（原型 .jb-* · 点 → 面）：
//   概览 = job events 时间线 + 派发授权
//   对接 = 你→汐音 / 汐音→执行者 / 执行者→汐音（只用真实记录，不伪造聊天）
//   运行 = 执行摘要卡（省略态，对齐 chat 执行框）；「打开运行 →」开作业坞同款
//          运行窗（DAG + 日志 + YAML），不在这里铺 DAG
//   变更 = 任务级真 ChangesWindow（phase 总账 + 实物 diff）
//   验收 = 真 AcceptanceWindow
// 数据：GET /api/cabins/:id/jobs/:jid（job + events，10s 轮询）+ listCabinJobs（派生 status）。

import { useCallback, useEffect, useState } from 'react'
import {
  Activity, ArrowRight, Bot, GitBranch, ListTodo, MessageSquare, Star, Zap,
} from 'lucide-react'
import { toast } from 'sonner'
import type { CabinJob, CabinJobEvent } from '@octopus/shared'
import {
  getCabinJob, listCabinJobs, noteCabinJob, setCabinFocus, setCabinJobPriority, type CabinJobView,
} from '@/lib/cabin-api'
import { getTask, type TaskDetail } from '@/lib/tasks-api'
import { cn } from '@/lib/utils'
import { SubagentWindow } from '@/components/chat-workbench/subagent-window'
import { ChangesWindow } from '@/components/chat-workbench/changes-window'
import { AcceptanceWindow } from '@/components/chat-workbench/acceptance-window'
import { CabinRunSummary, type CabinRunTarget } from './CabinRunSummary'
import { useCabinContext } from '../cabin-provider'
import { clockLabel } from './ui'
import { isEndedJob, jobStatusLabel, jobTone } from '../job-status'
import { traceKind } from '../trace-meta'

type JobTab = 'overview' | 'relay' | 'run' | 'changes' | 'accept'

const TABS: Array<{ key: JobTab; label: string }> = [
  { key: 'overview', label: '概览' },
  { key: 'relay', label: '对接' },
  { key: 'run', label: '运行' },
  { key: 'changes', label: '变更' },
  { key: 'accept', label: '验收' },
]

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

export function CabinJobDetail() {
  const { cabinId, cabin, selectedJobId, refresh } = useCabinContext()
  const [job, setJob] = useState<CabinJob | null>(null)
  const [jobView, setJobView] = useState<CabinJobView | null>(null)
  const [events, setEvents] = useState<CabinJobEvent[]>([])
  const [tab, setTab] = useState<JobTab>('overview')
  const [noteOpen, setNoteOpen] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [taskEntity, setTaskEntity] = useState<TaskDetail | null>(null)

  const load = useCallback(async () => {
    if (!selectedJobId) return
    try {
      const [detail, list] = await Promise.all([
        getCabinJob(cabinId, selectedJobId),
        listCabinJobs(cabinId),
      ])
      setJob(detail.job)
      setEvents(detail.events)
      setJobView(list.find((j) => j.id === selectedJobId) ?? null)
    } catch {
      /* 保留上一份快照 */
    }
  }, [cabinId, selectedJobId])

  useEffect(() => {
    setJob(null)
    setJobView(null)
    setEvents([])
    setTab('overview')
    setNoteOpen(false)
    void load()
  }, [load])

  useEffect(() => {
    const timer = window.setInterval(() => { void load() }, 10_000)
    return () => window.clearInterval(timer)
  }, [load])

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

  if (!selectedJobId) {
    return (
      <div className="grid h-full min-h-40 place-items-center text-[12px] text-pop-dim" data-testid="cabin-job-empty">
        从编队点一条作业
      </div>
    )
  }
  if (!job) {
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
      if (!job.ref_id || !cabin?.workspace_id) return null
      return { executionId: job.ref_id, workspaceId: cabin.workspace_id, title: job.title, status }
    }
    if (job.kind !== 'task') return null
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
    }
  })()

  const bump = async () => {
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
    if (!cabin) return
    setBusy('focus')
    try {
      const focused = cabin.focused_job_id === job.id
      await setCabinFocus(cabinId, cabin.version, focused ? null : job.id)
      toast.success(focused ? '已退出聚焦' : `已聚焦「${job.title}」`)
      await refresh()
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '聚焦失败')
    } finally {
      setBusy(null)
    }
  }

  const saveNote = async () => {
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

  const timeline = [...events].sort((a, b) => a.created_at.localeCompare(b.created_at))
  const userIn = timeline.filter((e) => e.kind === 'human_input')
  const outbound = timeline.filter((e) => ['dispatch', 'note', 'resume'].includes(e.kind))
  const inbound = timeline.filter((e) => ['report', 'attention', 'handback'].includes(e.kind))
  const mandate = job.mandate

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
              cabin?.focused_job_id === job.id
                ? 'border-pop-violet bg-pop-violet/10 text-pop-violet'
                : 'border-pop-bd text-pop-dim hover:text-pop-ink',
            )}
          >
            <Star className="size-3" />{cabin?.focused_job_id === job.id ? '聚焦中' : '聚焦'}
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
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            data-testid={`cabin-job-tab-${t.key}`}
            onClick={() => setTab(t.key)}
            className={cn(
              '-mb-[1.5px] border-b-2 px-3 py-1.5 text-[12px] transition-colors',
              tab === t.key
                ? 'border-pop-pink font-semibold text-pop-ink'
                : 'border-transparent text-pop-dim hover:text-pop-ink',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1">
        {tab === 'overview' && (
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
        )}

        {tab === 'relay' && (
          <div data-testid="cabin-job-relay">
            <div className="mb-2 flex items-center gap-1.5 text-[10px] text-pop-dim">
              <span className="rounded border border-pop-cyan/40 px-1.5 py-px text-pop-cyan">你</span>
              <ArrowRight className="size-2.5" />
              <span className="rounded border border-pop-pink/40 px-1.5 py-px text-pop-pink">汐音</span>
              <ArrowRight className="size-2.5" />
              <span className="rounded border border-pop-violet/40 px-1.5 py-px text-pop-violet">执行者</span>
              <button
                type="button"
                onClick={() => window.dispatchEvent(new CustomEvent('octopus:cabin-main-chat'))}
                className="ml-auto inline-flex items-center gap-1 text-[10px] text-pop-cyan hover:underline"
              >
                <MessageSquare className="size-3" />去主对话
              </button>
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
                    sessionId={job.session_id ?? cabin?.main_session_id ?? null}
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
                只有任务类作业有变更账本
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
                  onMutated={() => { void refresh(); void load() }}
                  onOpenChanges={() => setTab('changes')}
                />
              </div>
            ) : (
              <div className="rounded-lg border-[1.5px] border-dashed border-pop-bd p-6 text-center text-[11.5px] text-pop-dim">
                只有任务类作业可验收
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
