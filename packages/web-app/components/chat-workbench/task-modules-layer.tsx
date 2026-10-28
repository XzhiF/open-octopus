'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TaskView } from '@/lib/tasks-api'
import { cascadeRect, type Size } from '@/lib/window-geometry'
import { cn } from '@/lib/utils'
import { ChangesWindow } from './changes-window'
import { TaskPlanWindow } from './task-plan-window'
import { TaskWindow } from './task-window'
import { RunWindow } from './run-window'
import { AcceptanceWindow } from './acceptance-window'
import { UsageWindow } from './usage-window'
import { ArtifactsWindow } from './artifacts-window'
import { ArchiveWindow } from './archive-window'
import type { TaskModule, TaskWindowMap, TaskWindowRecord } from './task-window-types'

const MODULE_TITLE: Record<TaskModule, string> = {
  plan: '规格',
  changes: '变更',
  run: '运行',
  acceptance: '验收',
  usage: '消耗',
  artifacts: '产物',
  archive: '归档',
}

interface TaskModulesLayerProps {
  task: TaskView
  windows: TaskWindowMap
  onWindowsChange: (next: TaskWindowMap) => void
  onMutated?: () => void
  /** Shared task action handler (chip / card / window controls). */
  onTaskAction?: (action: string) => void
  /** External request (inspector / board acceptance) to open a module once. */
  openModule?: { module: TaskModule; nonce: number } | null
  className?: string
}

/**
 * The single task module surface: floating dock + draggable windows. One
 * window per job; the main chat is never hidden behind these.
 */
export function TaskModulesLayer({
  task,
  windows,
  onWindowsChange,
  onMutated,
  onTaskAction,
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
      module === 'acceptance' || module === 'run'
        ? { width: 1240, height: 740 }
        : module === 'plan'
          ? { width: 980, height: 640 }
          : module === 'archive'
            ? { width: 1040, height: 700 }
            : module === 'usage'
              ? { width: 880, height: 640 }
              : module === 'artifacts'
                ? { width: 900, height: 640 }
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
            ) : module === 'run' ? (
              <RunWindow task={task} onTaskAction={onTaskAction} />
            ) : module === 'acceptance' ? (
              <AcceptanceWindow
                task={task}
                onMutated={onMutated ?? (() => {})}
                onOpenChanges={() => openModuleAt('changes')}
              />
            ) : module === 'usage' ? (
              <UsageWindow taskId={task.id} versionKey={task.version} />
            ) : module === 'artifacts' ? (
              <ArtifactsWindow taskId={task.id} versionKey={task.version} />
            ) : (
              <ArchiveWindow task={task} onMutated={onMutated} />
            )}
          </TaskWindow>
        )
      })}
    </div>
  )
}
