'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Pause, Play, Square } from 'lucide-react'
import { toast } from 'sonner'
import {
  PHASE_STATUS_UPDATE_EVENT,
  TASK_EXECUTION_EVENT,
  TASK_STATUS_EVENT,
} from '@octopus/shared'
import { fetchAgentEvents } from '@/lib/api-client'
import type { AgentEvent } from '@/lib/types'
import {
  abortTask,
  getTask,
  pauseTask,
  resumeTask,
  triggerTask,
  type TaskDetail,
  type TaskView,
} from '@/lib/tasks-api'
import { getServerUrl } from '@/lib/server-config'
import { subscribeSSE } from '@/lib/sse-manager'
import { effectiveStatusOf, computePhaseBadge } from '@/lib/task-board'
import { WorkspaceEventStream } from '@/components/tasks/run-console/workspace-event-stream'
import { agentEventFromWire, retainNewerThan } from '@/components/tasks/run-console/log-model'
import { ConfirmDialog } from '@/components/agent/shared/ConfirmDialog'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { expertLabel } from '@/lib/expert-roles'

const LIVE_RUN_STATUSES = new Set(['pending', 'running', 'paused'])

interface TaskRunCenterProps {
  task: TaskView
  onMutated?: () => void
}

/**
 * Stage-aware task center for ready/running/archiving/terminal tasks.
 * Ready → trigger; running → live agent-event timeline + intervention;
 * terminal → read-only history. The right-hand dock/windows stay outside.
 */
export function TaskRunCenter({ task, onMutated }: TaskRunCenterProps) {
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [liveAppends, setLiveAppends] = useState<AgentEvent[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [abortOpen, setAbortOpen] = useState(false)

  const refetch = useCallback(async () => {
    try {
      setDetail(await getTask(task.id))
    } catch {
      /* keep the last snapshot */
    }
  }, [task.id])

  useEffect(() => {
    void refetch()
  }, [refetch])

  const status = effectiveStatusOf(task, detail?.derived)
  const isLive = status === 'ready' || status === 'running' || status === 'paused' || status === 'archiving'

  useEffect(() => {
    if (!isLive) return
    const timer = window.setInterval(() => void refetch(), 3_000)
    return () => window.clearInterval(timer)
  }, [isLive, refetch])

  useEffect(() => {
    const url = `${getServerUrl()}/api/tasks/events`
    const mine = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data) as { task_id?: string }
        return payload.task_id === task.id
      } catch {
        return false
      }
    }
    const offs = [
      subscribeSSE(url, TASK_STATUS_EVENT, (e) => { if (mine(e)) void refetch() }),
      subscribeSSE(url, TASK_EXECUTION_EVENT, (e) => { if (mine(e)) void refetch() }),
      subscribeSSE(url, PHASE_STATUS_UPDATE_EVENT, (e) => { if (mine(e)) void refetch() }),
    ]
    return () => offs.forEach((off) => off())
  }, [task.id, refetch])

  const runs = useMemo(() => detail?.executions ?? [], [detail])
  const liveRun = useMemo(
    () => runs.find((run) => LIVE_RUN_STATUSES.has(run.status)) ?? null,
    [runs],
  )
  // Ready with a previous terminal run still offers “trigger”; terminal tasks
  // still show their last run as history.
  const displayRun = liveRun ?? runs[0] ?? null
  const ws = displayRun?.workspace_id ?? null
  const executionId = displayRun?.id ?? null
  const targetLive = !!liveRun

  // Agent-event feed: SSE first (same channel as the run console), 5s poll as
  // the fallback/initial snapshot.
  useEffect(() => {
    if (!ws || !executionId) {
      setEvents([])
      setLiveAppends([])
      return
    }
    let cancelled = false
    setLiveAppends([])
    const pull = () => {
      fetchAgentEvents(ws, executionId)
        .then((res) => {
          if (cancelled) return
          setEvents(res.events)
          setLiveAppends((prev) => retainNewerThan(prev, res.events))
        })
        .catch(() => { /* empty stream is honest */ })
    }
    pull()
    const timer = targetLive ? window.setInterval(pull, 5_000) : null
    const off = subscribeSSE(
      `${getServerUrl()}/api/workspaces/${ws}/executions/events`,
      'agent_event',
      (event: MessageEvent) => {
        try {
          const payload = JSON.parse(event.data) as {
            executionId?: string
            nodeId?: string
            event?: Record<string, unknown>
          }
          if (payload.executionId !== executionId || !payload.nodeId) return
          const mapped = agentEventFromWire(payload.nodeId, payload.event)
          if (mapped) setLiveAppends((prev) => [...prev, mapped])
        } catch {
          /* ignore malformed frame */
        }
      },
    )
    return () => {
      cancelled = true
      if (timer) window.clearInterval(timer)
      off()
    }
  }, [ws, executionId, targetLive])

  const streamEvents = liveAppends.length > 0 ? [...events, ...liveAppends] : events
  const badge = computePhaseBadge(detail?.derived)
  const phaseExperts = useMemo(() => {
    if (!detail?.task_spec?.phases || !badge) return [] as string[]
    const phase = detail.task_spec.phases.find((p) => p.index === badge.phase)
    return (phase?.experts ?? []).map((id) => expertLabel(id))
  }, [detail?.task_spec?.phases, badge])
  const currentEvent = streamEvents[streamEvents.length - 1]
  const statusLabel =
    status === 'paused' ? '已暂停'
      : status === 'running' ? '运行中'
        : status === 'ready' ? '待执行'
          : status === 'awaiting_review' ? '待验收'
            : status === 'archiving' ? '归档中'
              : status === 'done' ? '已完成'
                : status === 'failed' ? '失败'
                  : status === 'aborted' ? '中止'
                    : status

  const runAction = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    try {
      await fn()
      await refetch()
      onMutated?.()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : `${label}失败`)
    } finally {
      setBusy(null)
    }
  }

  const handleTrigger = () => {
    void runAction('触发执行', () => triggerTask(task.id))
  }

  const handlePause = () => {
    void runAction('暂停', () => pauseTask(task.id))
  }

  const handleResume = () => {
    void runAction('恢复', () => resumeTask(task.id))
  }

  const handleAbort = () => {
    setAbortOpen(false)
    void runAction('中止', () => abortTask(task.id))
  }

  const handleSend = () => {
    const text = draft.trim()
    if (!text || busy) return
    setBusy('干预')
    void (async () => {
      try {
        // 干预 = 暂停当前轮 → 带 intervention 恢复（既有 06 通道）。
        if (status !== 'paused') await pauseTask(task.id)
        await resumeTask(task.id, text)
        setDraft('')
        toast.success('已注入干预')
        await refetch()
        onMutated?.()
      } catch (err: unknown) {
        toast.error(err instanceof Error ? err.message : '干预失败')
      } finally {
        setBusy(null)
      }
    })()
  }

  const canIntervene = status === 'running' || status === 'paused'

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-testid="task-run-center">
      {/* Inline status strip: part of the document, never a floating right pill. */}
      <div
        data-testid="task-run-status"
        className="flex shrink-0 items-center gap-2 border-b border-white/[0.05] px-4 py-1.5 text-[10.5px] text-pop-dim"
      >
        <span
          className={cn(
            'size-1.5 rounded-full',
            status === 'running' ? 'animate-pulse bg-pop-green'
              : status === 'paused' ? 'bg-pop-amber'
                : status === 'done' ? 'bg-pop-green/60'
                  : status === 'failed' ? 'bg-pop-red'
                    : 'bg-pop-cyan',
          )}
        />
        <span className="font-medium text-pop-ink">{statusLabel}</span>
        {badge && <span className="font-mono">P{badge.phase}/{badge.total}{badge.round != null ? ` · R${badge.round}` : ''}</span>}
        {phaseExperts.length > 0 && (
          <span className="max-w-[300px] truncate text-pop-purple">
            {phaseExperts.join(' / ')}
          </span>
        )}
        {status === 'running' && currentEvent?.nodeId && (
          <span className="max-w-[160px] truncate font-mono text-pop-cyan">{currentEvent.nodeId}</span>
        )}
        <span className="ml-auto hidden text-pop-dim/60 sm:inline">
          {status === 'running' ? '运行中' : '本轮已结束'}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden px-4 pt-3">
        {status === 'ready' && !liveRun ? (
          <ReadyPanel busy={busy === '触发执行'} onTrigger={handleTrigger} />
        ) : (
          <div className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col">
            <WorkspaceEventStream events={streamEvents} live={targetLive} />
          </div>
        )}
      </div>

      {canIntervene ? (
        <div className="shrink-0 border-t border-white/[0.06] bg-pop-bg px-4 pb-3 pt-2">
          <div className="mx-auto w-full max-w-4xl">
            <div className="flex items-start gap-2 rounded-[9px] border border-white/[0.08] bg-pop-paper/60 px-2.5 py-1.5 transition-colors focus-within:border-white/[0.16]">
              <span aria-hidden className="shrink-0 pt-1.5 font-bold leading-6 text-pop-pink">❯</span>
              <textarea
                rows={1}
                value={draft}
                disabled={busy !== null}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
                }}
                placeholder={status === 'paused' ? '已暂停 · 输入干预后恢复…' : '输入干预… 发送会暂停当前轮并注入'}
                className="min-h-6 flex-1 resize-none border-0 bg-transparent px-0 py-1.5 text-[12.5px] leading-6 text-pop-ink outline-none placeholder:text-pop-dim/70"
                data-testid="task-run-intervention"
              />
              <span className="shrink-0 pt-1">
                <button
                  type="button"
                  onClick={handleSend}
                  disabled={!draft.trim() || busy !== null}
                  className="grid size-6 place-items-center rounded-md border border-white/[0.08] bg-pop-pink text-[10px] font-bold text-pop-bg transition-opacity disabled:opacity-35"
                  title="发送干预（暂停当前轮并注入）"
                >
                  ⏎
                </button>
              </span>
            </div>
            <div className="mt-2 flex items-center gap-2 text-[10px] text-pop-dim/85">
              {status === 'paused' ? (
                <button
                  type="button"
                  onClick={handleResume}
                  disabled={busy !== null}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-white/[0.05] hover:text-pop-ink"
                >
                  <Play className="size-3" /> 恢复
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handlePause}
                  disabled={busy !== null}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-white/[0.05] hover:text-pop-ink"
                >
                  <Pause className="size-3" /> 暂停
                </button>
              )}
              <button
                type="button"
                onClick={() => setAbortOpen(true)}
                disabled={busy !== null}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-pop-red/80 hover:bg-pop-red/10 hover:text-pop-red"
              >
                <Square className="size-2.5" /> 中止
              </button>
              <span className="ml-auto flex min-w-0 items-center gap-2">
                {busy && <span className="flex items-center gap-1 text-pop-amber"><Spinner className="size-3" />{busy}…</span>}
                <span className="truncate">⏎ 干预 · ⇧⏎ 换行</span>
              </span>
            </div>
          </div>
        </div>
      ) : (
        <div className="shrink-0 border-t border-white/[0.06] px-4 py-2 text-center text-[10.5px] text-pop-dim">
          {status === 'ready' ? '待执行 · 触发后进入运行视图' : '本轮已结束 · 可打开验收/变更窗口回看'}
        </div>
      )}

      <ConfirmDialog
        open={abortOpen}
        onOpenChange={setAbortOpen}
        title="中止当前执行？"
        description="当前轮会被中止，任务需要重新入队/触发才能继续。"
        confirmLabel="中止"
        variant="destructive"
        onConfirm={handleAbort}
      />
    </div>
  )
}

function ReadyPanel({ busy, onTrigger }: { busy: boolean; onTrigger: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="grid size-10 place-items-center rounded-xl bg-white/[0.04] text-pop-cyan">
        <Play className="size-5" strokeWidth={1.6} />
      </div>
      <div className="mt-3 text-[13px] font-medium text-pop-ink">待执行</div>
      <p className="mt-1 max-w-sm text-[11.5px] leading-relaxed text-pop-dim">
        规格与工作区已就绪。触发后会在同一个 workspace 的 projects/ 下挂载 worktree 并开始执行。
      </p>
      <button
        type="button"
        onClick={onTrigger}
        disabled={busy}
        className="mt-4 flex items-center gap-1.5 rounded-md border border-pop-green/60 bg-pop-green-soft px-3 py-1.5 text-[11.5px] font-medium text-pop-green transition-colors hover:bg-pop-green/15 disabled:opacity-50"
      >
        {busy ? <Spinner className="size-3" /> : <Play className="size-3" />} 触发执行
      </button>
    </div>
  )
}
