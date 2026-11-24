'use client'

// 任务模块内嵌（design 23 §2 续 · 2026-11-16）
//
// 用户口径：规格 / 运行 / 验收不跳会话，直接在汐音这条对话里看；任务自己的
// 线程里也要有同一入口（双会话可追溯）。所以状态卡上挂三个页签，展开后把这
// 三个已有的窗口组件原样嵌进消息流 —— 数据源、操作语义与作业坞窗口完全一致，
// 不复制一套只读实现。
//
// 只负责「看」：真正的拍板仍在对话里说，或去任务线程 / 作业坞操作。

import { useEffect, useState } from 'react'
import { getTask, type TaskView } from '@/lib/tasks-api'
import { TaskPlanWindow } from '@/components/chat-workbench/task-plan-window'
import { RunWindow } from '@/components/chat-workbench/run-window'
import { AcceptanceWindow } from '@/components/chat-workbench/acceptance-window'
import { ArchiveWindow } from '@/components/chat-workbench/archive-window'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'

export type InlineTaskModule = 'plan' | 'run' | 'acceptance' | 'archive'

export const INLINE_MODULE_LABEL: Record<InlineTaskModule, string> = {
  plan: '规格',
  run: '运行',
  acceptance: '验收',
  archive: '归档',
}

export function TaskModuleInline({
  taskId,
  module,
  onClose,
}: {
  taskId: string
  module: InlineTaskModule
  onClose?: () => void
}) {
  const [task, setTask] = useState<TaskView | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setTask(null)
    setError(null)
    getTask(taskId)
      .then((detail) => { if (alive) setTask(detail) })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : '任务读取失败')
      })
    return () => { alive = false }
  }, [taskId])

  return (
    <div
      data-testid="task-module-inline"
      data-module={module}
      className="mt-2 overflow-hidden rounded-md border border-pop-bd bg-pop-bg"
    >
      <div className="flex items-center gap-1 border-b border-pop-bd/70 bg-black/20 px-2 py-1">
        <span className="text-[10px] text-pop-dim">任务模块</span>
        <span className="text-[10px] font-bold text-pop-ink/80">
          {INLINE_MODULE_LABEL[module]}
        </span>
        <span className="flex-1" />
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="收起任务模块"
            className="rounded border border-pop-bd/70 px-1.5 py-0.5 text-[10px] text-pop-dim transition-colors hover:bg-white/10 hover:text-pop-ink"
          >
            收起
          </button>
        )}
      </div>
      <div className={cn('h-[440px] min-h-0 overflow-y-auto')}>
        {error ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-[11.5px] text-pop-red">
            {error}
          </div>
        ) : !task ? (
          <div className="flex h-full items-center justify-center">
            <Spinner className="size-5 text-pop-dim" />
          </div>
        ) : module === 'plan' ? (
          <TaskPlanWindow task={task} />
        ) : module === 'run' ? (
          <RunWindow task={task} />
        ) : module === 'archive' ? (
          <ArchiveWindow task={task} />
        ) : (
          <AcceptanceWindow task={task} onMutated={() => {}} />
        )}
      </div>
    </div>
  )
}
