'use client'

import { TaskChatTab } from '@/components/tasks/run-console/chat/chat-tab'
import type { TaskView } from '@/lib/tasks-api'
import { TaskModulesLayer } from './task-modules-layer'
import { TaskRunCenter } from './task-run-center'
import type { TaskWindowMap, TaskModule } from './task-window-types'

interface TaskWorkbenchProps {
  task: TaskView
  windows: TaskWindowMap
  onWindowsChange: (next: TaskWindowMap) => void
  onMutated?: () => void
  /** External request (board acceptance) to open a module once. */
  openModule?: { module: TaskModule; nonce: number } | null
}

/**
 * Task center without a second title row — identity lives in the sidebar and
 * the document content itself. Modules live in the right dock.
 */
export function TaskWorkbench({
  task,
  windows,
  onWindowsChange,
  onMutated,
  openModule,
}: TaskWorkbenchProps) {
  return (
    <div data-testid="task-workbench" className="ui-font relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col" data-testid="task-workbench-body">
        {task.status === 'awaiting_review' ? (
          <TaskChatTab
            taskId={task.id}
            form="quick-edit"
            hideHeader
          />
        ) : (
          <TaskRunCenter task={task} onMutated={onMutated} />
        )}
      </div>

      <TaskModulesLayer
        task={task}
        windows={windows}
        onWindowsChange={onWindowsChange}
        onMutated={onMutated}
        openModule={openModule}
      />
    </div>
  )
}
