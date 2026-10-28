'use client'

// 2026-10-28 task-thread: the persistent task context above the ONE main chat.
// Informational only — actions live on the transcript event cards and the dock
// (one action, one home). The identity is DERIVED from the task state, never
// from a local toggle.

import type { TaskView } from '@/lib/tasks-api'
import { cn } from '@/lib/utils'

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  ready: '待执行',
  running: '运行中',
  paused: '已暂停',
  awaiting_review: '待验收',
  archiving: '归档中',
  done: '已完成',
  aborted: '已中止',
  failed: '失败',
}

const STATUS_TONE: Record<string, string> = {
  draft: 'bg-pop-cyan text-pop-bg',
  ready: 'bg-pop-cyan text-pop-bg',
  running: 'bg-pop-green text-pop-bg',
  paused: 'bg-pop-amber text-pop-bg',
  awaiting_review: 'bg-pop-amber text-pop-bg',
  archiving: 'bg-pop-amber text-pop-bg animate-pulse',
  done: 'bg-pop-green text-pop-bg',
  aborted: 'bg-pop-red text-pop-bg',
  failed: 'bg-pop-red text-pop-bg',
}

function identityOf(status: string): { label: string; tone: string; dot: string } {
  if (status === 'draft') {
    return { label: '✦ 任务作者', tone: 'border-pop-purple/40 bg-pop-purple-soft text-pop-purple', dot: 'bg-pop-purple' }
  }
  if (status === 'done' || status === 'aborted' || status === 'failed') {
    return { label: '⬢ 主控 Agent', tone: 'border-pop-cyan/40 bg-pop-cyan-soft text-pop-cyan', dot: 'bg-pop-cyan' }
  }
  if (status === 'ready') {
    return { label: '▶ 执行者待命', tone: 'border-pop-green/40 bg-pop-green-soft text-pop-green', dot: 'bg-pop-green' }
  }
  if (status === 'archiving') {
    return { label: '▶ 执行者 · 只读', tone: 'border-pop-green/30 bg-pop-green-soft text-pop-green', dot: 'bg-pop-green' }
  }
  return { label: '▶ 执行者', tone: 'border-pop-green/40 bg-pop-green-soft text-pop-green', dot: 'bg-pop-green' }
}

export function TaskStatusStrip({ task }: { task: TaskView }) {
  const status = task.status
  const identity = identityOf(status)
  const phase = task.execution?.phase_index ?? null
  const round = task.execution?.round_index ?? null
  const coord = phase != null ? `P${phase}${round != null ? ` · R${round}` : ''}` : null

  return (
    <div
      data-testid="task-status-strip"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/[0.06] bg-pop-paper/35 px-4 py-1.5"
    >
      <span
        data-task-strip-status={status}
        className={cn(
          'inline-flex items-center rounded-[5px] px-2 py-[3px] font-mono text-[9px] font-black tracking-[.06em]',
          STATUS_TONE[status] ?? 'bg-pop-idle text-pop-dim',
        )}
      >
        {STATUS_LABEL[status] ?? status}
      </span>
      <span className="min-w-0 max-w-[300px] truncate text-[12px] font-black text-pop-ink">{task.name}</span>
      {coord && <span className="font-mono text-[9.5px] text-pop-dim" data-testid="task-strip-coord">{coord}</span>}
      <span
        data-testid="task-strip-identity"
        className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-[3px] font-mono text-[9px] font-black', identity.tone)}
      >
        <span className={cn('size-1.5 rounded-full', identity.dot)} />
        {identity.label}
      </span>
      <span className="ml-auto hidden font-mono text-[9px] text-pop-dim sm:block">
        {task.repo_group ?? "—"}
        {task.workspace_id ? ' · 执行工作区' : ''}
      </span>
    </div>
  )
}
