'use client'

import { useState } from 'react'
import type { AgentMessage, ToolCallRecord } from '@/lib/agent/types'
import { cn } from '@/lib/utils'
import { Bot, User, Brain, Wrench, ChevronRight } from 'lucide-react'
import { ToolCallCard } from './ToolCallCard'

interface ChatBubbleProps {
  message: AgentMessage
}

export function ChatBubble({ message }: ChatBubbleProps) {
  const isUser = message.role === 'user'
  const hasMeta = !isUser && (message.thinking || (message.tool_calls && message.tool_calls.length > 0))

  return (
    <div
      className={cn('flex gap-3', isUser ? 'flex-row-reverse' : 'flex-row')}
      role={isUser ? undefined : 'log'}
      aria-live={isUser ? undefined : 'polite'}
    >
      {/* Avatar */}
      <div className={cn(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
        isUser ? 'bg-primary text-primary-foreground' : 'bg-agent-primary text-agent-primary-foreground'
      )}>
        {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
      </div>

      {/* Content */}
      <div className={cn(
        'rounded-xl px-4 py-2.5 max-w-[85%] text-sm leading-relaxed',
        isUser
          ? 'bg-primary text-primary-foreground'
          : 'bg-agent-surface-raised border border-agent-divider'
      )}>
        {/* Collapsible thinking + tool calls */}
        {hasMeta && (
          <CollapsibleMeta thinking={message.thinking} toolCalls={message.tool_calls!} />
        )}

        {/* Main content */}
        {message.content && (
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
        )}

        {message.is_edited && (
          <span className="text-xs opacity-50 mt-1 block">(已编辑)</span>
        )}
      </div>
    </div>
  )
}

function CollapsibleMeta({ thinking, toolCalls }: { thinking?: string; toolCalls?: ToolCallRecord[] }) {
  const [open, setOpen] = useState(false)
  const tcCount = toolCalls?.length ?? 0
  const hasThinking = !!thinking

  const label = [
    hasThinking ? '💭 思考过程' : '',
    tcCount > 0 ? `🔧 ${tcCount} 个工具调用` : '',
  ].filter(Boolean).join(' · ')

  return (
    <div className="mb-2">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />
        {hasThinking && <Brain className="h-3 w-3" />}
        {tcCount > 0 && <Wrench className="h-3 w-3" />}
        <span>{label}</span>
      </button>

      {open && (
        <div className="mt-2 space-y-2 border-l-2 border-agent-divider pl-3">
          {hasThinking && (
            <div>
              <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground mb-1">
                <Brain className="h-3 w-3" /> 思考过程
              </div>
              <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-mono bg-background/30 rounded p-2 max-h-60 overflow-y-auto">
                {thinking}
              </pre>
            </div>
          )}
          {toolCalls && toolCalls.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                <Wrench className="h-3 w-3" /> 工具调用
              </div>
              {toolCalls.map((tc) => (
                <ToolCallCard key={tc.id} toolCall={tc} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
