'use client'

// 舱模块窗共享原语 —— 逐字对照原型 docs/cabin-design/index.html 的 window body
// CSS（wb-h/wb-sec/wb-note/wt/sbadge/iterline/tcard/kanban/ledger/empty/wbtn）。
// 数据一律来自服务端派生视图（K3），这里只负责呈现。

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { listTasks, getTask, type TaskView } from '@/lib/tasks-api'
import type { TaskDerivedView } from '@/lib/tasks-api'
import { effectiveStatusOf, computePhaseBadge } from '@/lib/task-board'

export function WbH({ icon: Icon, title, cap, children }: {
  icon: LucideIcon; title: string; cap?: string; children?: ReactNode
}) {
  return (
    <div className="mb-3.5 flex items-center gap-2.5">
      <Icon className="size-[15px] shrink-0 text-pop-dim" />
      <h3 className="ui-font m-0 text-[14px] font-semibold text-pop-ink">{title}</h3>
      {cap && <span className="ui-font ml-auto text-[10.5px] text-pop-dim">{cap}</span>}
      {children}
    </div>
  )
}

export function WbSec({ children, cap }: { children: ReactNode; cap?: ReactNode }) {
  return (
    <div className="ui-font mb-2 mt-4 flex items-center gap-2 text-[12px] font-semibold text-pop-dim">
      {children}
      {cap != null && <span className="ml-auto font-normal">{cap}</span>}
    </div>
  )
}

export function WbNote({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('ui-font text-[11px] leading-relaxed text-pop-dim', className)}>{children}</div>
}

export function WBtn({ pri, onClick, title, testId, children, disabled }: {
  pri?: boolean; onClick?: () => void; title?: string; testId?: string; children: ReactNode; disabled?: boolean
}) {
  return (
    <button
      type="button"
      title={title}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-[3px] text-[10.5px] transition-colors',
        pri
          ? 'border-pop-pink bg-pop-pink font-semibold text-pop-bg hover:opacity-90'
          : 'border-pop-bd bg-pop-idle text-pop-dim hover:border-pop-dim hover:text-pop-ink',
        disabled && 'cursor-default opacity-40',
      )}
    >
      {children}
    </button>
  )
}

export type SBadgeColor = 'cyan' | 'green' | 'amber' | 'pink' | 'red' | 'purple' | 'navy' | 'dim' | 'violet'

const SBADGE_BG: Record<SBadgeColor, string> = {
  cyan: 'bg-pop-cyan text-pop-bg',
  green: 'bg-pop-green text-pop-bg',
  amber: 'bg-pop-amber text-pop-bg',
  pink: 'bg-pop-pink text-pop-bg',
  red: 'bg-pop-red text-pop-bg',
  purple: 'bg-pop-purple text-pop-bg',
  navy: 'bg-pop-navy text-white',
  dim: 'bg-pop-dim text-pop-bg',
  violet: 'bg-pop-violet text-pop-bg',
}

export function SBadge({ color, pulse, children }: { color: SBadgeColor; pulse?: boolean; children: ReactNode }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-px text-[10px] font-semibold',
      SBADGE_BG[color], pulse && 'animate-pulse',
    )}>
      {children}
    </span>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="ui-font rounded-xl border-[1.5px] border-dashed border-pop-bd p-7 text-center text-pop-dim">
      {children}
    </div>
  )
}

/** 原型 STATUS / pill：任务派生状态 → 徽章色 + 中文标签。 */
export const CABIN_TASK_STATUS_META: Record<string, { label: string; color: SBadgeColor; pulse?: boolean }> = {
  draft: { label: '草稿', color: 'cyan' },
  ready: { label: '待执行', color: 'navy' },
  running: { label: '执行中', color: 'green', pulse: true },
  paused: { label: '已暂停', color: 'dim' },
  awaiting_review: { label: '待验收', color: 'amber' },
  awaiting_archive: { label: '待归档', color: 'pink' },
  archiving: { label: '归档中', color: 'purple' },
  done: { label: '完成', color: 'green' },
  failed: { label: '失败', color: 'red' },
  aborted: { label: '中止', color: 'dim' },
}

export function TaskStatusBadge({ status }: { status: string }) {
  const meta = CABIN_TASK_STATUS_META[status] ?? { label: status, color: 'dim' as SBadgeColor }
  return <SBadge color={meta.color} pulse={meta.pulse}>{meta.label}</SBadge>
}

export function IterLine({ code, name, meta, pct, active }: {
  code: string; name: string; meta: string; pct: number; active?: boolean
}) {
  return (
    <div className="mb-2 flex items-center gap-3 rounded-[9px] border-[1.5px] border-pop-bd bg-pop-idle px-3 py-2.5">
      <div className={cn(
        'grid size-[38px] shrink-0 place-items-center rounded-[9px] font-extrabold',
        active ? 'bg-pop-pink/15 text-pop-pink' : 'bg-pop-navy/15 text-pop-navy',
      )}>
        {code}
      </div>
      <div className="min-w-0 flex-1">
        <b className="ui-font block text-[12.5px] text-pop-ink">{name}</b>
        <div className="mt-0.5 text-[10.5px] text-pop-dim">{meta}</div>
      </div>
      <div className="w-[150px] shrink-0">
        <div className="mb-1 text-right text-[10px] text-pop-dim">{pct}%</div>
        <div className="h-[5px] overflow-hidden rounded-[3px] bg-pop-bg">
          <i className={cn('block h-full', active ? 'bg-pop-violet' : 'bg-pop-cyan')} style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  )
}

export interface CabinTaskRow extends TaskView {
  derived?: TaskDerivedView
}

export function taskDisplayStatus(t: CabinTaskRow): string {
  return effectiveStatusOf(t, t.derived)
}

export function TCard({ task, onClick }: { task: CabinTaskRow; onClick?: () => void }) {
  const status = taskDisplayStatus(task)
  const badge = computePhaseBadge(task.derived)
  return (
    <button
      type="button"
      data-task-card={task.id}
      onClick={onClick}
      className="mb-2 block w-full rounded-[9px] border-[1.5px] border-pop-bd bg-pop-paper p-2.5 text-left transition-all hover:-translate-y-px hover:border-pop-pink"
    >
      <b className="ui-font mb-1 block text-[12px] text-pop-ink">{task.name}</b>
      <div className="flex flex-wrap gap-1.5 text-[10px] text-pop-dim">
        <span>{task.repo_group ?? '—'}</span>
        <span className="text-pop-cyan">{task.workflow_ref ?? ''}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <TaskStatusBadge status={status} />
        <span className="ml-auto text-[9.5px] text-pop-dim">
          {badge ? `ph${badge.phase}/${badge.total} · r${badge.round ?? 0}` : ''}
        </span>
      </div>
    </button>
  )
}

/** 舱内任务列表 + 派生视图（list 不带 derived，逐任务 GET /:id 补；轮询活态）。 */
export function useCabinTasks(cabinId: string | null) {
  const [tasks, setTasks] = useState<CabinTaskRow[]>([])
  const [loading, setLoading] = useState(true)
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [cabinId])

  const refresh = useCallback(async () => {
    if (!cabinId) return
    try {
      const { items } = await listTasks({ cabin_id: cabinId })
      const withDerived = await Promise.all(items.map(async (t) => {
        try {
          const detail = await getTask(t.id)
          return { ...t, derived: detail.derived } as CabinTaskRow
        } catch {
          return t as CabinTaskRow
        }
      }))
      if (aliveRef.current) setTasks(withDerived)
    } catch {
      /* 舱不存在等：保持空列表 */
    } finally {
      if (aliveRef.current) setLoading(false)
    }
  }, [cabinId])

  useEffect(() => {
    setLoading(true)
    void refresh()
  }, [refresh])

  // 模块窗常驻轮询：恢复/聚焦时也要拿到活态（不依赖首帧是否有 live 任务）。
  useEffect(() => {
    const timer = setInterval(() => { void refresh() }, 10_000)
    return () => clearInterval(timer)
  }, [refresh])

  return { tasks, loading, refresh }
}

/** 与桌面同一跨应用协议：chat 底座 select-task（可带验收/变更窗）。 */
export function openTaskInChat(taskId: string, view?: 'acceptance' | 'changes') {
  window.dispatchEvent(new CustomEvent('octopus:open-task', { detail: { taskId, ...(view ? { view } : {}) } }))
}

export function clockLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
