'use client'

import {
  Activity,
  ClipboardCheck,
  FileDiff,
  FileText,
  Users,
  type LucideIcon,
} from 'lucide-react'
import type { TaskView } from '@/lib/tasks-api'
import { cn } from '@/lib/utils'
import type { TaskModule, TaskWindowMap } from './task-window-types'

interface DockModule {
  id: TaskModule
  label: string
  icon: LucideIcon
  enabled: boolean
  title: string
}

interface TaskDockProps {
  task: TaskView
  windows: TaskWindowMap
  onToggle: (module: TaskModule) => void
}

/** Small floating task launcher on the right: icon-only, never narrows the chat. */
export function TaskDock({ task, windows, onToggle }: TaskDockProps) {
  const nonDraft = task.status !== 'draft'
  const terminal = ['awaiting_review', 'archiving', 'done', 'failed', 'aborted'].includes(task.status)
  const modules: DockModule[] = [
    { id: 'plan', label: '计划', icon: FileText, enabled: true, title: '计划与产物' },
    {
      id: 'run',
      label: '运行',
      icon: Activity,
      enabled: nonDraft,
      title: nonDraft ? '运行日志 / 节点事件' : '草稿期暂无运行',
    },
    {
      id: 'changes',
      label: '变更',
      icon: FileDiff,
      enabled: nonDraft,
      title: nonDraft ? '变更 · Git Diff' : '执行后才有变更',
    },
    {
      id: 'acceptance',
      label: '验收',
      icon: ClipboardCheck,
      enabled: terminal,
      title: terminal ? '验收控制台' : '待验收后可用',
    },
    { id: 'experts', label: '专家', icon: Users, enabled: true, title: '任务固定专家' },
  ]

  return (
    <div
      data-testid="task-dock"
      aria-label="任务工作台"
      className="absolute right-3 top-1/2 z-[70] flex -translate-y-1/2 flex-col gap-0.5 rounded-[14px] border border-white/[0.08] bg-pop-paper/85 p-1 shadow-pop-lg backdrop-blur-xl"
    >
      {modules.map((module) => {
        const Icon = module.icon
        const record = windows[module.id]
        const active = !!record && !record.minimized
        const minimized = !!record?.minimized
        return (
          <button
            key={module.id}
            type="button"
            data-dock-module={module.id}
            data-active={active ? 'true' : undefined}
            data-minimized={minimized ? 'true' : undefined}
            aria-label={module.label}
            title={module.title}
            disabled={!module.enabled}
            onClick={() => {
              if (module.enabled) onToggle(module.id)
            }}
            className={cn(
              'relative grid size-[30px] place-items-center rounded-[8px] transition-colors',
              !module.enabled && 'cursor-not-allowed text-pop-dim/30',
              module.enabled &&
                (active
                  ? 'bg-pop-yellow-soft text-pop-yellow'
                  : 'text-pop-dim hover:bg-white/[0.06] hover:text-pop-ink'),
              minimized && 'opacity-55',
            )}
          >
            <Icon className="size-[15px]" strokeWidth={1.7} />
            {minimized && (
              <span className="absolute -bottom-0.5 left-1/2 size-1 -translate-x-1/2 rounded-full bg-pop-amber" />
            )}
          </button>
        )
      })}
    </div>
  )
}
