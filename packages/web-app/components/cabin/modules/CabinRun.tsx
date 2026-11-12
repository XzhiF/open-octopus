'use client'

// 运行窗（原型 wbRun）：运行卡永远没有动作按钮 —— 操作走主 chat 或作业坞。
// 数据 = 舱内 running 任务（派生）+ view.health；节点 = phase 派生态。

import { Play } from 'lucide-react'
import { useCabinContext } from '../cabin-provider'
import { useCabinTasks, taskDisplayStatus, WbH, WbNote, Empty } from './ui'

function elapsedLabel(startedAt: string | undefined): string {
  if (!startedAt) return '—'
  const ms = Date.now() - Date.parse(startedAt)
  if (Number.isNaN(ms) || ms < 0) return '—'
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function CabinRun() {
  const { cabinId, view } = useCabinContext()
  const { tasks } = useCabinTasks(cabinId)
  const runs = tasks.filter((t) => taskDisplayStatus(t) === 'running')

  return (
    <div data-testid="cabin-run-body">
      <WbH icon={Play} title="运行" cap={`${runs.length} 运行中 · ${view?.health.queued ?? 0} 排队`} />
      {runs.length === 0 ? (
        <Empty>无运行中工作流</Empty>
      ) : runs.map((t) => {
        const phases = t.derived?.phaseViews ?? []
        const current = phases.find((p) => p.status !== 'accepted') ?? phases[phases.length - 1]
        const runningRound = current?.rounds.find((r) => r.state === 'running' || r.state === 'pending')
        const pct = phases.length > 0
          ? Math.round(((current ? current.index - 1 : phases.length) / phases.length) * 100)
          : 45
        return (
          <div key={t.id} className="mb-2.5 rounded-lg border border-pop-violet/35 bg-pop-violet/5 px-3 py-2 text-[11.5px]" data-run-card={t.id}>
            <div className="flex items-center gap-2">
              <span className="relative size-2 shrink-0 rounded-full bg-pop-violet">
                <span className="absolute inset-0 animate-ping rounded-full bg-pop-violet opacity-60" />
              </span>
              <span className="truncate font-semibold text-pop-violet">{t.workflow_ref ?? t.name}</span>
              <span className="rounded-full border border-pop-violet/40 px-2 py-px text-[9px] font-bold text-pop-violet">运行中</span>
              <span className="ml-auto rounded-full border border-pop-bd bg-pop-bg/60 px-2 py-px font-mono text-[10px] font-bold text-pop-ink">
                ⏱ {elapsedLabel(runningRound?.exec.created_at)}
              </span>
            </div>
            <div className="mt-1 pl-4 text-[10.5px] text-pop-dim">
              {t.repo_group ?? '—'} · {t.workflow_ref ?? ''}
              {current ? ` · P${current.index}·R${runningRound?.roundIndex ?? current.currentRound ?? 1}` : ''}
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-pop-bd/60">
              <i className="block h-full bg-pop-violet transition-all duration-700" style={{ width: `${pct}%` }} />
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {phases.length === 0 ? (
                <>
                  <span className="rounded border border-pop-violet/40 bg-pop-bg/40 px-1.5 text-[10px] text-pop-violet">spec</span>
                  <span className="rounded border border-pop-bd bg-pop-bg/40 px-1.5 text-[10px] text-pop-dim">code</span>
                </>
              ) : phases.map((p) => (
                <span
                  key={p.index}
                  className={`rounded border px-1.5 text-[10px] ${
                    p.status === 'accepted'
                      ? 'border-pop-bd bg-pop-bg/40 text-pop-dim before:text-pop-green before:content-["✓_"]'
                      : p.index === current?.index
                        ? 'border-pop-violet/40 bg-pop-bg/40 text-pop-violet'
                        : 'border-dashed border-pop-amber/40 bg-pop-bg/40 text-pop-amber'
                  }`}
                >
                  {p.name || `phase${p.index}`}
                </span>
              ))}
            </div>
          </div>
        )
      })}
      <WbNote className="mt-2.5">运行卡永远没有动作按钮 —— 操作走主 chat 或作业坞对应窗口。</WbNote>
    </div>
  )
}
