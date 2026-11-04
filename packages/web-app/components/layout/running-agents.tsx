'use client'

import { Bot, Workflow } from 'lucide-react'
import type { RunningAgentSession, RunningExecution } from '@/lib/agent/api'
import { systemWorkflowLabel } from '@/lib/run-labels'
import { useChatSessions } from '@/components/providers/chat-sessions'
import { useDesktopWindows } from '@/lib/desktop-windows'
import { useRunningAgents } from '@/hooks/use-running-agents'
import { useRunningExecutions } from '@/hooks/use-running-executions'

const MAX_VISIBLE = 6

/** 执行 chip 的人话标题：系统运行 → 人话名，任务轮次 → 任务名；再补 P/R 坐标。 */
function runLabel(run: RunningExecution): string {
  const name = systemWorkflowLabel(run.workflowRef) ?? run.title
  if (run.phaseIndex == null) return name
  const coord = `P${run.phaseIndex}${run.roundIndex != null ? ` · R${run.roundIndex}` : ''}`
  return `${name} · ${coord}`
}

/** chat chip 标题：会话名 + 分身 + 「后台：在跑什么」（2026-11-04）。 */
function agentLabel(agent: RunningAgentSession): string {
  const bg = (agent.background_tasks ?? [])
    .map((task) => task.description?.trim())
    .filter((text): text is string => !!text)
  return `${agent.title}${agent.clone_name ? ` · ${agent.clone_name}` : ''}${bg.length > 0 ? ` · 后台：${bg.join(' / ')}` : ''}`
}

/**
 * Running agent sessions + live workflow executions, newest closest to the
 * Mission Control button.
 *
 * 2026-11-04: chat 流之外，工作流的 Agent 节点也要在这里可见 —— 它们不注册
 * chat 流，只存在于 executions 表。点执行 chip 打开该执行的 DAG/日志浮窗。
 */
export function RunningAgents() {
  const agents = useRunningAgents()
  const executions = useRunningExecutions()
  const { setActiveSessionId } = useChatSessions()
  const { minimizeAll, focusDesktop } = useDesktopWindows()

  if (agents.length === 0 && executions.length === 0) return null

  const visibleRuns = executions.slice(0, MAX_VISIBLE)
  const visibleAgents = agents.slice(0, Math.max(0, MAX_VISIBLE - visibleRuns.length))
  const shown = visibleRuns.length + visibleAgents.length
  const total = executions.length + agents.length

  const openAgent = (id: string) => {
    setActiveSessionId(id)
    minimizeAll()
    focusDesktop()
  }

  const openRun = (run: RunningExecution) => {
    minimizeAll()
    focusDesktop()
    window.dispatchEvent(new CustomEvent('octopus:open-workflow', {
      detail: {
        workspaceId: run.workspaceId,
        executionId: run.id,
        title: runLabel(run),
      },
    }))
  }

  const overflow = [
    ...executions.slice(MAX_VISIBLE).map(runLabel),
    ...agents.slice(Math.max(0, MAX_VISIBLE - visibleRuns.length)).map(agentLabel),
  ]

  return (
    <div
      className="flex min-w-0 flex-row-reverse items-center gap-0.5 overflow-hidden"
      aria-label="运行中的 Agent 与工作流"
      data-testid="running-agents"
    >
      {visibleRuns.map((run) => {
        const label = runLabel(run)
        return (
          <button
            key={run.id}
            type="button"
            data-running-execution={run.id}
            aria-label={`运行中的工作流：${label}`}
            title={`${label} · 运行中`}
            onClick={() => openRun(run)}
            className="relative grid size-6 shrink-0 place-items-center rounded-md border-[1.5px] border-pop-bd/60 bg-pop-violet-soft text-pop-violet transition-colors hover:border-pop-bd hover:bg-accent hover:text-pop-ink"
          >
            <Workflow className="size-4" />
            <span className="absolute -right-0.5 -top-0.5 size-1.5 animate-pulse rounded-full bg-pop-violet" />
          </button>
        )
      })}
      {visibleAgents.map((agent) => {
        const label = agentLabel(agent)
        return (
          <button
            key={agent.id}
            type="button"
            data-running-agent={agent.id}
            aria-label={`运行中的 Agent：${label}`}
            title={`${label} · 运行中`}
            onClick={() => openAgent(agent.id)}
            className="relative grid size-6 shrink-0 place-items-center rounded-md border-[1.5px] border-pop-bd/60 bg-pop-green-soft text-pop-green transition-colors hover:border-pop-bd hover:bg-accent hover:text-pop-ink"
          >
            <Bot className="size-4" />
            <span className="absolute -right-0.5 -top-0.5 size-1.5 animate-pulse rounded-full bg-pop-green" />
          </button>
        )
      })}
      {total > shown && (
        <span
          title={overflow.join(' / ')}
          className="px-1 font-mono text-[9px] text-pop-dim"
        >
          +{total - shown}
        </span>
      )}
    </div>
  )
}
