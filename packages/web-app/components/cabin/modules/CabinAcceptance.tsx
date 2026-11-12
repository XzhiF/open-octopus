'use client'

// 验收窗（原型 wbAcceptance）：舱级验收台 = 任务选择（待验收优先）+ 复用生产
// AcceptanceWindow（验收方案 cases/checks + 对话裁决）。操作语义同原型：
// 通过/打回经对话或验收台（人=确认权人），不在舱窗私改状态。

import { useMemo, useState } from 'react'
import { ClipboardCheck } from 'lucide-react'
import { AcceptanceWindow } from '@/components/chat-workbench/acceptance-window'
import { useCabinContext } from '../cabin-provider'
import { useCabinTasks, taskDisplayStatus, WbH, WbNote, Empty, openTaskInChat } from './ui'

export function CabinAcceptance() {
  const { cabinId, refresh } = useCabinContext()
  const { tasks, loading } = useCabinTasks(cabinId)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const reviewable = useMemo(
    () => tasks.filter((t) => ['awaiting_review', 'running', 'awaiting_archive', 'done'].includes(taskDisplayStatus(t))),
    [tasks],
  )
  const task = reviewable.find((t) => t.id === selectedId)
    ?? reviewable.find((t) => taskDisplayStatus(t) === 'awaiting_review')
    ?? reviewable[0]
    ?? null

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="cabin-acceptance-body">
      <WbH icon={ClipboardCheck} title="验收台" cap={task ? `${task.name} · ${taskDisplayStatus(task)}` : '舱内任务'} />
      {reviewable.length > 1 && (
        <select
          value={task?.id ?? ''}
          onChange={(e) => setSelectedId(e.target.value)}
          data-testid="cabin-acceptance-picker"
          className="mb-2 h-7 rounded-md border border-pop-bd bg-pop-idle px-2 text-[11px] text-pop-ink outline-none"
        >
          {reviewable.map((t) => (
            <option key={t.id} value={t.id}>{t.name} · {taskDisplayStatus(t)}</option>
          ))}
        </select>
      )}
      <WbNote className="mb-2">
        机器证据 + 人验场景两层；也可在主 chat 直接说「通过 / 不行，因为…」。决策权 Agent · 确认权人。
      </WbNote>
      {loading && !task ? (
        <Empty>读取舱内任务…</Empty>
      ) : !task ? (
        <Empty>暂无可验收任务 · 派发任务后这里出现验收台</Empty>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border-[1.5px] border-pop-bd bg-pop-paper">
          <AcceptanceWindow
            task={task}
            onMutated={() => { void refresh() }}
            onOpenChanges={() => openTaskInChat(task.id, 'changes')}
          />
        </div>
      )}
    </div>
  )
}
