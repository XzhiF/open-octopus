'use client'

// 对话里的通用「工作流运行」卡（2026-11-02）：任何工作流执行都可以用它，
// 不只验收规划。服务端在执行创建时落一张 `payload.workflowRun` 消息，这里
// 轮询执行详情，在同一张卡上走完 运行中 → 已完成 / 失败。
//
// 与 TaskStatusCard 的分工：那张卡是**任务**状态（task 的 running/awaiting…）；
// 这张是**执行**层，可能是一个 task_id=NULL 的系统运行（验收规划）。所以卡片
// 不带任务动作按钮，操作仍走主 Chat / 作业坞。

import { useEffect, useState } from 'react'
import type { AgentMessage } from '@/lib/agent/types'
import type { StepExecution } from '@/lib/types'
import { fetchExecutionDetail } from '@/lib/api-client'
import { formatRunClock } from '@/lib/format'

const TERMINAL_EXEC_STATUS = new Set([
  'completed', 'completed_with_failures', 'failed', 'cancelled', 'aborted', 'interrupted', 'rejected',
])

const FAILED_EXEC_STATUS = new Set(['failed', 'completed_with_failures', 'interrupted', 'rejected'])
const STOPPED_EXEC_STATUS = new Set(['cancelled', 'aborted'])

const STATUS_LABEL: Record<string, string> = {
  pending: '排队中',
  running: '运行中',
  paused: '已暂停',
  pending_approval: '待审批',
  pending_interaction: '等人',
  completed: '已完成',
  completed_with_failures: '完成（有失败）',
  failed: '失败',
  cancelled: '已中止',
  aborted: '已中止',
  interrupted: '已中断',
  rejected: '已拒绝',
}

interface ExecSnapshot {
  status: string
  startedAt: string | null
  completedAt: string | null
  steps: StepExecution[]
}

interface WorkflowRunPayload {
  workflowRun?: boolean
  system?: boolean
  workflowRef?: string
  workflowName?: string
  phaseIndex?: number | null
  roundIndex?: number | null
}

const stepLabel = (s: StepExecution) => s.stepName || s.stepId
const isInternal = (s: StepExecution) => s.stepId.startsWith('__')
const isDone = (s: StepExecution) => s.status === 'completed' || s.status === 'skipped'
const ACTIVE_STEP = new Set(['running', 'paused', 'pending_approval', 'pending_interaction'])

export function WorkflowRunCard({ message }: { message: AgentMessage }) {
  const activity = message.activity
  const payload = (activity?.payload ?? {}) as WorkflowRunPayload
  const executionId = activity?.executionId ?? null
  const workspaceId = activity?.workspaceId ?? null

  const [snap, setSnap] = useState<ExecSnapshot | null>(null)
  const [fetchFailed, setFetchFailed] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!executionId || !workspaceId) return
    let alive = true
    let stopped = false
    const load = async () => {
      try {
        const data = await fetchExecutionDetail(workspaceId, executionId)
        if (!alive) return
        setFetchFailed(false)
        setSnap({
          status: data.status,
          startedAt: data.started_at ?? null,
          completedAt: data.completed_at ?? null,
          steps: Array.isArray(data.steps) ? data.steps : [],
        })
        if (TERMINAL_EXEC_STATUS.has(data.status)) stopped = true
      } catch {
        if (alive) setFetchFailed(true)
      }
    }
    void load()
    const timer = window.setInterval(() => {
      if (!stopped) void load()
    }, 3000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [executionId, workspaceId])

  const status = snap?.status ?? activity?.status ?? 'running'
  const terminal = TERMINAL_EXEC_STATUS.has(status)
  const failed = FAILED_EXEC_STATUS.has(status)
  const stopped = STOPPED_EXEC_STATUS.has(status)
  const live = !terminal

  // 走表：起点是服务端 started_at，关窗/刷新不归零；终态定格。
  useEffect(() => {
    if (!live) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [live])

  const startedMs = Date.parse(snap?.startedAt ?? message.created_at ?? '')
  const endedMs = Date.parse(snap?.completedAt ?? '')
  const elapsedMs = !Number.isFinite(startedMs)
    ? null
    : Number.isFinite(endedMs)
      ? Math.max(0, endedMs - startedMs)
      : live
        ? Math.max(0, now - startedMs)
        : null

  const visibleSteps = (snap?.steps ?? []).filter((s) => !isInternal(s))
  const doneSteps = visibleSteps.filter(isDone)
  const activeStep = visibleSteps.find((s) => ACTIVE_STEP.has(s.status))
  const lastDone = [...visibleSteps].reverse().find(isDone)
  const nodeSummary = activeStep
    ? `${stepLabel(activeStep)} ${status === 'paused' ? '已暂停' : '运行中'}`
    : live
      ? '等待节点…'
      : lastDone
        ? `${stepLabel(lastDone)} ✓`
        : ''

  const coord = payload.phaseIndex != null
    ? `P${payload.phaseIndex}${payload.roundIndex != null ? ` · R${payload.roundIndex}` : ''}`
    : ''
  const meta = [payload.workflowRef ?? activity?.message, coord].filter(Boolean).join(' · ')
  const workflowName = payload.workflowName ?? '工作流'
  const title = live
    ? `工作流运行 · ${workflowName}`
    : failed
      ? `工作流失败 · ${workflowName}`
      : stopped
        ? `工作流已中止 · ${workflowName}`
        : `工作流完成 · ${workflowName}`

  const tone = failed
    ? {
        box: 'border-pop-red/35 bg-pop-red/[0.05]',
        title: 'text-pop-red',
        pill: 'border-pop-red/40 text-pop-red',
        dot: 'bg-pop-red',
      }
    : live
      ? {
          box: 'border-pop-violet/35 bg-pop-violet/[0.05]',
          title: 'text-pop-violet',
          pill: 'border-pop-violet/40 text-pop-violet',
          dot: 'bg-pop-violet',
        }
      : {
          box: 'border-pop-bd/70 bg-white/[0.015]',
          title: 'text-pop-ink/80',
          pill: stopped ? 'border-pop-bd text-pop-dim' : 'border-pop-green/40 text-pop-green',
          dot: stopped ? 'bg-pop-dim' : 'bg-pop-green',
        }

  const canOpen = !!executionId && !!workspaceId

  return (
    <div
      data-tui-msg="event"
      data-message-id={message.id}
      data-testid="workflow-run-card"
      data-workflow-run-status={status}
      className={[
        'rounded-md border px-3 py-2 font-mono text-[11.5px] leading-relaxed',
        'shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)]',
        tone.box,
      ].join(' ')}
    >
      <div className="flex items-center gap-2">
        {live ? (
          <span className="relative flex size-2 shrink-0">
            <span className={`absolute inline-flex size-full animate-ping rounded-full opacity-60 ${tone.dot}`} />
            <span className={`relative inline-flex size-2 rounded-full ${tone.dot}`} />
          </span>
        ) : (
          <span
            className={`grid size-4 shrink-0 place-items-center rounded-full border border-current text-[9px] ${
              failed ? 'text-pop-red' : stopped ? 'text-pop-dim' : 'text-pop-green'
            }`}
          >
            {failed ? '✕' : stopped ? '■' : '✓'}
          </span>
        )}
        <span className={`min-w-0 flex-1 truncate font-semibold ${tone.title}`}>{title}</span>
        {payload.system && (
          <span className="shrink-0 rounded border border-pop-cyan/35 bg-pop-cyan/[0.06] px-1 py-[0px] text-[8.5px] font-bold text-pop-cyan">
            系统
          </span>
        )}
        <span className={`shrink-0 rounded-full border px-1.5 py-[1px] text-[9px] font-bold ${tone.pill}`}>
          {fetchFailed && !snap ? '状态未知' : STATUS_LABEL[status] ?? status}
        </span>
        {elapsedMs != null && (
          <span
            className="shrink-0 rounded-full border border-pop-bd/70 bg-black/20 px-2 py-[1px] text-[10px] font-bold tabular-nums text-pop-ink"
            title={live ? '自服务端 started_at 起算，刷新/重开不归零' : '本次执行总耗时'}
          >
            {live ? '⏱ ' : '用时 '}{formatRunClock(elapsedMs)}
          </span>
        )}
      </div>

      <div className="mt-1 flex items-center gap-2 pl-4 text-[10.5px] text-pop-dim">
        <span className="truncate text-pop-ink/70">{meta || '—'}</span>
        {nodeSummary && (
          <>
            <span className="text-pop-dim/50">·</span>
            <span className="truncate">{nodeSummary}</span>
          </>
        )}
        {visibleSteps.length > 0 && (
          <span className="ml-auto shrink-0 text-[9.5px] tabular-nums text-pop-dim/70">
            {doneSteps.length}/{visibleSteps.length} 节点
          </span>
        )}
      </div>

      <div className="mt-1 flex items-center gap-2 pl-4">
        {canOpen ? (
          <button
            type="button"
            onClick={() =>
              window.dispatchEvent(new CustomEvent('octopus:open-workflow', {
                detail: {
                  workspaceId,
                  executionId,
                  title: `${workflowName}${coord ? ` · ${coord}` : ''}`,
                },
              }))
            }
            className="rounded border border-current/30 px-1.5 py-0.5 text-[10px] opacity-80 transition-opacity hover:opacity-100"
          >
            打开 DAG →
          </button>
        ) : (
          <span className="text-[10px] text-pop-dim/60">执行已不可用</span>
        )}
        {payload.system && (
          <span className="text-[9.5px] text-pop-dim/60">系统运行 · 不计入轮次口径</span>
        )}
      </div>
    </div>
  )
}
