'use client'

import { useEffect, useMemo, useState } from 'react'
import { Activity, Bot, CheckCircle2, ChevronRight, ListTodo, Terminal, Users } from 'lucide-react'
import { useChatSessions } from '@/components/providers/chat-sessions'
import { fetchActivity, fetchRunningQueue, type ActivityEventRow } from '@/lib/api-client'
import type { RunningAgentSession } from '@/lib/agent/api'
import type { TaskView } from '@/lib/tasks-api'
import type { ToolCallRecord } from '@/lib/agent/types'
import { cn } from '@/lib/utils'

export interface ActivitySnapshot {
  queue: QueueRow[]
  events: ActivityEventRow[]
  runningTasks: TaskView[]
  allRunningTasks: TaskView[]
  runningAgents: RunningAgentSession[]
  subagents: ToolCallRecord[]
  count: number
  globalCount: number
}

export type QueueRow = {
  id: string
  workspaceId: string
  workspaceName: string
  workflowName: string
  workflowId: string
  status: string
  progress: number
  startedAt?: string
}

function elapsedLabel(iso?: string | null): string {
  if (!iso) return ''
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 0) return ''
  const s = Math.floor(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`
}

export function useActivitySnapshot(
  workspaceId: string | null,
  tasks: TaskView[],
  runningAgents: RunningAgentSession[],
  toolCalls: ToolCallRecord[],
): ActivitySnapshot {
  const [queue, setQueue] = useState<QueueRow[]>([])
  const [events, setEvents] = useState<ActivityEventRow[]>([])

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const [rows, recent] = await Promise.all([
          fetchRunningQueue(),
          fetchActivity(undefined, 24).catch(() => [] as ActivityEventRow[]),
        ])
        if (!alive) return
        setQueue(Array.isArray(rows) ? rows : [])
        setEvents(recent)
      } catch {
        /* keep last snapshot */
      }
    }
    void load()
    const timer = window.setInterval(load, 3_000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [workspaceId])

  const allRunningTasks = useMemo(
    () => tasks.filter((t) => t.status === 'running' || t.status === 'archiving'),
    [tasks],
  )
  const scopedQueue = useMemo(
    () => (!workspaceId ? queue : queue.filter((row) => row.workspaceId === workspaceId)),
    [queue, workspaceId],
  )
  const scopedTasks = useMemo(
    () => (!workspaceId ? allRunningTasks : allRunningTasks.filter((t) => t.workspace_id === workspaceId)),
    [allRunningTasks, workspaceId],
  )
  const subagents = useMemo(
    () => toolCalls.filter((tc) => tc.name === 'Agent' && (tc.status === 'start' || tc.status === 'running')),
    [toolCalls],
  )

  const count = scopedQueue.length + scopedTasks.length + runningAgents.length + subagents.length
  const globalCount = queue.length + allRunningTasks.length + runningAgents.length + subagents.length
  return {
    queue,
    events,
    runningTasks: scopedTasks,
    allRunningTasks,
    runningAgents,
    subagents,
    count,
    globalCount,
  }
}

/** Embedded activity feed for the right inspector (no floating pill/dialog). */
export function InspectorActivityPanel({
  workspaceId,
  snapshot,
}: {
  workspaceId: string | null
  snapshot: ActivitySnapshot
}) {
  const { setActiveSessionId } = useChatSessions()

  // No scope switch: current workspace first, other workspaces listed below.
  const currentQueue = useMemo(
    () => (workspaceId ? snapshot.queue.filter((r) => r.workspaceId === workspaceId) : snapshot.queue),
    [snapshot.queue, workspaceId],
  )
  const otherQueue = useMemo(
    () => (workspaceId ? snapshot.queue.filter((r) => r.workspaceId !== workspaceId) : []),
    [snapshot.queue, workspaceId],
  )
  const otherTasks = useMemo(
    () =>
      workspaceId
        ? snapshot.allRunningTasks.filter((t) => t.workspace_id !== workspaceId)
        : [],
    [snapshot.allRunningTasks, workspaceId],
  )
  const runningTasks = snapshot.runningTasks
  const scopedEvents = useMemo(
    () =>
      workspaceId
        ? snapshot.events.filter((e) => !e.workspaceId || e.workspaceId === workspaceId)
        : snapshot.events,
    [snapshot.events, workspaceId],
  )

  const focusDesktop = () => window.dispatchEvent(new Event('octopus:focus-desktop'))

  const openWorkflow = (row: QueueRow) => {
    window.dispatchEvent(new CustomEvent('octopus:open-workflow', {
      detail: { workspaceId: row.workspaceId, executionId: row.id, title: row.workflowName },
    }))
    focusDesktop()
  }

  const otherCount = otherQueue.length + otherTasks.length

  return (
    <div className="flex min-h-0 flex-1 flex-col font-mono text-[11px]">
      <div className="flex shrink-0 items-center gap-1 border-b border-white/[0.05] px-2.5 py-2">
        <span className="text-[10px] text-pop-dim">
          {snapshot.globalCount > 0 ? `${snapshot.globalCount} 项运行中` : '暂无运行中活动'}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {currentQueue.length > 0 && (
          <Section icon={Terminal} label={`工作流 · ${currentQueue.length}`}>
            {currentQueue.map((row) => (
              <Row key={row.id} onClick={() => openWorkflow(row)}
                icon={<span className={cn('size-1.5 rounded-full', row.status === 'running' ? 'animate-pulse bg-pop-green' : 'bg-pop-amber')} />}
                title={row.workflowName}
                meta={`${row.workspaceName} · ${row.status}${row.progress ? ` · ${row.progress}%` : ''}`}
                right={elapsedLabel(row.startedAt)}
              />
            ))}
          </Section>
        )}
        {runningTasks.length > 0 && (
          <Section icon={ListTodo} label={`任务 · ${runningTasks.length}`}>
            {runningTasks.map((task) => (
              <Row key={task.id}
                onClick={() => {
                  window.dispatchEvent(new CustomEvent('octopus:open-task', { detail: { taskId: task.id } }))
                  focusDesktop()
                }}
                icon={<span className="size-1.5 animate-pulse rounded-full bg-pop-amber" />}
                title={task.name}
                meta={`${task.status} · ${task.id.slice(0, 8)}`}
                right=""
              />
            ))}
          </Section>
        )}
        {otherCount > 0 && (
          <Section icon={Terminal} label={`其他工作空间 · ${otherCount}`}>
            {otherQueue.map((row) => (
              <Row key={row.id} onClick={() => openWorkflow(row)}
                icon={<span className={cn('size-1.5 rounded-full', row.status === 'running' ? 'animate-pulse bg-pop-green' : 'bg-pop-amber')} />}
                title={row.workflowName}
                meta={`${row.workspaceName} · ${row.status}`}
                right={elapsedLabel(row.startedAt)}
              />
            ))}
            {otherTasks.map((task) => (
              <Row key={task.id}
                onClick={() => {
                  window.dispatchEvent(new CustomEvent('octopus:open-task', { detail: { taskId: task.id } }))
                  focusDesktop()
                }}
                icon={<span className="size-1.5 animate-pulse rounded-full bg-pop-amber" />}
                title={task.name}
                meta={`${task.status} · ${task.id.slice(0, 8)}`}
                right=""
              />
            ))}
          </Section>
        )}
        {snapshot.runningAgents.length > 0 && (
          <Section icon={Bot} label={`Agent · ${snapshot.runningAgents.length}`}>
            {snapshot.runningAgents.map((agent) => (
              <Row key={agent.id}
                onClick={() => { setActiveSessionId(agent.id); focusDesktop() }}
                icon={<span className="size-1.5 animate-pulse rounded-full bg-pop-green" />}
                title={agent.title}
                meta={agent.clone_name ? `clone · ${agent.clone_name}` : 'main chat'}
                right={elapsedLabel(agent.started_at)}
              />
            ))}
          </Section>
        )}
        {snapshot.subagents.length > 0 && (
          <Section icon={Users} label={`子 agent · ${snapshot.subagents.length}`}>
            {snapshot.subagents.map((tc) => (
              <Row key={tc.id}
                icon={<span className="size-1.5 animate-pulse rounded-full bg-pop-purple" />}
                title={String((tc.input as Record<string, unknown> | undefined)?.description ?? 'Agent 调用')}
                meta={String((tc.input as Record<string, unknown> | undefined)?.subagent_type ?? 'subagent')}
                right="running"
              />
            ))}
          </Section>
        )}
        {scopedEvents.length > 0 && (
          <Section icon={CheckCircle2} label="最近事件">
            {[...scopedEvents].reverse().slice(0, 12).map((event) => (
              <Row key={event.id}
                onClick={() => {
                  if (event.executionId && event.workspaceId) {
                    window.dispatchEvent(new CustomEvent('octopus:open-workflow', {
                      detail: { workspaceId: event.workspaceId, executionId: event.executionId, title: event.title },
                    }))
                    focusDesktop()
                  } else if (event.taskId) {
                    window.dispatchEvent(new CustomEvent('octopus:open-task', { detail: { taskId: event.taskId } }))
                    focusDesktop()
                  } else if (event.sessionId) {
                    setActiveSessionId(event.sessionId)
                    focusDesktop()
                  }
                }}
                icon={
                  <span className={cn(
                    'size-1.5 rounded-full',
                    event.severity === 'critical' ? 'bg-pop-red'
                      : event.severity === 'warn' ? 'bg-pop-amber' : 'bg-pop-cyan',
                  )} />
                }
                title={event.title}
                meta={`${event.kind} · ${new Date(event.createdAt).toLocaleTimeString()}`}
                right=""
              />
            ))}
          </Section>
        )}
        {currentQueue.length === 0 && runningTasks.length === 0 && otherCount === 0 &&
          snapshot.runningAgents.length === 0 && snapshot.subagents.length === 0 &&
          scopedEvents.length === 0 && (
            <div className="px-2 py-10 text-center leading-5 text-pop-dim">
              当前没有运行中的任务 / 工作流 / Agent。
            </div>
          )}
      </div>
      <div className="flex shrink-0 items-center gap-1 border-t border-white/[0.05] px-2.5 py-1.5 text-[9.5px] text-pop-dim">
        <Activity className="size-3" />
        工作流 / 任务 / Agent / 子 agent
      </div>
    </div>
  )
}

function Section({ icon: Icon, label, children }: {
  icon: typeof Terminal
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="mb-1.5">
      <div className="flex items-center gap-1.5 px-1.5 py-1 text-[9.5px] text-pop-dim">
        <Icon className="size-3" /> {label}
      </div>
      <div className="space-y-px">{children}</div>
    </div>
  )
}

function Row({ icon, title, meta, right, onClick }: {
  icon: React.ReactNode
  title: string
  meta: string
  right?: string
  onClick?: () => void
}) {
  const Wrapper = onClick ? 'button' : 'div'
  return (
    <Wrapper
      {...(onClick ? { type: 'button' as const, onClick } : {})}
      className={cn(
        'flex w-full items-center gap-2 rounded-[6px] border border-transparent px-1.5 py-1.5 text-left',
        onClick ? 'transition-colors hover:border-white/[0.06] hover:bg-white/[0.04]' : '',
      )}
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-pop-ink">{title}</span>
        <span className="block truncate text-[9px] text-pop-dim">{meta}</span>
      </span>
      {right && <span className="shrink-0 text-[9px] text-pop-dim">{right}</span>}
      {onClick && <ChevronRight className="size-3 shrink-0 text-pop-dim" />}
    </Wrapper>
  )
}
