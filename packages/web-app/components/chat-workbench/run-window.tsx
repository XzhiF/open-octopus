'use client'

// 2026-10-30 运行台改版：日志从右侧 420px 固定栏搬进「DAG 在上、终端在下」的纵向分栏。
// 日志改成终端式合流（见 components/workspace/run-log），并发执行时按通道着色、
// 有并发轨道与通道栏；点 DAG 节点 = 在日志里聚焦该节点，两面共用一个 focus。
// 控制项沿用任务动作，与对话卡片同源。

import { useEffect, useState } from 'react'
import { Code2, Pause, Play, RotateCcw, Square } from 'lucide-react'
import { toast } from 'sonner'
import { getTask, pauseTask, resumeTask, type TaskDetail, type TaskView } from '@/lib/tasks-api'
import { cancelExecution, fetchExecutionDetail, fetchExecutionIncidents, pauseExecution, rerunExecution, resumeExecution, type RuntimeIncidentWire } from '@/lib/api-client'
import type { StepExecution } from '@/lib/types'
import type { RunTarget, YamlTarget } from './task-window-types'
import { formatStopwatch } from '@/lib/format'
import { WorkflowFlowViewerWithStatus } from '@/components/workspace/workflow-flow-viewer-with-status'
import { RunLogConsole } from '@/components/workspace/run-log/run-log-console'
import { IncidentTimeline } from './incident-timeline'
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

export const RUN_STATUS_LABEL: Record<string, string> = {
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
  runTarget,
  onTaskAction,
  onOpenYaml,
}: {
  /** 有任务 = 任务当前一轮；自由对话里打开作业坞指定的执行时没有任务。 */
  task: TaskView | null
  /** 作业坞运行列表点进来的指定执行；缺省 = 任务当前一轮（原行为不变）。 */
  runTarget?: RunTarget | null
  onTaskAction?: (action: string) => void
  /** 头部「</> YAML」—— 看 DAG 的同时对照本次运行的 YAML 原文。 */
  onOpenYaml?: (target: YamlTarget) => void
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
  const [aborting, setAborting] = useState(false)
  const [resuming, setResuming] = useState(false)
  const [pausing, setPausing] = useState(false)
  /** DAG 与日志共用的聚焦：节点 id（= 事件 nodeId） */
  const [focus, setFocus] = useState<string | null>(null)
  const [view, setView] = useState<'dag' | 'incidents'>('dag')
  const [incidents, setIncidents] = useState<RuntimeIncidentWire[]>([])

  const runs = runTarget ? [] : detail?.executions ?? []
  const taskRun = runs.find((r) => LIVE_RUN.has(r.status)) ?? runs[0] ?? null
  const workspaceId = runTarget?.workspaceId ?? taskRun?.workspace_id ?? null
  const executionId = runTarget?.executionId ?? taskRun?.id ?? null
  const status = exec?.status ?? runTarget?.status ?? taskRun?.status ?? ''
  const live = !!status && LIVE_RUN.has(status)
  const phaseIndex = runTarget?.phaseIndex ?? taskRun?.phase_index ?? null
  const roundIndex = runTarget?.roundIndex ?? taskRun?.round_index ?? null
  const workflowRef = exec?.workflowRef ?? runTarget?.workflowRef ?? taskRun?.workflow_ref ?? null
  /** 任务 id 单独提出来做 effect 依赖：task 对象每次渲染可能是新引用。 */
  const taskId = task?.id ?? null

  // 终态重跑（2026-10-28）：failed/取消/带失败完成 的执行给一个「⚡ 重跑」，
  // 服务端自动取首个失败节点为恢复点 —— 与对话 Agent 的 rerun_execution 同源。
  // 作业坞点进来的指定执行不给重跑（系统运行重跑会误解成业务重跑）。
  const rerunnable = !runTarget && !!taskRun && !live &&
    ['failed', 'cancelled', 'aborted', 'completed_with_failures'].includes(taskRun.status)
  const handleRerun = async () => {
    if (!task || !workspaceId || !executionId || rerunning) return
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

  /** 指定执行（可能是 task_id=NULL 的验收规划）：中止走执行接口，不走任务动作。 */
  const handleAbortTarget = async () => {
    if (!workspaceId || !executionId || aborting) return
    setAborting(true)
    try {
      await cancelExecution(workspaceId, executionId)
      toast.success('已中止执行')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '中止失败')
    } finally {
      setAborting(false)
    }
  }

  /**
   * 继续运行（2026-11-14 用户反馈）：从作业详情点开的运行窗是 runTarget，
   * 之前「恢复」被 !runTarget 挡掉，只剩中止。恢复按目标归属选路：
   *  · 任务绑定执行 → 任务恢复接口（TasksService 先重挂 collectRound 等 callback，
   *    否则整轮跑完没人收批次产物）；
   *  · 没有任务的执行（验收规划等）→ 执行恢复接口。
   * 两条路后端都对 harness-delegate 暂停（节点已 failed、没有 paused 节点）
   * 从失败节点重跑。
   */
  const handleResumeTarget = async () => {
    if (!workspaceId || !executionId || resuming) return
    setResuming(true)
    try {
      if (runTarget?.taskId) await resumeTask(runTarget.taskId)
      else await resumeExecution(workspaceId, executionId)
      toast.success('已继续运行')
      if (taskId) {
        const next = await getTask(taskId)
        setDetail(next)
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '恢复失败')
    } finally {
      setResuming(false)
    }
  }

  /**
   * 暂停（2026-11-14 用户要求）：与中止/继续同一条按目标归属选路 ——
   * 任务绑定执行走任务暂停（服务端落「任务已暂停」卡），无任务的执行走执行接口。
   * 引擎只在节点真正运行时接受暂停；节点间隙会被拒绝（服务端原文提示）。
   */
  const handlePauseTarget = async () => {
    if (!workspaceId || !executionId || pausing) return
    setPausing(true)
    try {
      if (runTarget?.taskId) await pauseTask(runTarget.taskId)
      else await pauseExecution(workspaceId, executionId)
      toast.success('已暂停')
      if (taskId) {
        const next = await getTask(taskId)
        setDetail(next)
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '暂停失败')
    } finally {
      setPausing(false)
    }
  }

  useEffect(() => {
    // 指定执行不依赖任务当前轮：列表里可能是 task_id=NULL 的系统运行，
    // getTask 看不到它，轮询只会白跑。自由对话里根本没有任务。
    if (runTarget || !taskId) {
      setDetail(null)
      return
    }
    let alive = true
    const load = () => {
      getTask(taskId)
        .then((next) => { if (alive) setDetail(next) })
        .catch(() => { /* keep the snapshot */ })
    }
    load()
    const timer = window.setInterval(load, live ? 3_000 : 15_000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [taskId, live, runTarget])

  // 换一条执行：先清掉上一份 DAG/日志快照，避免新 target 加载前短暂串台。
  useEffect(() => { setExec(null); setIncidents([]); setView('dag') }, [workspaceId, executionId])

  // 运行事件（runtime supervision）：只读时间线，5s 刷新。
  useEffect(() => {
    if (!workspaceId || !executionId) {
      setIncidents([])
      return
    }
    let alive = true
    const load = () => {
      fetchExecutionIncidents(workspaceId, executionId)
        .then((list) => { if (alive) setIncidents(list) })
        .catch(() => { /* timeline is best-effort */ })
    }
    load()
    const timer = window.setInterval(load, 5_000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [workspaceId, executionId])

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

  if (!executionId) {
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
          {phaseIndex != null ? `P${phaseIndex}` : '执行'}
          {roundIndex != null ? ` · R${roundIndex}` : ''}
        </span>
        <span className="truncate font-mono text-[10px] text-pop-dim">{workflowRef ?? '—'}</span>
        {runTarget?.system && (
          <span className="shrink-0 rounded border border-pop-cyan/35 bg-pop-cyan/[0.06] px-1.5 py-[1px] font-mono text-[9px] font-bold text-pop-cyan">
            系统
          </span>
        )}
        <span className={`rounded-full px-2 py-[3px] font-mono text-[9px] font-black ${live ? 'bg-pop-green text-pop-bg' : 'bg-pop-idle text-pop-dim'}`}>
          {RUN_STATUS_LABEL[status] ?? status}
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
          <div className="flex overflow-hidden rounded border border-pop-bd/70" role="tablist" aria-label="运行视图">
            <button
              type="button"
              role="tab"
              aria-selected={view === 'dag'}
              data-testid="run-view-dag"
              data-active={view === 'dag'}
              onClick={() => setView('dag')}
              className={`px-2 py-1 text-[10px] transition-colors ${view === 'dag' ? 'bg-pop-ink/10 text-pop-ink' : 'text-pop-dim hover:text-pop-ink'}`}
            >
              流程
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'incidents'}
              data-testid="run-view-incidents"
              data-active={view === 'incidents'}
              onClick={() => setView('incidents')}
              className={`px-2 py-1 text-[10px] transition-colors ${view === 'incidents' ? 'bg-pop-ink/10 text-pop-ink' : 'text-pop-dim hover:text-pop-ink'}`}
            >
              事件{incidents.length > 0 ? ` (${incidents.length})` : ''}
            </button>
          </div>
          {workspaceId && executionId && onOpenYaml && (
            <button
              type="button"
              data-testid="run-yaml"
              aria-label="查看工作流 YAML"
              title="查看工作流 YAML"
              onClick={() =>
                onOpenYaml({
                  workspaceId,
                  executionId,
                  workflowRef,
                  title: runTarget?.title ?? workflowRef ?? "执行",
                  phaseIndex,
                  roundIndex,
                  status,
                  from: "run",
                })
              }
              className="inline-flex items-center gap-1 rounded border border-pop-cyan/40 bg-pop-cyan/[0.06] px-2 py-1 text-[10px] text-pop-cyan hover:bg-pop-cyan/[0.12]"
            >
              <Code2 className="size-3" /> YAML
            </button>
          )}
          {status === 'running' && !runTarget?.system && (runTarget || onTaskAction) && (
            <button
              type="button"
              data-testid="run-pause"
              disabled={pausing}
              title="在当前运行节点处暂停（节点间隙无法暂停）"
              onClick={() => {
                if (runTarget) void handlePauseTarget()
                else onTaskAction?.('pause')
              }}
              className="inline-flex items-center gap-1 rounded border border-pop-bd px-2 py-1 text-[10px] text-pop-ink hover:bg-white/[0.06] disabled:opacity-50"
            >
              <Pause className="size-3" /> {pausing ? '暂停中…' : '暂停'}
            </button>
          )}
          {status === 'paused' && !runTarget?.system && (runTarget || onTaskAction) && (
            <button
              type="button"
              data-testid="run-resume"
              disabled={resuming}
              title={runTarget ? '从暂停处继续（节点已失败时从该节点重跑）' : '继续这一轮执行'}
              onClick={() => {
                if (runTarget) void handleResumeTarget()
                else onTaskAction?.('resume')
              }}
              className="inline-flex items-center gap-1 rounded border border-pop-green/40 bg-pop-green-soft px-2 py-1 text-[10px] text-pop-green hover:opacity-90 disabled:opacity-50"
            >
              <Play className="size-3" /> {resuming ? '恢复中…' : '继续运行'}
            </button>
          )}
          {(status === 'running' || status === 'paused') && (
            <button
              type="button"
              data-testid="run-abort"
              disabled={aborting}
              onClick={() => {
                if (runTarget) void handleAbortTarget()
                else onTaskAction?.('abort')
              }}
              className="inline-flex items-center gap-1 rounded border border-pop-red/35 px-2 py-1 text-[10px] text-pop-red hover:bg-pop-red-soft disabled:opacity-50">
              <Square className="size-3" /> {aborting ? '中止中…' : '中止'}
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
          {view === 'incidents' ? (
            <IncidentTimeline incidents={incidents} />
          ) : !exec ? (
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
        <ResizableHandle className="shrink-0 bg-pop-bd/60" />
        <ResizablePanel defaultSize={62} minSize={28} className="min-h-0">
          {workspaceId && executionId && (
            <RunLogConsole
              workspaceId={workspaceId}
              executionId={executionId}
              executionStatus={status}
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
