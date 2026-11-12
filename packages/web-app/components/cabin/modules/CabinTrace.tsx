'use client'

// 通信 Trace 窗（原型 wbTrace · C6）：cabin_job_events append-only 时间线 +
// 作业过滤 + 下钻（task → chat 底座任务线程；subagent → 复用 subagent-window）。

import { useCallback, useEffect, useState } from 'react'
import { Activity, ChevronDown, ChevronRight } from 'lucide-react'
import type { CabinJobEvent } from '@octopus/shared'
import { getCabinTrace, listCabinJobs, type CabinJobView } from '@/lib/cabin-api'
import { SubagentWindow } from '@/components/chat-workbench/subagent-window'
import { useCabinContext } from '../cabin-provider'
import { Empty, SBadge, WbH, WbNote, openTaskInChat, clockLabel, type SBadgeColor } from './ui'

const TRACE_KIND: Record<string, { label: string; color: SBadgeColor }> = {
  dispatch: { label: '派发', color: 'violet' },
  report: { label: '回报', color: 'cyan' },
  attention: { label: '需注意', color: 'amber' },
  handback: { label: '回弹', color: 'pink' },
  note: { label: '备注', color: 'dim' },
  human_input: { label: '人输入', color: 'green' },
  resume: { label: '恢复', color: 'green' },
}

const TRACE_DOT: Record<SBadgeColor, string> = {
  violet: 'bg-pop-violet',
  cyan: 'bg-pop-cyan',
  amber: 'bg-pop-amber',
  pink: 'bg-pop-pink',
  dim: 'bg-pop-dim',
  green: 'bg-pop-green',
  red: 'bg-pop-red',
  purple: 'bg-pop-purple',
  navy: 'bg-pop-navy',
}

export function CabinTrace() {
  const { cabinId, traceJobId, setTraceJob } = useCabinContext()
  const [events, setEvents] = useState<CabinJobEvent[]>([])
  const [jobs, setJobs] = useState<CabinJobView[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [evs, js] = await Promise.all([getCabinTrace(cabinId), listCabinJobs(cabinId)])
      setEvents(evs)
      setJobs(js)
    } catch {
      setEvents([])
    }
  }, [cabinId])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const timer = setInterval(() => { void load() }, 10_000)
    return () => clearInterval(timer)
  }, [load])

  const jobTitle = (id: string) => jobs.find((j) => j.id === id)?.title ?? id.slice(0, 8)
  const jobOf = (id: string) => jobs.find((j) => j.id === id)
  const shown = traceJobId ? events.filter((e) => e.job_id === traceJobId) : events

  return (
    <div data-testid="cabin-trace-body">
      <WbH icon={Activity} title="通信 Trace" cap="orchestrator ↔ doer · 派发审计时间线" />
      <WbNote className="mb-3">
        每条消息持久落 cabin_job_events（append-only）。有序/幂等投递；progress 内部不 wake，
        high-signal wake orchestrator 主会话（单线程收件箱）；仅人需 surface 卡。子代理下钻复用 subagent-window。
      </WbNote>

      <div className="mb-3 flex items-center gap-2">
        <select
          value={traceJobId ?? ''}
          onChange={(e) => setTraceJob(e.target.value || null)}
          data-testid="cabin-trace-filter"
          className="h-7 rounded-md border border-pop-bd bg-pop-idle px-2 text-[11px] text-pop-ink outline-none"
        >
          <option value="">全部作业</option>
          {jobs.map((j) => <option key={j.id} value={j.id}>{j.title}</option>)}
        </select>
        <span className="text-[10.5px] text-pop-dim">{shown.length} 条</span>
      </div>

      {shown.length === 0 ? (
        <Empty>暂无 trace · 派发后这里留痕</Empty>
      ) : [...shown].reverse().map((e) => {
        const kind = TRACE_KIND[e.kind] ?? { label: e.kind, color: 'dim' as SBadgeColor }
        const payload = (e.payload ?? {}) as { summary?: string; title?: string; status?: string }
        const job = jobOf(e.job_id)
        const isOpen = expanded === e.id
        return (
          <div key={e.id} className="mb-1.5" data-trace-row={e.id}>
            <div className="flex items-start gap-2.5 rounded-lg border border-pop-bd bg-pop-idle px-3 py-2">
              <span className={`mt-1 size-2 shrink-0 rounded-full ${TRACE_DOT[kind.color]}`} />
              <span className="shrink-0 font-mono text-[10px] text-pop-dim">{clockLabel(e.created_at)}</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                  <SBadge color={kind.color}>{kind.label}</SBadge>
                  <b className="truncate text-pop-ink">{jobTitle(e.job_id)}</b>
                  <span className="text-pop-dim">· {e.actor ?? '—'}</span>
                  {job?.kind === 'task' && job.ref_id && (
                    <button
                      type="button"
                      className="ml-auto inline-flex items-center gap-0.5 text-[10px] text-pop-cyan hover:underline"
                      onClick={() => openTaskInChat(job.ref_id!)}
                    >
                      打开任务<ChevronRight className="size-2.5" />
                    </button>
                  )}
                  {job?.kind === 'subagent' && job.ref_id && job.session_id && (
                    <button
                      type="button"
                      className="ml-auto inline-flex items-center gap-0.5 text-[10px] text-pop-purple hover:underline"
                      onClick={() => setExpanded(isOpen ? null : e.id)}
                    >
                      {isOpen ? <ChevronDown className="size-2.5" /> : <ChevronRight className="size-2.5" />}
                      子代理详情
                    </button>
                  )}
                </div>
                <div className="mt-0.5 text-[10.5px] text-pop-dim">
                  {payload.summary ?? payload.title ?? payload.status ?? ''}
                </div>
              </div>
            </div>
            {isOpen && job?.kind === 'subagent' && job.session_id && job.ref_id && (
              <div className="mt-1 h-[320px] overflow-hidden rounded-lg border-[1.5px] border-pop-bd bg-pop-paper">
                <SubagentWindow sessionId={job.session_id} agentId={job.ref_id} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
