'use client'

// 2026-10-30 运行台改版：日志从右侧 420px 固定栏搬进「DAG 在上、终端在下」的纵向分栏。
// 日志改成终端式合流（见 components/workspace/run-log），并发执行时按通道着色、
// 有并发轨道与通道栏；点 DAG 节点 = 在日志里聚焦该节点，两面共用一个 focus。
// 控制项沿用任务动作，与对话卡片同源。

import { useEffect, useState } from 'react'
import { Pause, Play, RotateCcw, Square } from 'lucide-react'
import { toast } from 'sonner'
import { getTask, type TaskDetail, type TaskView } from '@/lib/tasks-api'
import { fetchExecutionDetail, rerunExecution } from '@/lib/api-client'
import type { StepExecution } from '@/lib/types'
import { formatStopwatch } from '@/lib/format'
import { WorkflowFlowViewerWithStatus } from '@/components/workspace/workflow-flow-viewer-with-status'
import { RunLogConsole } from '@/components/workspace/run-log/run-log-console'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { Spinner } from '@/components/ui/spinner'

const LIVE_RUN = new Set(['pending', 'running', 'paused'])

/** 总耗时（毫秒），口径 = 服务端 `started_at` 起算 —— 所以关掉窗口再打开、
 *  或刷新页面，读数都接着走而不是归零（2026-10-30 用户要求）。
 *  - 运行中：now - startedAt（调用方每秒喂一个新 now）
 *  - 已结束：completedAt - startedAt；缺 completedAt（中止/异常收尾）时退到
 *    最后一个节点的回执时间，再缺就不显示，绝不拿打开窗口的时刻当起点。 */
export function totalElapsedMs(
  startedAt: string | null | undefined,
  completedAt: string | null | undefined,
  live: boolean,
  now: number,
  steps: StepExecution[] = [],
): number | null {
  const started = startedAt ? Date.parse(startedAt) : NaN
  if (Number.isNaN(started)) return null
  const ended = completedAt ? Date.parse(completedAt) : NaN
  if (!Number.isNaN(ended)) return Math.max(0, ended - started)
  if (live) return Math.max(0, now - started)
  const lastStepEnd = steps.reduce(
    (acc, s) => Math.max(acc, s.completedAt ? Date.parse(s.completedAt) : 0),
    0,
  )
  return lastStepEnd > started ? lastStepEnd - started : null
}

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
    startedAt: string | null
    completedAt: string | null
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rerunning, setRerunning] = useState(false)
  /** DAG 与日志共用的聚焦：节点 id（= 事件 nodeId） */
  const [focus, setFocus] = useState<string | null>(null)

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
            startedAt: data.started_at ?? null,
            completedAt: data.completed_at ?? null,
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

  // 换一轮执行就松开聚焦：上一轮的通道 id 不该挂在新轮上
  useEffect(() => { setFocus(null) }, [executionId])

  // 总耗时走表：只有还活着才每秒推一格。起点是服务端 started_at，
  // 不是组件挂载时刻 —— 关掉窗口再打开、刷新页面，读数接着走。
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [live])
  const totalMs = exec ? totalElapsedMs(exec.startedAt, exec.completedAt, live, now, exec.steps) : null

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
        {totalMs !== null && (
          <span
            data-testid="run-total"
            title="总耗时 —— 自服务端 started_at 起算，重开窗口不归零"
            className={`shrink-0 rounded-full border border-pop-bd/70 px-2 py-[3px] font-mono text-[9px] font-black tabular-nums ${live ? 'text-pop-ink' : 'text-pop-dim'}`}
          >
            ⏱ {formatStopwatch(totalMs)}
          </span>
        )}
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

      <ResizablePanelGroup direction="vertical" autoSaveId="octopus.run-window.v1" className="min-h-0 flex-1">
        <ResizablePanel defaultSize={38} minSize={16} className="min-h-0 overflow-hidden">
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
              onNodeClick={(stepId) => setFocus((prev) => (prev === stepId ? null : stepId))}
            />
          )}
        </ResizablePanel>
        <ResizableHandle withHandle className="shrink-0 bg-pop-bd/60" />
        <ResizablePanel defaultSize={62} minSize={28} className="min-h-0">
          {workspaceId && executionId && (
            <RunLogConsole
              workspaceId={workspaceId}
              executionId={executionId}
              executionStatus={exec?.status ?? run.status}
              steps={exec?.steps ?? []}
              focus={focus}
              onFocusChange={setFocus}
            />
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}
