'use client'

// classic-v3 作业详情 · 运行 tab 的「省略态」（对齐 chat 里的执行框）：
// 先给一张执行摘要卡（状态 / 工作流 / 耗时 / 节点进度 / 当前节点），
// 不把 DAG 直接铺满面板；「打开运行 →」打开作业坞同款运行窗
// （RunWindow：DAG + 日志 + YAML，由 ChatPane 的 TaskModulesLayer 承载）。
// 数据：GET /api/workspaces/:ws/executions/:id（3s 轮询，终态即停）。

import { useEffect, useState } from 'react'
import { Play } from 'lucide-react'
import { fetchExecutionDetail } from '@/lib/api-client'
import type { StepExecution } from '@/lib/types'
import { formatRunClock } from '@/lib/format'
import { RUN_STATUS_LABEL, totalElapsedMs } from '@/components/chat-workbench/run-window'
import { cn } from '@/lib/utils'

const TERMINAL = new Set([
  'completed', 'completed_with_failures', 'failed', 'cancelled', 'aborted', 'interrupted', 'rejected',
])
const FAILED = new Set(['failed', 'completed_with_failures', 'interrupted', 'rejected'])
const STOPPED = new Set(['cancelled', 'aborted'])
const ACTIVE_STEP = new Set(['running', 'paused', 'pending_approval', 'pending_interaction'])

const isDone = (s: StepExecution) => s.status === 'completed' || s.status === 'skipped'
const labelOf = (s: StepExecution) => s.stepName || s.stepId

export interface CabinRunTarget {
  executionId: string
  workspaceId: string
  title: string
  workflowRef?: string | null
  phaseIndex?: number | null
  roundIndex?: number | null
  status?: string
  /** 任务绑定执行：运行窗的「继续运行」走任务恢复接口（带 callbacks 重挂）。 */
  taskId?: string | null
}

interface Snapshot {
  status: string
  workflowRef: string
  startedAt: string | null
  completedAt: string | null
  steps: StepExecution[]
}

/** 打开作业坞同款运行窗（ChatPane 监听；窗内可看 DAG / 日志 / YAML）。 */
export function openCabinRunWindow(target: CabinRunTarget) {
  window.dispatchEvent(new CustomEvent('octopus:open-run-window', { detail: target }))
}

export function CabinRunSummary({ target }: { target: CabinRunTarget }) {
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [failedToLoad, setFailedToLoad] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let alive = true
    let stopped = false
    setSnap(null)
    setFailedToLoad(false)
    const load = () => {
      fetchExecutionDetail(target.workspaceId, target.executionId)
        .then((data) => {
          if (!alive) return
          setFailedToLoad(false)
          setSnap({
            status: data.status,
            workflowRef: data.workflow_ref,
            startedAt: data.started_at ?? null,
            completedAt: data.completed_at ?? null,
            steps: (data.steps ?? []) as StepExecution[],
          })
          if (TERMINAL.has(data.status)) stopped = true
        })
        .catch(() => { if (alive) setFailedToLoad(true) })
    }
    load()
    const timer = window.setInterval(() => { if (!stopped) load() }, 3000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [target.workspaceId, target.executionId])

  const status = snap?.status ?? target.status ?? 'running'
  const live = !snap || !TERMINAL.has(status)
  const failed = FAILED.has(status)
  const stopped = STOPPED.has(status)

  // 走表：起点 = 服务端 started_at，关窗/刷新不归零；终态定格。
  useEffect(() => {
    if (!live) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [live])

  const elapsed = totalElapsedMs(snap?.startedAt, snap?.completedAt, live, now, snap?.steps ?? [])
  const steps = (snap?.steps ?? []).filter((s) => !s.stepId.startsWith('__'))
  const doneSteps = steps.filter(isDone)
  const activeStep = steps.find((s) => ACTIVE_STEP.has(s.status))
  const lastDone = [...steps].reverse().find(isDone)
  const nodeSummary = activeStep
    ? `${labelOf(activeStep)} ${status === 'paused' ? '已暂停' : '运行中'}`
    : live
      ? '等待节点…'
      : lastDone
        ? `${labelOf(lastDone)} ✓`
        : ''

  const workflowRef = snap?.workflowRef ?? target.workflowRef ?? null
  const coord = target.phaseIndex != null
    ? `P${target.phaseIndex}${target.roundIndex != null ? ` · R${target.roundIndex}` : ''}`
    : ''
  const tone = failed
    ? { box: 'border-pop-red/40 bg-pop-red/[0.05]', title: 'text-pop-red', pill: 'border-pop-red/40 text-pop-red', dot: 'bg-pop-red' }
    : live
      ? { box: 'border-pop-violet/35 bg-pop-violet/[0.05]', title: 'text-pop-violet', pill: 'border-pop-violet/40 text-pop-violet', dot: 'bg-pop-violet' }
      : { box: 'border-pop-bd bg-pop-idle', title: 'text-pop-ink/85', pill: stopped ? 'border-pop-bd text-pop-dim' : 'border-pop-green/40 text-pop-green', dot: stopped ? 'bg-pop-dim' : 'bg-pop-green' }

  return (
    <div
      data-testid="cabin-job-run-summary"
      data-run-status={status}
      className={cn('rounded-lg border px-3 py-2 font-mono text-[11.5px] leading-relaxed', tone.box)}
    >
      <div className="flex items-center gap-2">
        {live ? (
          <span className="relative flex size-2 shrink-0">
            <span className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-60', tone.dot)} />
            <span className={cn('relative inline-flex size-2 rounded-full', tone.dot)} />
          </span>
        ) : (
          <span className={cn('grid size-4 shrink-0 place-items-center rounded-full border border-current text-[9px]', failed ? 'text-pop-red' : stopped ? 'text-pop-dim' : 'text-pop-green')}>
            {failed ? '✕' : stopped ? '■' : '✓'}
          </span>
        )}
        <span className={cn('min-w-0 flex-1 truncate font-semibold', tone.title)}>
          {failed ? '运行失败' : stopped ? '运行已中止' : live ? '运行中' : '运行完成'}
          {workflowRef ? ` · ${workflowRef}` : ''}
        </span>
        <span className={cn('shrink-0 rounded-full border px-1.5 py-px text-[9px] font-bold', tone.pill)}>
          {failedToLoad && !snap ? '状态未知' : RUN_STATUS_LABEL[status] ?? status}
        </span>
        {elapsed != null && (
          <span className="shrink-0 rounded-full border border-pop-bd bg-black/20 px-2 py-px text-[10px] font-bold tabular-nums text-pop-ink">
            {live ? '⏱ ' : '用时 '}{formatRunClock(elapsed)}
          </span>
        )}
      </div>

      <div className="mt-1 flex items-center gap-2 pl-4 text-[10.5px] text-pop-dim">
        <span className="truncate text-pop-ink/70">
          {[coord, target.executionId.slice(0, 8)].filter(Boolean).join(' · ')}
        </span>
        {nodeSummary && (
          <>
            <span className="text-pop-dim/50">·</span>
            <span className="truncate">{nodeSummary}</span>
          </>
        )}
        {steps.length > 0 && (
          <span className="ml-auto shrink-0 text-[9.5px] tabular-nums text-pop-dim/70">
            {doneSteps.length}/{steps.length} 节点
          </span>
        )}
      </div>

      <div className="mt-1.5 flex items-center gap-2 pl-4">
        <button
          type="button"
          onClick={() => openCabinRunWindow(target)}
          data-testid="cabin-job-open-run"
          className="inline-flex items-center gap-1 rounded border border-current/30 px-1.5 py-0.5 text-[10px] opacity-80 transition-opacity hover:opacity-100"
        >
          <Play className="size-2.5" />打开运行 →
        </button>
        <span className="text-[9.5px] text-pop-dim/70">DAG · 日志 · YAML</span>
      </div>
    </div>
  )
}
