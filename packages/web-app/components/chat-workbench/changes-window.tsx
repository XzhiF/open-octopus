'use client'

import { FilesTab } from '@/components/tasks/files-tab/files-tab'
import { useRoundDiffFeed } from '@/components/tasks/files-tab/use-round-diff-feed'
import type { TaskView } from '@/lib/tasks-api'

export function ChangesWindow({ task }: { task: TaskView }) {
  const feed = useRoundDiffFeed(task.id, true, 0)

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="changes-window-body">
      <FilesTab
        taskId={task.id}
        feed={feed}
        serving
        isLive={task.status === 'running'}
      />
    </div>
  )
}
