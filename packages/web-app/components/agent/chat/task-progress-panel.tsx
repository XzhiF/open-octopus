'use client'

import { useState } from 'react'
import { Check, ChevronDown, ChevronRight, Circle, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TaskProgress, TaskProgressItem } from '@/lib/agent/task-progress'

interface TaskProgressPanelProps {
  progress: TaskProgress
  className?: string
}

/**
 * Composer 上方的常驻任务清单（Claude Code 风格）。
 *
 * 数据来自 tool_calls 时序（见 lib/agent/task-progress.ts）：
 * 进行中显示 activeForm，完成/待办显示 subject；完成后整卡转绿，可手动收起。
 */
export function TaskProgressPanel({ progress, className }: TaskProgressPanelProps) {
  const [collapsed, setCollapsed] = useState(false)
  const { items, total, done, active, allDone } = progress
  const current = active ? (active.activeForm ?? active.subject) : null

  return (
    <section
      data-task-progress
      data-task-done={allDone ? 'true' : undefined}
      aria-label="任务进度"
      className={cn(
        'overflow-hidden rounded-xl border-2 bg-pop-paper shadow-pop-sm',
        allDone ? 'border-pop-green/35' : 'border-pop-bd',
        className,
      )}
    >
      <button
        type="button"
        data-task-progress-toggle
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-pop-yellow-soft/25"
      >
        <span aria-hidden className="shrink-0 text-[12px] leading-none text-pop-pink">✳</span>
        <span className="shrink-0 font-mono text-[11.5px] font-semibold text-pop-ink">任务清单</span>
        <span
          data-task-progress-count
          className={cn(
            'shrink-0 rounded-full border px-1.5 py-px font-mono text-[9.5px] tabular-nums',
            allDone
              ? 'border-pop-green/35 bg-pop-green-soft text-pop-green'
              : 'border-pop-amber/35 bg-pop-amber-soft text-pop-amber',
          )}
        >
          {allDone ? `全部完成 ${total}/${total}` : `${done}/${total}`}
        </span>
        {collapsed && current && (
          <span className="min-w-0 truncate font-mono text-[10.5px] text-pop-dim">
            {allDone ? '本轮任务已全部完成' : `进行中 · ${current}`}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-[3px]" aria-hidden>
          {items.slice(0, 10).map((item) => (
            <span
              key={item.id}
              className={cn(
                'h-1 w-3 rounded-sm',
                item.status === 'completed'
                  ? 'bg-pop-green'
                  : item.status === 'in_progress'
                    ? 'bg-pop-amber'
                    : 'bg-pop-bd',
              )}
            />
          ))}
          {items.length > 10 && (
            <span className="font-mono text-[9px] leading-none text-pop-dim">+{items.length - 10}</span>
          )}
        </span>
        {collapsed ? (
          <ChevronRight className="size-3.5 shrink-0 text-pop-dim" aria-hidden />
        ) : (
          <ChevronDown className="size-3.5 shrink-0 text-pop-dim" aria-hidden />
        )}
      </button>

      {!collapsed && (
        <div data-task-progress-body>
          <ul className="max-h-[200px] overflow-y-auto px-1 pb-0.5 [scrollbar-width:thin]">
            {items.map((item) => (
              <TaskRow key={item.id} item={item} />
            ))}
          </ul>
          <div className="flex items-center gap-2 border-t border-white/[0.06] px-2.5 pb-1 pt-1 font-mono text-[10px] text-pop-dim">
            {allDone ? (
              <span className="text-pop-green">✓ 全部完成</span>
            ) : current ? (
              <span className="min-w-0 truncate">
                当前：<span className="text-pop-amber">{current}</span>
              </span>
            ) : null}
            <span className="ml-auto shrink-0 tabular-nums">
              {done} 完成 · {total - done} 待办
            </span>
          </div>
        </div>
      )}
    </section>
  )
}

function TaskRow({ item }: { item: TaskProgressItem }) {
  const isActive = item.status === 'in_progress'
  const isDone = item.status === 'completed'

  return (
    <li
      data-task-item
      data-task-status={item.status}
      className={cn(
        'flex items-center gap-2 rounded px-1.5 py-[3px] font-mono text-[11.5px] leading-tight',
        isActive && 'bg-pop-amber-soft text-pop-ink shadow-[inset_2px_0_0_var(--pop-amber)]',
        isDone && 'text-pop-dim/80',
        !isActive && !isDone && 'text-pop-dim',
      )}
    >
      <span className="grid size-3.5 shrink-0 place-items-center" aria-hidden>
        {isDone ? (
          <Check className="size-3 text-pop-green" />
        ) : isActive ? (
          <Loader2 className="size-3 animate-spin text-pop-amber" />
        ) : (
          <Circle className="size-2.5 text-pop-dim/60" />
        )}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate',
          isDone && 'line-through decoration-pop-green/40',
          isActive && 'font-semibold',
        )}
      >
        {isActive ? (item.activeForm ?? item.subject) : item.subject}
      </span>
      {isActive && <span className="shrink-0 text-[9px] text-pop-amber">进行中</span>}
    </li>
  )
}
