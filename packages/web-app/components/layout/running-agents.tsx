'use client'

import { Bot } from 'lucide-react'
import { useChatSessions } from '@/components/providers/chat-sessions'
import { useDesktopWindows } from '@/lib/desktop-windows'
import { useRunningAgents } from '@/hooks/use-running-agents'

const MAX_VISIBLE = 6

/** Running agent sessions, newest closest to the Mission Control button. */
export function RunningAgents() {
  const agents = useRunningAgents()
  const { setActiveSessionId } = useChatSessions()
  const { minimizeAll, focusDesktop } = useDesktopWindows()

  if (agents.length === 0) return null

  const visible = agents.slice(0, MAX_VISIBLE)

  const openAgent = (id: string) => {
    setActiveSessionId(id)
    minimizeAll()
    focusDesktop()
  }

  return (
    <div
      className="flex min-w-0 flex-row-reverse items-center gap-0.5 overflow-hidden"
      aria-label="运行中的 Agent"
      data-testid="running-agents"
    >
      {visible.map((agent) => {
        const label = `${agent.title}${agent.clone_name ? ` · ${agent.clone_name}` : ''}`
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
      {agents.length > MAX_VISIBLE && (
        <span
          title={agents
            .slice(MAX_VISIBLE)
            .map((agent) => agent.title)
            .join(' / ')}
          className="px-1 font-mono text-[9px] text-pop-dim"
        >
          +{agents.length - MAX_VISIBLE}
        </span>
      )}
    </div>
  )
}
