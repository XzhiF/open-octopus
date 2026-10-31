'use client'

import { FilesTab } from '@/components/tasks/files-tab/files-tab'
import { useRoundDiffFeed } from '@/components/tasks/files-tab/use-round-diff-feed'
import { canServeRoundDiff } from '@/components/tasks/files-tab/files-tab-model'
import type { TaskView } from '@/lib/tasks-api'

/** 只有「轮还在动」的状态值得兜底轮询（≤10s 观测口径）。已验收 / 归档 / 终态
 *  的区间是冻结快照，拉一次就够 —— 注意 v4 的待归档持久态是 ready，也在此列。 */
const LIVE_POLL_STATUSES = new Set(['running', 'paused', 'awaiting_review'])

export function ChangesWindow({ task }: { task: TaskView }) {
  // 服务端解析顺序：awaiting 轮 → live 轮 → 停流接管轮 → 最近已验收轮。所以除
  // draft 外都值得试一次：done / archiving / awaiting_archive 回看已验收轮的实物
  // 区间（2026-10-31）；真没有轮时端点 409，FilesTab 落 idle 面而不是错误面。
  const serving = canServeRoundDiff(task.status)
  const feed = useRoundDiffFeed(task.id, serving, 0, LIVE_POLL_STATUSES.has(task.status))

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
