'use client'

import { TaskRunConsole } from '@/components/tasks/run-console/task-run-console'
import type { TaskView } from '@/lib/tasks-api'

/** The full run console embedded as a task window (no modal). */
export function TaskConsoleWindow({
  task,
  startOnAcceptance,
  onClose,
  onMutated,
}: {
  task: TaskView
  startOnAcceptance?: boolean
  onClose: () => void
  onMutated?: () => void
}) {
  return (
    <div className="h-full min-h-0">
      <TaskRunConsole
        task={task}
        onMutated={onMutated ?? (() => {})}
        onClose={onClose}
        startOnAcceptance={startOnAcceptance}
      />
    </div>
  )
}
