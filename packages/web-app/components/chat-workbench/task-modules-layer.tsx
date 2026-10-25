'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TaskView } from '@/lib/tasks-api'
import { cascadeRect, type Size } from '@/lib/window-geometry'
import { cn } from '@/lib/utils'
import { ChangesWindow } from './changes-window'
import { ExpertsWindow } from './experts-window'
import { TaskConsoleWindow } from './task-console-window'
import { TaskPlanWindow } from './task-plan-window'
import { TaskWindow } from './task-window'
import type { TaskModule, TaskWindowMap, TaskWindowRecord } from './task-window-types'

const MODULE_TITLE: Record<TaskModule, string> = {
  plan: '计划',
  changes: '变更',
  acceptance: '验收',
  experts: '专家',
}

interface TaskModulesLayerProps {
  task: TaskView
  windows: TaskWindowMap
  onWindowsChange: (next: TaskWindowMap) => void
  onMutated?: () => void
  /** External request (inspector / board acceptance) to open a module once. */
  openModule?: { module: TaskModule; nonce: number } | null
  className?: string
}

/**
 * The single task module surface: floating dock + draggable windows. Used by
 * both the authoring chat (draft) and the task workbench, so plan/changes/
 * acceptance/experts never render twice in two different shells.
 */
export function TaskModulesLayer({
  task,
  windows,
  onWindowsChange,
  onMutated,
  openModule,
  className,
}: TaskModulesLayerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })
  const lastNonceRef = useRef<number | null>(null)

  useLayoutEffect(() => {
    const element = containerRef.current
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
  const focusedModule = [...openRecords].sort((a, b) => b.z - a.z)[0]?.module ?? null
  const maxZ = Math.max(10, ...recordList.map((record) => record.z))

  const updateWindow = (module: TaskModule, patch: Partial<TaskWindowRecord>) => {
    const current = windows[module]
    if (!current) return
    onWindowsChange({ ...windows, [module]: { ...current, ...patch } })
  }

  const openModuleAt = useCallback((module: TaskModule) => {
    const current = windows[module]
    if (current) {
      if (current.minimized) {
        updateWindow(module, { minimized: false, z: maxZ + 1 })
      } else {
        updateWindow(module, { z: maxZ + 1 })
      }
      return
    }
    const stage = size.width > 0 ? size : { width: 900, height: 600 }
    const preferred =
      module === 'acceptance'
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
  }, [windows, onWindowsChange, maxZ, size])

  useEffect(() => {
    if (!openModule || lastNonceRef.current === openModule.nonce) return
    lastNonceRef.current = openModule.nonce
    openModuleAt(openModule.module)
  }, [openModule, openModuleAt])

  const closeWindow = (module: TaskModule) => {
    const next = { ...windows }
    delete next[module]
    onWindowsChange(next)
  }

  return (
    <div
      ref={containerRef}
      data-testid="task-modules-layer"
      className={cn('pointer-events-none absolute inset-0 z-[60]', className)}
    >
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
    </div>
  )
}
