'use client'

import { FilesTab } from '@/components/tasks/files-tab/files-tab'
import { useRoundDiffFeed } from '@/components/tasks/files-tab/use-round-diff-feed'
import { canServeRoundDiff } from '@/components/tasks/files-tab/files-tab-model'
import type { TaskView } from '@/lib/tasks-api'

export function ChangesWindow({ task }: { task: TaskView }) {
  // 末态（done/failed/aborted）与 draft/ready 没有 awaiting/live 轮，端点会 409；
  // 与旧控制台共用同一道状态闸，落 FilesTab 的 idle 面而不是错误面。
  const serving = canServeRoundDiff(task.status)
  const feed = useRoundDiffFeed(task.id, serving, 0)

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="changes-window-body">
      <FilesTab
        taskId={task.id}
        feed={feed}
        serving={serving}
        isLive={task.status === 'running'}
      />
    </div>
  )
}
