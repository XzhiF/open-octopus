'use client'

// 2026-10-28 task-thread M5: the execution window the old run console hid
// behind tabs. DAG on the left, live log stream on the right, the current
// round auto-bound. Controls reuse the same task actions as the chat cards.

import { useEffect, useState } from 'react'
import { Pause, Play, RotateCcw, Square } from 'lucide-react'
import { toast } from 'sonner'
import { getTask, type TaskDetail, type TaskView } from '@/lib/tasks-api'
import { fetchExecutionDetail, rerunExecution } from '@/lib/api-client'
import type { StepExecution } from '@/lib/types'
import { WorkflowFlowViewerWithStatus } from '@/components/workspace/workflow-flow-viewer-with-status'
import { ExecutionLogViewer } from '@/components/workspace/execution-log-viewer'
import { Spinner } from '@/components/ui/spinner'

const LIVE_RUN = new Set(['pending', 'running', 'paused'])

const RUN_STATUS_LABEL: Record<string, string> = {
  pending: '排队中',
  running: '执行中',
  paused: '已暂停',
  completed: '已完成',
  completed_with_failures: '完成（有失败节点）',
  failed: '失败',
  cancelled: '已中止',
  aborted: '已中止',
}

export function RunWindow({
  task,
  onTaskAction,
}: {
  task: TaskView
  onTaskAction?: (action: string) => void
}) {
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [exec, setExec] = useState<{
    status: string
    workflowRef: string
    yaml: string
    steps: StepExecution[]
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rerunning, setRerunning] = useState(false)

  const runs = detail?.executions ?? []
  const run = runs.find((r) => LIVE_RUN.has(r.status)) ?? runs[0] ?? null
  const workspaceId = run?.workspace_id ?? null
  const executionId = run?.id ?? null
  const live = !!run && LIVE_RUN.has(run.status)

  // 终态重跑（2026-10-28）：failed/取消/带失败完成 的执行给一个「⚡ 重跑」，
  // 服务端自动取首个失败节点为恢复点 —— 与对话 Agent 的 rerun_execution 同源。
  const rerunnable = !!run && !live && ['failed', 'cancelled', 'aborted', 'completed_with_failures'].includes(run.status)
  const handleRerun = async () => {
    if (!workspaceId || !executionId || rerunning) return
    setRerunning(true)
    try {
      const result = await rerunExecution(workspaceId, executionId)
      toast.success(
        result.engine_restarted === false
          ? `已重置 ${result.resetNodes.length} 个节点 · 引擎未在线，将在服务重启后接管`
          : `已重置 ${result.resetNodes.length} 个节点 · 引擎已自 ${result.restoredFrom} 重新接管`,
      )
      const next = await getTask(task.id)
      setDetail(next)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '重跑失败')
    } finally {
      setRerunning(false)
    }
  }

  useEffect(() => {
    let alive = true
    const load = () => {
      getTask(task.id)
        .then((next) => { if (alive) setDetail(next) })
        .catch(() => { /* keep the snapshot */ })
    }
    load()
    const timer = window.setInterval(load, live ? 3_000 : 15_000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [task.id, live])

  useEffect(() => {
    if (!workspaceId || !executionId) {
      setExec(null)
      return
    }
    let alive = true
    setError(null)
    const load = () => {
      fetchExecutionDetail(workspaceId, executionId)
        .then((data) => {
          if (!alive) return
          setExec({
            status: data.status,
            workflowRef: data.workflow_ref,
            yaml: data.workflow_content ?? '',
            steps: (data.steps ?? []) as StepExecution[],
          })
        })
        .catch((err: unknown) => {
          if (alive) setError(err instanceof Error ? err.message : String(err))
        })
    }
    load()
    const timer = window.setInterval(load, live ? 3_000 : 15_000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [workspaceId, executionId, live])

  if (!run) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-[11.5px] text-pop-dim" data-testid="run-window-empty">
        还没有执行轮。触发任务后，这里会显示 DAG 与日志。
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-pop-bg" data-testid="run-window">
      <div className="flex flex-wrap items-center gap-2 border-b border-pop-bd bg-pop-paper/50 px-3 py-2">
        <span className="font-mono text-[10px] font-black text-pop-ink">
          {run.phase_index != null ? `P${run.phase_index}` : '执行'}
          {run.round_index != null ? ` · R${run.round_index}` : ''}
        </span>
        <span className="truncate font-mono text-[10px] text-pop-dim">{run.workflow_ref ?? exec?.workflowRef ?? '—'}</span>
        <span className={`rounded-full px-2 py-[3px] font-mono text-[9px] font-black ${live ? 'bg-pop-green text-pop-bg' : 'bg-pop-idle text-pop-dim'}`}>
          {RUN_STATUS_LABEL[run.status] ?? run.status}
        </span>
        <span className="truncate font-mono text-[9px] text-pop-dim/70">{executionId}</span>
        <div className="ml-auto flex items-center gap-1">
          {run.status === 'running' && (
            <button type="button" onClick={() => onTaskAction?.('pause')}
              className="inline-flex items-center gap-1 rounded border border-pop-bd px-2 py-1 text-[10px] text-pop-ink hover:bg-white/[0.06]">
              <Pause className="size-3" /> 暂停
            </button>
          )}
          {run.status === 'paused' && (
            <button type="button" onClick={() => onTaskAction?.('resume')}
              className="inline-flex items-center gap-1 rounded border border-pop-green/40 bg-pop-green-soft px-2 py-1 text-[10px] text-pop-green hover:opacity-90">
              <Play className="size-3" /> 恢复
            </button>
          )}
          {(run.status === 'running' || run.status === 'paused') && (
            <button type="button" onClick={() => onTaskAction?.('abort')}
              className="inline-flex items-center gap-1 rounded border border-pop-red/35 px-2 py-1 text-[10px] text-pop-red hover:bg-pop-red-soft">
              <Square className="size-3" /> 中止
            </button>
          )}
          {rerunnable && (
            <button type="button" data-testid="run-rerun" onClick={() => void handleRerun()} disabled={rerunning}
              className="inline-flex items-center gap-1 rounded border border-pop-green/40 bg-pop-green-soft px-2 py-1 text-[10px] text-pop-green hover:opacity-90 disabled:opacity-50">
              <RotateCcw className="size-3" /> {rerunning ? '重跑中…' : '⚡ 重跑'}
            </button>
          )}
        </div>
      </div>

      {error && <div className="border-b border-pop-red/30 bg-pop-red-soft px-3 py-1.5 text-[10.5px] text-pop-red">{error}</div>}

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-hidden">
          {!exec ? (
            <div className="flex h-full items-center gap-2 p-6 text-[11px] text-pop-dim">
              <Spinner className="size-3.5" /> 读取执行…
            </div>
          ) : (
            <WorkflowFlowViewerWithStatus
              yamlContent={exec.yaml}
              executionSteps={exec.steps}
              workspaceId={workspaceId!}
              executionId={executionId!}
            />
          )}
        </div>
        <div className="w-[420px] shrink-0 overflow-hidden border-l border-pop-bd">
          <ExecutionLogViewer
            workspaceId={workspaceId!}
            executionId={executionId!}
            executionStatus={exec?.status ?? run.status}
          />
        </div>
      </div>
    </div>
  )
}
