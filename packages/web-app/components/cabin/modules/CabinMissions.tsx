'use client'

// 作战清单窗（原型 missions = taskPanel · P4）：从输入区移出的常驻作战面板，
// 需要时由汐音或作业坞唤出，不占用指挥台。结构逐字对照原型 .taskpanel：
// tp-h（hex+标题+MISSION·code+ring 点阵+done/total+chev 折叠）→ tp-sum（运行/
// 需要你/完成）→ tp-rows（≤5 条 running/awaiting_review/ready/draft：icon+名+
// P·R coord+tbar+pill）→ tp-foot。进度派生自 phaseViews（K3），无派生时回落
// 原型状态启发式。运行中 accent 用生产定稿紫罗兰（与 CabinRun 一致）。

import { useState } from 'react'
import { ChevronDown, ClipboardCheck, Hexagon, ListTodo, Play } from 'lucide-react'
import { cn } from '@/lib/utils'
import { computePhaseBadge } from '@/lib/task-board'
import { useCabinContext } from '../cabin-provider'
import { useCabinTasks, taskDisplayStatus, Empty, WbNote, openTaskInChat, type CabinTaskRow } from './ui'

const MISSION_STATUSES = ['running', 'awaiting_review', 'ready', 'draft']

const PILL: Record<string, { label: string; color: string }> = {
  running: { label: '进行中', color: 'var(--pop-violet)' },
  awaiting_review: { label: '待验收', color: 'var(--pop-amber)' },
  ready: { label: '待执行', color: 'var(--pop-navy)' },
  draft: { label: '草稿', color: 'var(--pop-dim)' },
}

function missionPct(t: CabinTaskRow): number {
  const status = taskDisplayStatus(t)
  if (status === 'done') return 100
  if (status === 'awaiting_review') return 92
  if (status === 'ready') return 8
  if (status !== 'running') return 0
  const phases = t.derived?.phaseViews ?? []
  if (phases.length > 0) {
    const current = phases.find((p) => p.status !== 'accepted') ?? phases[phases.length - 1]
    return Math.min(85, Math.round(((current.index - 1) / phases.length) * 100) + 38)
  }
  const round = computePhaseBadge(t.derived)?.round ?? 1
  return Math.min(85, 38 + round * 16)
}

function RowIcon({ status, className }: { status: string; className?: string }) {
  const Icon = status === 'running' ? Play : status === 'awaiting_review' ? ClipboardCheck : ListTodo
  return <Icon className={cn('size-[13px]', className)} />
}

export function CabinMissions() {
  const { cabinId, view } = useCabinContext()
  const { tasks } = useCabinTasks(cabinId)
  const [collapsed, setCollapsed] = useState(false)

  const active = tasks.filter((t) => MISSION_STATUSES.includes(taskDisplayStatus(t))).slice(0, 5)
  const done = tasks.filter((t) => taskDisplayStatus(t) === 'done').length
  const running = tasks.filter((t) => taskDisplayStatus(t) === 'running').length
  const need = view?.attention.length ?? 0
  const allDone = tasks.length > 0 && done === tasks.length
  const code = view?.iterations.find((i) => i.status === 'active')?.code ?? 'M1'

  return (
    <div className="max-w-[600px]" data-testid="cabin-missions-body">
      {active.length === 0 ? (
        <Empty>暂无进行中的作战任务。</Empty>
      ) : (
        <div
          className={cn(
            'mb-1.5 overflow-hidden rounded-xl border-2 bg-pop-paper shadow-[var(--pop-shadow-sm)]',
            allDone ? 'border-pop-green/35' : 'border-pop-bd',
          )}
          data-testid="cabin-missions-panel"
        >
          <button
            type="button"
            data-testid="cabin-missions-toggle"
            onClick={() => setCollapsed((v) => !v)}
            className="flex w-full items-center gap-2 px-3 py-[7px] text-left"
          >
            <span className="grid shrink-0 place-items-center text-pop-violet">
              <Hexagon className="size-3.5" />
            </span>
            <span className="ui-font text-[11.5px] font-extrabold tracking-[.05em] text-pop-ink">作战清单</span>
            <span className="rounded-[5px] border border-pop-violet/40 px-1.5 py-px font-mono text-[8.5px] font-bold tracking-[.06em] text-pop-violet">
              MISSION · {code}
            </span>
            <span className="ml-0.5 flex gap-0.5" data-testid="cabin-missions-ring">
              {tasks.slice(0, 10).map((t) => {
                const s = taskDisplayStatus(t)
                return (
                  <i
                    key={t.id}
                    className={cn(
                      'h-[5px] w-[9px] -skew-x-12 rounded-[2px]',
                      s === 'done' ? 'bg-pop-green' : s === 'running' ? 'bg-pop-violet shadow-[0_0_5px_var(--pop-violet)]' : 'bg-pop-bd',
                    )}
                  />
                )
              })}
            </span>
            <span className="ml-auto rounded-full border border-pop-amber/35 bg-pop-amber/15 px-[7px] font-mono text-[9.5px] text-pop-amber">
              {done}/{tasks.length}
            </span>
            <ChevronDown className={cn('size-3 shrink-0 text-pop-dim transition-transform', collapsed && '-rotate-90')} />
          </button>

          {!collapsed && (
            <>
              <div className="flex items-center gap-3 px-[15px] pb-[7px] font-mono text-[9.5px] text-pop-dim">
                <span className="flex items-center gap-[5px]">
                  <i className="size-1.5 rounded-full bg-pop-green shadow-[0_0_5px_var(--pop-green)]" />运行 <b className="text-pop-ink">{running}</b>
                </span>
                <span className="flex items-center gap-[5px]">
                  <i className="size-1.5 rounded-full bg-pop-amber" />需要你 <b className="text-pop-ink">{need}</b>
                </span>
                <span className="flex items-center gap-[5px]">
                  <i className="size-1.5 rounded-full bg-pop-dim" />完成 <b className="text-pop-ink">{done}</b>
                </span>
              </div>

              <div className="px-2 pb-1.5 pt-0.5" data-testid="cabin-missions-rows">
                {active.map((t) => {
                  const status = taskDisplayStatus(t)
                  const isActive = status === 'running'
                  const isDone = status === 'done'
                  const badge = computePhaseBadge(t.derived)
                  const pill = PILL[status] ?? { label: status, color: 'var(--pop-dim)' }
                  const pct = missionPct(t)
                  return (
                    <div
                      key={t.id}
                      data-mission-row={t.id}
                      onClick={() => openTaskInChat(t.id)}
                      title="在主 chat 打开任务"
                      className={cn(
                        'relative flex cursor-pointer items-center gap-[9px] overflow-hidden rounded-[7px] px-[9px] py-[5px] text-[11.5px] leading-[1.3] transition-colors hover:bg-white/[0.03]',
                        isActive && 'bg-pop-violet/10 shadow-[inset_2px_0_0_var(--pop-violet)]',
                        isDone && 'text-pop-dim/80 line-through decoration-pop-green/40',
                      )}
                    >
                      <span className={cn('grid size-[15px] shrink-0 place-items-center', isActive ? 'text-pop-violet' : 'text-pop-dim')}>
                        <RowIcon status={status} />
                      </span>
                      <span className="ui-font min-w-0 flex-1 truncate">{t.name}</span>
                      <span className="shrink-0 rounded border border-pop-bd px-[5px] font-mono text-[8.5px] text-pop-dim">
                        {badge ? `P${badge.phase}·R${badge.round ?? 0}` : 'P1·R0'}
                      </span>
                      <span className="h-1 w-[54px] shrink-0 overflow-hidden rounded-[2px] bg-white/[0.08]">
                        <i
                          className={cn('block h-full rounded-[2px] transition-all duration-700', isDone ? 'bg-pop-green' : 'bg-pop-violet')}
                          style={{ width: `${pct}%` }}
                        />
                      </span>
                      <span
                        className="shrink-0 rounded-full px-[7px] py-px text-[8.5px] font-bold"
                        style={{ color: pill.color, background: `color-mix(in srgb, ${pill.color} 15%, transparent)` }}
                      >
                        {pill.label}
                      </span>
                    </div>
                  )
                })}
              </div>

              <div className="border-t border-white/[0.06] px-3 py-[5px] text-[10px] text-pop-dim">
                <span className="mr-1">▸</span>
                {done} 完成 · {tasks.length - done} 待办 · 指挥在主 chat
              </div>
            </>
          )}
        </div>
      )}
      <WbNote className="mt-2.5">
        作战清单从输入区移到这里 —— 需要时由汐音或作业坞唤出，不占用指挥台。完整看板见「任务」。
      </WbNote>
    </div>
  )
}
