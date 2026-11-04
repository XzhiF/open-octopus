'use client'

// 作业坞「运行」面板（2026-11-02）：先出本工作区的运行小列表，点一条再开
// DAG + 日志窗。一个 workspace 可以同时有多条工作流在跑（任务轮次、验收规划、
// 手动工作流），所以入口不是「直接开运行窗」，而是「这份空间一共有多少运行」。
//
// 分组：进行中在上（运行中/排队/暂停/等人），本工作区（终态）在下。
// 系统运行（triggered_by=acceptance-plan）打「系统」章 —— 不计入轮次口径。

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, ChevronRight, CircleDashed } from 'lucide-react'
import type { WorkspaceRun } from '@/lib/api-client'
import { formatStopwatch } from '@/lib/format'
import { SYSTEM_WORKFLOW_LABEL } from '@/lib/run-labels'
import { cn } from '@/lib/utils'

/** 还没走到终态的执行状态（与 dashboard queue 同律）。 */
const LIVE_STATUS = new Set([
  'running', 'pending', 'paused', 'pending_approval', 'pending_interaction', 'pending_resume',
])

export const isLiveRun = (run: WorkspaceRun): boolean => LIVE_STATUS.has(run.status)

const STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  pending: '排队中',
  paused: '已暂停',
  pending_approval: '待审批',
  pending_interaction: '等人',
  pending_resume: '待恢复',
  completed: '已完成',
  completed_with_failures: '完成（有失败）',
  failed: '失败',
  cancelled: '已中止',
  aborted: '已中止',
  interrupted: '已中断',
  rejected: '已拒绝',
}

const FAILED_STATUS = new Set(['failed', 'completed_with_failures', 'interrupted', 'rejected'])

export function runTitle(run: WorkspaceRun): string {
  const system = run.isSystem ? SYSTEM_WORKFLOW_LABEL[run.workflowRef] : undefined
  return system ?? run.name ?? run.workflowName ?? run.workflowRef
}

export function runCoord(run: WorkspaceRun): string {
  if (run.phaseIndex == null) return ''
  return `P${run.phaseIndex}${run.roundIndex != null ? ` · R${run.roundIndex}` : ''}`
}

/** 运行中：now - started_at（服务端起点，重开不归零）；终态：duration 或 起止差。 */
export function runElapsedMs(run: WorkspaceRun, now: number): number | null {
  const started = run.startedAt ? Date.parse(run.startedAt) : NaN
  if (isLiveRun(run)) {
    return Number.isFinite(started) ? Math.max(0, now - started) : null
  }
  if (run.duration != null) return run.duration
  const ended = run.completedAt ? Date.parse(run.completedAt) : NaN
  return Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : null
}

export function RunPicker({
  workspaceId,
  runs,
  activeRunId,
  onPick,
}: {
  workspaceId: string | null
  runs: WorkspaceRun[]
  activeRunId?: string | null
  onPick: (run: WorkspaceRun) => void
}) {
  const [now, setNow] = useState(() => Date.now())
  const liveCount = useMemo(() => runs.filter(isLiveRun).length, [runs])

  // 只喂「还在跑」的读数；终态耗时是定值，不必每秒重渲染。
  useEffect(() => {
    if (liveCount === 0) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [liveCount])

  const { live, done } = useMemo(() => {
    const live: WorkspaceRun[] = []
    const done: WorkspaceRun[] = []
    for (const run of runs) (isLiveRun(run) ? live : done).push(run)
    return { live, done }
  }, [runs])

  if (!workspaceId) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[11px] leading-5 text-pop-dim">
        当前会话没有工作区，运行列表不可用。
      </div>
    )
  }

  if (runs.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[11px] leading-5 text-pop-dim">
        <CircleDashed className="size-5 opacity-50" />
        <span>本工作区还没有运行。</span>
        <span className="text-[10px] text-pop-dim/60">触发任务或跑一个工作流后，这里会列出每一次执行。</span>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col font-mono text-[11px]">
      <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 py-2">
        <span className="text-[10px] font-bold tracking-tight text-pop-ink">运行</span>
        <span className="text-[9.5px] text-pop-dim">本工作区</span>
        <span className="ml-auto rounded-full border border-pop-bd/70 px-1.5 py-[1px] text-[9px] tabular-nums text-pop-dim">
          {runs.length} 个运行
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-[9.5px] text-pop-dim">
        {live.length > 0 ? (
          <>
            <span className="size-1.5 animate-pulse rounded-full bg-pop-green" />
            {live.length} 个运行中
          </>
        ) : (
          <>
            <span className="size-1.5 rounded-full bg-pop-dim/50" />
            没有运行中的执行
          </>
        )}
        <span className="text-pop-dim/50">·</span>
        <span>{done.length} 个已结束</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {live.length > 0 && (
          <Section label="进行中" count={live.length}>
            {live.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                active={run.id === activeRunId}
                now={now}
                onPick={onPick}
              />
            ))}
          </Section>
        )}
        {done.length > 0 && (
          <Section label="本工作区" count={done.length}>
            {done.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                active={run.id === activeRunId}
                now={now}
                onPick={onPick}
              />
            ))}
          </Section>
        )}
      </div>

      <div className="shrink-0 border-t border-white/[0.05] px-3 py-1.5 text-[9px] leading-4 text-pop-dim/70">
        点一条打开 DAG + 日志；系统运行不计入轮次口径。
      </div>
    </div>
  )
}

function Section({ label, count, children }: {
  label: string
  count: number
  children: React.ReactNode
}) {
  return (
    <div className="mb-1.5">
      <div className="flex items-center gap-1.5 px-1.5 py-1 text-[9.5px] text-pop-dim">
        <span>{label}</span>
        <span className="tabular-nums text-pop-dim/60">{count}</span>
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

function RunRow({ run, active, now, onPick }: {
  run: WorkspaceRun
  active: boolean
  now: number
  onPick: (run: WorkspaceRun) => void
}) {
  const live = isLiveRun(run)
  const failed = FAILED_STATUS.has(run.status)
  const elapsed = runElapsedMs(run, now)
  const coord = runCoord(run)
  const meta = [run.workflowRef, coord].filter(Boolean).join(' · ')

  return (
    <button
      type="button"
      data-testid="run-picker-row"
      data-run-id={run.id}
      data-run-status={run.status}
      onClick={() => onPick(run)}
      className={cn(
        'flex w-full items-center gap-2 rounded-[7px] border px-1.5 py-1.5 text-left transition-colors',
        active
          ? 'border-pop-green/40 bg-pop-green-soft/40'
          : 'border-transparent hover:border-white/[0.07] hover:bg-white/[0.04]',
      )}
    >
      <span
        className={cn(
          'grid size-6 shrink-0 place-items-center rounded-md border',
          live
            ? 'border-pop-green/35 bg-pop-green-soft text-pop-green'
            : failed
              ? 'border-pop-red/35 bg-pop-red-soft text-pop-red'
              : 'border-pop-bd/70 bg-black/20 text-pop-dim',
        )}
      >
        {live ? (
          <span className="size-1.5 animate-pulse rounded-full bg-pop-green" />
        ) : failed ? (
          <AlertTriangle className="size-3" />
        ) : (
          <CheckCircle2 className="size-3" />
        )}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[11px] font-semibold text-pop-ink">{runTitle(run)}</span>
          {run.isSystem && (
            <span className="shrink-0 rounded border border-pop-cyan/35 bg-pop-cyan/[0.06] px-1 py-[0px] text-[8.5px] font-bold text-pop-cyan">
              系统
            </span>
          )}
        </span>
        <span className="mt-[1px] block truncate text-[9px] text-pop-dim">{meta}</span>
      </span>

      <span className="flex shrink-0 flex-col items-end gap-[1px]">
        <span
          className={cn(
            'text-[9.5px] font-bold',
            live ? 'text-pop-green' : failed ? 'text-pop-red' : 'text-pop-dim',
          )}
        >
          {STATUS_LABEL[run.status] ?? run.status}
        </span>
        <span className="text-[9px] tabular-nums text-pop-dim/70">
          {elapsed != null ? formatStopwatch(elapsed) : '—'}
        </span>
      </span>

      <ChevronRight className="size-3 shrink-0 text-pop-dim/50" />
    </button>
  )
}
