'use client'

// S6 迭代窗（原型 wbIterations）：里程碑线 + 成员 tcard。成员/进度派生自
// tasks.iteration_id + deriveTaskView（K3），不存 taskIds/progress。

import { Layers } from 'lucide-react'
import { useCabinContext } from '../cabin-provider'
import { useCabinTasks, taskDisplayStatus, IterLine, TCard, WbH, WbNote, Empty, openTaskInChat } from './ui'

export function CabinIterations() {
  const { cabinId, view } = useCabinContext()
  const { tasks, loading } = useCabinTasks(cabinId)
  const iterations = view?.iterations ?? []

  return (
    <div data-testid="cabin-iterations-body">
      <WbH icon={Layers} title="迭代" cap="里程碑 · 成员/进度派生自任务" />
      <WbNote className="mb-3">
        迭代只存里程碑身份（code/name/计划态）；成员与进度<b className="text-pop-ink">派生</b>自任务
        （tasks.iteration_id 单写者 + deriveTaskView），不在此存储 taskIds/progress。
      </WbNote>
      {iterations.length === 0 ? (
        <Empty>暂无迭代 · 调度者在主对话规划里程碑</Empty>
      ) : iterations.map((it) => {
        const members = tasks.filter((t) => t.iteration_id === it.id)
        return (
          <div key={it.id} data-iteration-block={it.code}>
            <IterLine
              code={it.code}
              name={it.name}
              meta={`${members.length} 任务 · ${it.progress ?? 0}%`}
              pct={it.progress ?? 0}
              active={it.status === 'active'}
            />
            {members.length > 0 && (
              <div className="mb-4 mt-2 grid grid-cols-3 gap-2">
                {members.map((t) => (
                  <TCard key={t.id} task={t} onClick={() => openTaskInChat(t.id)} />
                ))}
              </div>
            )}
            {members.length === 0 && !loading && (
              <WbNote className="mb-3">该迭代暂无成员任务</WbNote>
            )}
          </div>
        )
      })}
      {loading && iterations.length === 0 && <Empty>读取任务…</Empty>}
      {tasks.length > 0 && iterations.length > 0 && (
        <WbNote className="mt-2">
          {tasks.filter((t) => !t.iteration_id).length} 个任务未归属迭代 · {tasks.filter((t) => taskDisplayStatus(t) === 'done').length} 完成
        </WbNote>
      )}
    </div>
  )
}
