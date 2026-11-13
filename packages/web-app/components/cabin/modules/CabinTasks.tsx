'use client'

// classic-v3 任务窗：四列看板（待执行/执行中/待验收/已完成）+ 迭代筛选。
// 数据 = GET /api/tasks?cabin_id（舱内过滤）+ 逐任务 derived（useCabinTasks）。
// 点卡 → chat 底座 select-task；新任务 → 舱绑定的 new-task 流程。
// 迭代筛选与概览共享（provider.taskIter）：概览点迭代行会带着筛选打开本窗。

import { ListTodo, Plus } from 'lucide-react'
import { useCabinContext } from '../cabin-provider'
import { useCabinTasks, taskDisplayStatus, TCard, WBtn, WbH, openTaskInChat } from './ui'

interface Column {
  key: string
  label: string
  dot: string
  statuses: string[]
}

const COLUMNS: Column[] = [
  { key: 'todo', label: '待执行', dot: 'bg-pop-navy', statuses: ['draft', 'ready'] },
  { key: 'running', label: '执行中', dot: 'bg-pop-green', statuses: ['running', 'paused'] },
  { key: 'review', label: '待验收', dot: 'bg-pop-amber', statuses: ['awaiting_review', 'awaiting_archive', 'archiving'] },
  { key: 'done', label: '已完成', dot: 'bg-pop-green/50', statuses: ['done', 'failed', 'aborted'] },
]

export function CabinTasks({ onNewTask }: { onNewTask?: () => void }) {
  const { cabinId, view, taskIter, setTaskIter } = useCabinContext()
  const { tasks, loading } = useCabinTasks(cabinId)
  const iterations = view?.iterations ?? []
  const active = taskIter && iterations.some((it) => it.id === taskIter) ? taskIter : null
  const visible = active ? tasks.filter((t) => t.iteration_id === active) : tasks

  const chip = (id: string | null, label: string, count: number) => (
    <button
      key={id ?? 'all'}
      type="button"
      data-testid={`cabin-tasks-iter-${id ?? 'all'}`}
      onClick={() => setTaskIter(id)}
      className={`inline-flex items-center gap-1.5 rounded-full border-[1.5px] px-2.5 py-1 text-[10.5px] transition-colors ${
        active === id
          ? 'border-pop-pink bg-pop-pink font-bold text-pop-bg'
          : 'border-pop-bd bg-pop-idle text-pop-dim hover:border-pop-dim hover:text-pop-ink'
      }`}
    >
      {label}
      <span className="font-mono text-[9.5px] opacity-75">{count}</span>
    </button>
  )

  return (
    <div data-testid="cabin-tasks-body">
      <WbH icon={ListTodo} title="任务" cap={`${visible.length} 条 · 按状态`}>
        <WBtn pri testId="cabin-tasks-new" onClick={onNewTask}>
          <Plus className="size-3" />新任务
        </WBtn>
      </WbH>

      <div className="mb-3 flex flex-wrap gap-1.5" data-testid="cabin-tasks-iters">
        {chip(null, '全部', tasks.length)}
        {iterations.map((it) => chip(
          it.id,
          `${it.code} ${it.name}`,
          tasks.filter((t) => t.iteration_id === it.id).length,
        ))}
      </div>

      <div className="grid grid-cols-4 gap-2 max-[900px]:grid-cols-2" data-testid="cabin-kanban">
        {COLUMNS.map((col) => {
          const ts = visible.filter((t) => col.statuses.includes(taskDisplayStatus(t)))
          return (
            <div
              key={col.key}
              className="min-h-[180px] min-w-0 rounded-xl border-[1.5px] border-pop-bd bg-pop-idle p-2"
              data-task-column={col.key}
            >
              <div className="ui-font mb-2 flex items-center gap-1.5 text-[11.5px] font-semibold text-pop-ink">
                <span className={`size-1.5 rounded-full ${col.dot}`} />
                {col.label}
                <span className="ml-auto text-[10.5px] font-normal text-pop-dim">{ts.length}</span>
              </div>
              {ts.length === 0 ? (
                <div className="py-3 text-center text-[11px] text-pop-dim">空</div>
              ) : ts.map((t) => (
                <TCard key={t.id} task={t} onClick={() => openTaskInChat(t.id)} />
              ))}
            </div>
          )
        })}
      </div>
      {loading && tasks.length === 0 && (
        <div className="mt-3 text-center text-[11px] text-pop-dim">读取舱内任务…</div>
      )}
    </div>
  )
}
