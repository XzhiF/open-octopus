'use client'

// 2026-10-28 task-thread M5: the acceptance surface as its OWN window.
// No tabs, no chat (the main chat IS the conversation), no duplicate close
// (TaskWindow's titlebar is the only one).

import { AcceptanceSurface } from '@/components/tasks/acceptance/acceptance-surface'
import type { TaskView } from '@/lib/tasks-api'

export function AcceptanceWindow({
  task,
  onMutated,
  onOpenChanges,
}: {
  task: TaskView
  onMutated: () => void
  onOpenChanges?: () => void
}) {
  return (
    <div className="h-full min-h-0" data-testid="acceptance-window">
      <AcceptanceSurface
        task={task}
        onMutated={onMutated}
        onOpenChanges={onOpenChanges}
      />
    </div>
  )
}
