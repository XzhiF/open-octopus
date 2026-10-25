'use client'

import { useLayoutEffect, useRef, useState } from 'react'
import { TaskChatTab } from '@/components/tasks/run-console/chat/chat-tab'
import { TASK_STATUS_LABEL } from '@/components/tasks/run-console/phase-status'
import type { TaskView } from '@/lib/tasks-api'
import { cascadeRect, type Size } from '@/lib/window-geometry'
import { ChangesWindow } from './changes-window'
import { TaskDock } from './task-dock'
import { TaskWindow } from './task-window'
import type { TaskModule, TaskWindowMap, TaskWindowRecord } from './task-window-types'

interface TaskWorkbenchProps {
  task: TaskView
  windows: TaskWindowMap
  onWindowsChange: (next: TaskWindowMap) => void
}

/**
 * Chat stays the center. There is no extra chrome row: task identity is a
 * document heading inside the transcript, and modules open as task windows.
 */
export function TaskWorkbench({ task, windows, onWindowsChange }: TaskWorkbenchProps) {
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
    if (module !== 'changes') return
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
    const record: TaskWindowRecord = {
      module,
      rect: cascadeRect(stage, 0, { width: 1100, height: 640 }),
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
        </div>

        {size.width > 0 && windows.changes && !windows.changes.minimized && (
          <TaskWindow
            record={windows.changes}
            title={`变更 · ${task.name}`}
            container={size}
            focused={focusedModule === 'changes'}
            zIndex={20 + windows.changes.z}
            onChange={(patch) => updateWindow('changes', patch)}
            onClose={() => closeWindow('changes')}
            onFocus={() => {
              if (focusedModule !== 'changes') updateWindow('changes', { z: maxZ + 1 })
            }}
          >
            <ChangesWindow task={task} />
          </TaskWindow>
        )}

        <TaskDock windows={windows} onToggle={toggleModule} />
      </div>
    </div>
  )
}
