'use client'

import { useLayoutEffect, useRef, useState } from 'react'
import { TaskChatTab } from '@/components/tasks/run-console/chat/chat-tab'
import { TASK_STATUS_LABEL } from '@/components/tasks/run-console/phase-status'
import type { TaskView } from '@/lib/tasks-api'
import { cascadeRect, type Size } from '@/lib/window-geometry'
import { ChangesWindow } from './changes-window'
import { ExpertsWindow } from './experts-window'
import { TaskConsoleWindow } from './task-console-window'
import { TaskDock } from './task-dock'
import { TaskPlanWindow } from './task-plan-window'
import { TaskRunCenter } from './task-run-center'
import { TaskWindow } from './task-window'
import type { TaskModule, TaskWindowMap, TaskWindowRecord } from './task-window-types'

const MODULE_TITLE: Record<TaskModule, string> = {
  plan: '计划',
  run: '运行',
  changes: '变更',
  acceptance: '验收',
  experts: '专家',
}

interface TaskWorkbenchProps {
  task: TaskView
  windows: TaskWindowMap
  onWindowsChange: (next: TaskWindowMap) => void
  onMutated?: () => void
}

/**
 * Chat stays the center. There is no extra chrome row: task identity is a
 * document heading inside the transcript, and modules open as task windows.
 */
export function TaskWorkbench({ task, windows, onWindowsChange, onMutated }: TaskWorkbenchProps) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })

  useLayoutEffect(() => {
    const element = bodyRef.current
    if (!element) return
    const update = () => setSize({ width: element.clientWidth, height: element.clientHeight })
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const recordList = Object.values(windows).filter(
    (record): record is TaskWindowRecord => !!record,
  )
  const openRecords = recordList.filter((record) => !record.minimized)
  const focusedModule =
    [...openRecords].sort((a, b) => b.z - a.z)[0]?.module ?? null
  const maxZ = Math.max(10, ...recordList.map((record) => record.z))

  const updateWindow = (module: TaskModule, patch: Partial<TaskWindowRecord>) => {
    const current = windows[module]
    if (!current) return
    onWindowsChange({ ...windows, [module]: { ...current, ...patch } })
  }

  const toggleModule = (module: TaskModule) => {
    const current = windows[module]
    if (current) {
      if (current.minimized) {
        updateWindow(module, { minimized: false, z: maxZ + 1 })
      } else if (focusedModule === module) {
        updateWindow(module, { minimized: true })
      } else {
        updateWindow(module, { z: maxZ + 1 })
      }
      return
    }
    const stage = size.width > 0 ? size : { width: 900, height: 600 }
    const preferred =
      module === 'run' || module === 'acceptance'
        ? { width: 1180, height: 720 }
        : module === 'plan'
          ? { width: 980, height: 640 }
          : module === 'experts'
            ? { width: 760, height: 560 }
            : { width: 1100, height: 640 }
    const record: TaskWindowRecord = {
      module,
      rect: cascadeRect(stage, 0, preferred),
      minimized: false,
      maximized: false,
      restoreRect: null,
      z: maxZ + 1,
    }
    onWindowsChange({ ...windows, [module]: record })
  }

  const closeWindow = (module: TaskModule) => {
    const next = { ...windows }
    delete next[module]
    onWindowsChange(next)
  }

  const execution = task.execution
  const phase =
    execution?.phase_index != null
      ? `P${execution.phase_index}${execution.round_index != null ? ` · R${execution.round_index}` : ''}`
      : null
  const meta = [TASK_STATUS_LABEL[task.status] ?? task.status, phase].filter(Boolean).join(' · ')

  return (
    <div data-testid="task-workbench" className="ui-font flex min-h-0 flex-1 flex-col">
      <div
        ref={bodyRef}
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
        data-testid="task-workbench-body"
      >
        <div className="flex min-h-0 flex-1 flex-col">
          {task.status === 'awaiting_review' ? (
            <TaskChatTab
              taskId={task.id}
              form="quick-edit"
              hideHeader
              heading={
                <div className="mb-3">
                  <h1 className="text-[16px] font-semibold tracking-[-0.015em] text-pop-ink">
                    {task.name}
                  </h1>
                  <p className="mt-1 text-[11px] text-pop-dim">{meta}</p>
                </div>
              }
            />
          ) : (
            <TaskRunCenter task={task} onMutated={onMutated} />
          )}
        </div>

        {size.width > 0 && openRecords.map((record) => {
          const module = record.module
          return (
            <TaskWindow
              key={module}
              record={record}
              title={`${MODULE_TITLE[module]} · ${task.name}`}
              container={size}
              focused={focusedModule === module}
              zIndex={20 + record.z}
              onChange={(patch) => updateWindow(module, patch)}
              onClose={() => closeWindow(module)}
              onFocus={() => {
                if (focusedModule !== module) updateWindow(module, { z: maxZ + 1 })
              }}
            >
              {module === 'changes' ? (
                <ChangesWindow task={task} />
              ) : module === 'plan' ? (
                <TaskPlanWindow task={task} />
              ) : module === 'run' ? (
                <TaskConsoleWindow
                  task={task}
                  onClose={() => closeWindow(module)}
                  onMutated={onMutated}
                />
              ) : module === 'acceptance' ? (
                <TaskConsoleWindow
                  task={task}
                  startOnAcceptance
                  onClose={() => closeWindow(module)}
                  onMutated={onMutated}
                />
              ) : (
                <ExpertsWindow task={task} onMutated={onMutated} />
              )}
            </TaskWindow>
          )
        })}

        <TaskDock task={task} windows={windows} onToggle={toggleModule} />
      </div>
    </div>
  )
}
