'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TaskView } from '@/lib/tasks-api'
import { cascadeRect, centerInViewport, type Size } from '@/lib/window-geometry'
import { cn } from '@/lib/utils'
import { useOptionalDesktopWindows } from '@/lib/desktop-windows'
import { ChangesWindow } from './changes-window'
import { TaskPlanWindow } from './task-plan-window'
import { TaskWindow } from './task-window'
import { RunWindow } from './run-window'
import { AcceptanceWindow } from './acceptance-window'
import { UsageWindow } from './usage-window'
import { SessionUsageWindow } from './session-usage-window'
import { DebugInspectorWindow } from './debug-inspector-window'
import { ArtifactsWindow } from './artifacts-window'
import { ArchiveWindow } from './archive-window'
import type { TaskModule, TaskWindowMap, TaskWindowRecord, RunTarget } from './task-window-types'

const MODULE_TITLE: Record<TaskModule, string> = {
  plan: '规格',
  changes: '变更',
  run: '运行',
  acceptance: '验收',
  usage: '消耗',
  debug: '调试',
  artifacts: '产物',
  archive: '归档',
}

interface TaskModulesLayerProps {
  /**
   * 任务模块层。2026-10-31 消耗窗通用化后，这一层在「任务 / 纯会话」两种
   * 上下文都挂载：有 task 时按任务账本渲染全部模块；没有 task 时只承载
   * 「消耗」（会话账本 + 本会话跑过的工作流）。
   */
  task: TaskView | null
  /** 当前会话（task 为空时使用）—— 消耗窗的会话账本取数。 */
  sessionId?: string | null
  /** 当前聊天会话 —— 「调试」窗在任何上下文（任务 / 纯会话）都用它取数。 */
  chatSessionId?: string | null
  /** 消息数 / 流式状态变化时刷新「调试」窗与徽标。 */
  debugRefreshKey?: string | number
  /** 会话窗标题（无 task 时 `消耗 · <会话标题>`）。 */
  sessionTitle?: string | null
  windows: TaskWindowMap
  onWindowsChange: (next: TaskWindowMap) => void
  onMutated?: () => void
  /** Shared task action handler (chip / card / window controls). */
  onTaskAction?: (action: string) => void
  /** External request (inspector / board acceptance / 作业坞运行列表) to open a module once. */
  openModule?: { module: TaskModule; nonce: number; runTarget?: RunTarget | null } | null
  /** 会话账本里点工作流行 → 打开对应任务。 */
  onOpenLinkedTask?: (taskId: string) => void
  className?: string
}

/**
 * The single task module surface: floating dock + draggable windows. One
 * window per job; the main chat is never hidden behind these.
 */
export function TaskModulesLayer({
  task,
  sessionId,
  chatSessionId,
  debugRefreshKey,
  sessionTitle,
  windows,
  onWindowsChange,
  onMutated,
  onTaskAction,
  openModule,
  onOpenLinkedTask,
  className,
}: TaskModulesLayerProps) {
  const desktop = useOptionalDesktopWindows()
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })
  /** 容器左边缘的视口 x（= 左侧任务栏宽度）；最大化窗口按它向左出血。 */
  const [containerLeft, setContainerLeft] = useState(0)
  const lastNonceRef = useRef<number | null>(null)

  useLayoutEffect(() => {
    const element = containerRef.current
    if (!element) return
    const update = () => {
      setSize({ width: element.clientWidth, height: element.clientHeight })
      setContainerLeft(element.getBoundingClientRect().left)
    }
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

  const openModuleAt = useCallback((module: TaskModule, runTarget: RunTarget | null = null) => {
    const current = windows[module]
    if (current) {
      // 运行窗已经开着：只换目标执行并提到最前，不重建窗口（拖拽/尺寸保留）。
      const patch: Partial<TaskWindowRecord> = {
        ...(current.minimized ? { minimized: false } : {}),
        z: maxZ + 1,
      }
      if (module === 'run') patch.runTarget = runTarget
      updateWindow(module, patch)
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
              : module === 'debug'
                ? { width: 1120, height: 760 }
                : module === 'artifacts'
                  ? { width: 1120, height: 720 }
                  : { width: 1100, height: 640 }
    let rect = cascadeRect(stage, 0, preferred)
    // 打开位置 = 整个浏览器水平居中（2026-10-29 用户）：容器是侧栏右侧的聊天区，
    // 按容器居中会整体偏右；把 x 换回视口坐标。拖拽/持久化的位置不受影响。
    const container = containerRef.current
    if (container) {
      const viewportWidth = typeof window === 'undefined' ? stage.width : window.innerWidth
      rect = centerInViewport(rect, container.getBoundingClientRect().left, viewportWidth)
    }
    const record: TaskWindowRecord = {
      module,
      rect,
      minimized: false,
      maximized: false,
      restoreRect: null,
      z: maxZ + 1,
      ...(module === 'run' ? { runTarget } : {}),
    }
    onWindowsChange({ ...windows, [module]: record })
  }, [windows, onWindowsChange, maxZ, size])

  useEffect(() => {
    if (!openModule || lastNonceRef.current === openModule.nonce) return
    lastNonceRef.current = openModule.nonce
    openModuleAt(openModule.module, openModule.runTarget ?? null)
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
            title={
              module === 'run' && record.runTarget
                ? `${MODULE_TITLE[module]} · ${record.runTarget.title}`
                : `${MODULE_TITLE[module]} · ${task?.name ?? sessionTitle ?? '会话'}`
            }
            container={size}
            bleedLeft={containerLeft}
            focused={focusedModule === module}
            zIndex={20 + record.z}
            onChange={(patch) => updateWindow(module, patch)}
            onClose={() => closeWindow(module)}
            onFocus={() => {
              if (focusedModule !== module) updateWindow(module, { z: maxZ + 1 })
            }}
          >
            {module === 'usage' ? (
              task ? (
                <UsageWindow taskId={task.id} versionKey={task.version} />
              ) : sessionId ? (
                <SessionUsageWindow
                  sessionId={sessionId}
                  onOpenTask={onOpenLinkedTask}
                  // 主对话直接跑的工作流没有任务：点行打开这条执行的运行窗。
                  onOpenExecution={(wf) => {
                    if (!wf.execution_id || !wf.workspace_id) return
                    openModuleAt('run', {
                      executionId: wf.execution_id,
                      workspaceId: wf.workspace_id,
                      title: wf.name,
                      status: wf.status,
                    })
                  }}
                />
              ) : (
                <div className="flex h-full items-center justify-center p-6 text-[11px] text-pop-dim">
                  还没有会话。
                </div>
              )
            ) : module === 'debug' ? (
              <DebugInspectorWindow sessionId={chatSessionId ?? sessionId ?? null} refreshKey={debugRefreshKey} />
            ) : module === 'run' ? (
              // 运行窗不依赖任务：自由对话里从作业坞/消耗窗点进来的指定执行也要能看。
              <RunWindow task={task} runTarget={record.runTarget ?? null} onTaskAction={onTaskAction} />
            ) : !task ? null : module === 'changes' ? (
              <ChangesWindow task={task} />
            ) : module === 'plan' ? (
              <TaskPlanWindow task={task} onOpenArtifacts={() => openModuleAt('artifacts')} />
            ) : module === 'acceptance' ? (
              <AcceptanceWindow
                task={task}
                onMutated={onMutated ?? (() => {})}
                onOpenChanges={() => openModuleAt('changes')}
              />
            ) : module === 'artifacts' ? (
              <ArtifactsWindow taskId={task.id} versionKey={task.version} />
            ) : (
              <ArchiveWindow task={task} onMutated={onMutated} onOpenKnowledge={desktop ? () => desktop.openApp('knowledge') : undefined} />
            )}
          </TaskWindow>
        )
      })}
    </div>
  )
}
