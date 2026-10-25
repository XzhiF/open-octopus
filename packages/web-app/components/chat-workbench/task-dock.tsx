'use client'

import {
  ClipboardCheck,
  FileDiff,
  FolderTree,
  Package,
  Workflow,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TaskModule, TaskWindowMap } from './task-window-types'

const MODULES: Array<{
  id: TaskModule
  label: string
  icon: LucideIcon
  enabled: boolean
  title: string
}> = [
  { id: 'changes', label: '变更', icon: FileDiff, enabled: true, title: '变更 · Git Diff' },
  { id: 'artifacts', label: '产物', icon: Package, enabled: false, title: '产物 · 即将上线' },
  { id: 'files', label: '文件', icon: FolderTree, enabled: false, title: '文件 · 即将上线' },
  { id: 'workflow', label: '工作流', icon: Workflow, enabled: false, title: '工作流 · 即将上线' },
  { id: 'acceptance', label: '验收', icon: ClipboardCheck, enabled: false, title: '验收 · 即将上线' },
]

interface TaskDockProps {
  windows: TaskWindowMap
  onToggle: (module: TaskModule) => void
}

/** Small floating task launcher: icon-only, never narrows the chat. */
export function TaskDock({ windows, onToggle }: TaskDockProps) {
  return (
    <div
      data-testid="task-dock"
      aria-label="任务工作台"
      className="absolute right-3 top-1/2 z-[70] flex -translate-y-1/2 flex-col gap-0.5 rounded-[14px] border border-white/[0.08] bg-pop-paper/85 p-1 shadow-pop-lg backdrop-blur-xl"
    >
      {MODULES.map((module) => {
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
