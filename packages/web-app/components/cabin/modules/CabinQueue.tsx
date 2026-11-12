'use client'

// 通讯队列窗（原型 wbQueue · C4 单线程路由）：行 = 派生 attention（queued）+
// 已转入的 report/handback（done）。路由态是 UI 局部（原型 state.routing），
// 不持久（K3）；点行/优先路由 → chat 底座定位该作业，一次只路由一条。

import { useMemo, useState } from 'react'
import {
  Activity, AlertTriangle, CheckCircle2, ClipboardCheck, HelpCircle, Play, Send, ShieldAlert, Sparkles, Users,
} from 'lucide-react'
import { toast } from 'sonner'
import type { CabinAttentionItem, CabinJobEvent } from '@octopus/shared'
import { getCabinTrace } from '@/lib/cabin-api'
import { useCabinContext } from '../cabin-provider'
import { useEffect } from 'react'
import { Empty, WbNote, openTaskInChat, clockLabel } from './ui'

const COMM_META: Record<string, { label: string; icon: typeof Send; color: string }> = {
  review: { label: '待验收', icon: ClipboardCheck, color: 'text-pop-amber' },
  answer: { label: '待回答', icon: HelpCircle, color: 'text-pop-cyan' },
  finding: { label: '待裁决', icon: Sparkles, color: 'text-pop-purple' },
  approval: { label: '审批', icon: ShieldAlert, color: 'text-pop-pink' },
  blocked: { label: '受阻', icon: AlertTriangle, color: 'text-pop-red' },
  result: { label: '结果', icon: CheckCircle2, color: 'text-pop-green' },
  progress: { label: '进度', icon: Activity, color: 'text-pop-dim' },
}

const STAGE_TO_COMM: Record<CabinAttentionItem['stage'], string> = {
  review: 'review',
  answer: 'answer',
  adjudicate: 'finding',
  approval: 'approval',
  blocked: 'blocked',
}

interface CommRow {
  id: string
  kind: string
  from: string
  role: string
  title: string
  detail: string
  at: string
  taskId?: string | null
  deepLink?: string | null
  state: 'queued' | 'processing' | 'done'
}

export function CabinQueue() {
  const { cabinId, view, openModule } = useCabinContext()
  const [routingId, setRoutingId] = useState<string | null>(null)
  const [prioIds, setPrioIds] = useState<string[]>([])
  const [doneRows, setDoneRows] = useState<CommRow[]>([])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const events = await getCabinTrace(cabinId)
        if (!alive) return
        const done = events
          .filter((e: CabinJobEvent) => e.kind === 'report' || e.kind === 'handback')
          .slice(-6)
          .reverse()
          .map((e) => {
            const payload = (e.payload ?? {}) as { summary?: string; status?: string }
            return {
              id: `ev-${e.id}`,
              kind: e.kind === 'report' ? 'result' : 'progress',
              from: e.actor ?? 'doer',
              role: e.kind === 'report' ? 'task-doer' : 'router',
              title: payload.summary ?? e.kind,
              detail: payload.status ?? '',
              at: clockLabel(e.created_at),
              state: 'done' as const,
            }
          })
        setDoneRows(done)
      } catch {
        /* trace 不可读：队列仍由 attention 驱动 */
      }
    })()
    return () => { alive = false }
  }, [cabinId, view?.attention.length])

  const attention = view?.attention ?? []

  // 已路由的 attention 项从派生视图消失 = 处理完毕 → 转入 done。
  useEffect(() => {
    if (!routingId) return
    if (!attention.some((a) => a.id === routingId)) {
      setRoutingId(null)
    }
  }, [attention, routingId])

  const rows = useMemo<CommRow[]>(() => {
    const queued: CommRow[] = attention.map((a) => ({
      id: a.id,
      kind: STAGE_TO_COMM[a.stage] ?? 'result',
      from: a.repo ?? 'orchestrator',
      role: a.awaiting === 'person' ? '等你' : 'doer',
      title: a.title,
      detail: a.question ?? a.detail ?? '',
      at: a.awaiting,
      taskId: a.task_id,
      deepLink: a.deep_link,
      state: a.id === routingId ? 'processing' : 'queued',
    }))
    // 已优先的排到队首（不打断当前 processing）。
    queued.sort((x, y) => Number(prioIds.includes(y.id)) - Number(prioIds.includes(x.id)))
    return [...queued, ...doneRows]
  }, [attention, routingId, prioIds, doneRows])

  const queuedCount = rows.filter((r) => r.state === 'queued').length
  const processing = rows.find((r) => r.state === 'processing')

  const route = (row: CommRow) => {
    if (row.state === 'done') return
    if (routingId && routingId !== row.id) {
      setPrioIds((prev) => (prev.includes(row.id) ? prev : [...prev, row.id]))
      toast('主 chat 单线程：已优先排到下一位，处理完立即派发')
      return
    }
    setRoutingId(row.id)
    setPrioIds((prev) => prev.filter((id) => id !== row.id))
    if (row.deepLink?.startsWith('finding:')) openModule('knowledge')
    else if (row.taskId) openTaskInChat(row.taskId, row.kind === 'review' ? 'acceptance' : undefined)
    toast(`路由中 · ${row.title} → 主 chat`)
  }

  const next = rows.find((r) => r.state === 'queued')

  return (
    <div data-testid="cabin-queue-body">
      <div className="mb-3 flex items-center gap-2.5">
        <Send className="size-[15px] text-pop-dim" />
        <h3 className="ui-font m-0 text-[14px] font-semibold text-pop-ink">通讯队列 · 单线程路由</h3>
        <button
          type="button"
          data-testid="cabin-queue-next"
          disabled={!queuedCount}
          onClick={() => { if (next) route(next) }}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-pop-bd bg-pop-idle px-2 py-[3px] text-[10.5px] text-pop-dim hover:text-pop-ink disabled:opacity-40"
        >
          <Play className="size-2.5" />处理下一条
        </button>
      </div>

      <div className="mb-2.5 flex items-center gap-2 rounded-lg border-[1.5px] border-pop-bd bg-pop-idle px-3 py-2 text-[11px]">
        <span className={`size-2 rounded-full ${processing ? 'bg-pop-violet animate-pulse' : 'bg-pop-dim'}`} />
        <span className="min-w-0 flex-1 truncate text-pop-dim">
          {processing
            ? <>路由中 · <b className="text-pop-ink">{processing.title}</b> → {processing.from}</>
            : '路由台空闲 · 等待回流，或点击队列项派发'}
        </span>
        <span className="shrink-0 text-pop-dim">待路由 <b className="text-pop-amber">{queuedCount}</b></span>
      </div>

      <WbNote className="mb-3 flex items-start gap-1.5">
        <Users className="mt-px size-3 shrink-0" />
        <span>
          主 chat 单线程：一次只路由一条，处理完等你点下一条。点击队列项可<b className="text-pop-ink">优先派发</b>；
          分身 / 工作树回流会先反馈给汐音，再由她报给你。kind 映射 cabin_job_events
          （review/answer/finding/approval=attention · result=report · progress=内部不 wake），prio 映射 cabin_jobs.priority。
        </span>
      </WbNote>

      {rows.length === 0 ? (
        <Empty>队列已清空 · 舱在自主推进。</Empty>
      ) : rows.map((row) => {
        const meta = COMM_META[row.kind] ?? COMM_META.progress
        const Icon = meta.icon
        const isNext = next?.id === row.id
        return (
          <div
            key={row.id}
            data-comm-row={row.id}
            data-comm-state={row.state}
            onClick={() => route(row)}
            className={`relative mb-2 flex cursor-pointer gap-3 overflow-hidden rounded-[11px] border-[1.5px] border-pop-bd bg-pop-idle p-3 pl-3.5 transition-all ${
              row.state === 'processing' ? 'border-pop-violet/50 shadow-[0_0_0_1px_rgba(167,139,250,.2)]' : ''
            } ${row.state === 'done' ? 'opacity-60' : ''}`}
          >
            <span className={`absolute bottom-0 left-0 top-0 w-[3px] ${
              row.state === 'queued' ? 'bg-pop-amber' : row.state === 'processing' ? 'bg-pop-violet' : 'bg-pop-green'
            }`} />
            <div className={`grid size-8 shrink-0 place-items-center rounded-[9px] border border-pop-bd bg-pop-paper ${meta.color}`}>
              <Icon className="size-[15px]" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[10.5px] text-pop-dim">
                <span className="font-semibold text-pop-ink">{row.from}</span>
                <span>{row.role}</span>
                {isNext && <span className="rounded bg-pop-violet/15 px-1.5 text-[9.5px] font-bold text-pop-violet">下一条</span>}
                {prioIds.includes(row.id) && row.state === 'queued' && (
                  <span className="rounded bg-pop-pink/15 px-1.5 text-[9.5px] font-bold text-pop-pink">已优先</span>
                )}
                <span className="ml-auto">{row.at}</span>
              </div>
              <div className="mt-0.5 truncate text-[12px] font-semibold text-pop-ink">{row.title}</div>
              <div className="truncate text-[10.5px] text-pop-dim">{row.detail}</div>
              <div className="mt-1 flex items-center gap-2">
                <span className={`text-[9.5px] font-bold ${meta.color}`}>{meta.label}</span>
                <span className="text-[10px] text-pop-dim">
                  {row.state === 'processing' ? '◠ 处理中' : row.state === 'done' ? '✓ 已转入' : '● 排队中'}
                </span>
                {row.state === 'queued' && (
                  <button
                    type="button"
                    data-testid={`cabin-queue-route-${row.id}`}
                    onClick={(e) => { e.stopPropagation(); route(row) }}
                    className="ml-auto inline-flex items-center gap-1 rounded border border-pop-bd bg-pop-bg px-1.5 py-px text-[9.5px] text-pop-dim hover:text-pop-ink"
                  >
                    <Send className="size-2.5" />优先路由
                  </button>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
