'use client'

// S6 任务看板（原型 wbTasks）：八列 · 派生状态 · failed/aborted 独立态。
// 数据 = GET /api/tasks?cabin_id（舱内过滤）+ 逐任务 derived。点卡 → chat
// 底座 select-task（复用 per-task TaskModulesLayer）；新任务 → 舱绑定的
// new-task 流程（ChatPane cabinId prop）。

import { ListTodo, Plus } from 'lucide-react'
import { useCabinContext } from '../cabin-provider'
import { useCabinTasks, taskDisplayStatus, TCard, WBtn, WbH, openTaskInChat } from './ui'

const COLS: Array<[string, string]> = [
  ['draft', '草稿'],
  ['ready', '待执行'],
  ['running', '执行中'],
  ['awaiting_review', '待验收'],
  ['awaiting_archive', '待归档'],
  ['done', '完成'],
  ['failed', '失败'],
  ['aborted', '中止'],
]

const FOLD: Record<string, string> = { paused: 'running', archiving: 'awaiting_archive' }

const DOT: Record<string, string> = {
  draft: 'bg-pop-cyan',
  ready: 'bg-pop-navy',
  running: 'bg-pop-green',
  awaiting_review: 'bg-pop-amber',
  awaiting_archive: 'bg-pop-pink',
  done: 'bg-pop-green/50',
  failed: 'bg-pop-red',
  aborted: 'bg-pop-dim',
}

export function CabinTasks({ onNewTask }: { onNewTask?: () => void }) {
  const { cabinId } = useCabinContext()
  const { tasks, loading } = useCabinTasks(cabinId)

  return (
    <div data-testid="cabin-tasks-body">
      <WbH icon={ListTodo} title="任务看板" cap="八列 · 派生状态 · failed/aborted 独立态">
        <WBtn pri testId="cabin-tasks-new" onClick={onNewTask}>
          <Plus className="size-3" />新任务
        </WBtn>
      </WbH>
      <div className="grid grid-cols-8 gap-2 overflow-x-auto" data-testid="cabin-kanban">
        {COLS.map(([key, label]) => {
          const ts = tasks.filter((t) => (FOLD[taskDisplayStatus(t)] ?? taskDisplayStatus(t)) === key)
          return (
            <div key={key} className="min-h-[180px] min-w-[120px] rounded-xl border-[1.5px] border-pop-bd bg-pop-idle p-2" data-task-column={key}>
              <div className="ui-font mb-2 flex items-center gap-1.5 text-[11.5px] font-semibold text-pop-ink">
                <span className={`size-1.5 rounded-full ${DOT[key]}`} />
                {label}
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
