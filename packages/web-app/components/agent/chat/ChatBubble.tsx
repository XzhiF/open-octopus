'use client'

import { useState, useMemo } from 'react'
import type { AgentMessage, MessageTimelineEntry, ToolCallRecord } from '@/lib/agent/types'
import { cn } from '@/lib/utils'
import { Bot, User, Brain, Wrench, ChevronRight, Square } from 'lucide-react'
import { ToolCallCard } from './ToolCallCard'

interface ChatBubbleProps {
  message: AgentMessage
}

export function ChatBubble({ message }: ChatBubbleProps) {
  const isUser = message.role === 'user'
  const timeline = !isUser ? message.timeline : undefined
  const hasTimeline = !!timeline && timeline.length > 0
  const hasMeta = !isUser && !!(message.thinking || (message.tool_calls && message.tool_calls.length > 0) || hasTimeline)

  // Chronological timeline (2026-08-19): the bubble body shows only the FINAL
  // agent text segment; earlier fragments / thinking / tools live in the
  // collapsed meta in arrival order. Without a timeline (old messages) the
  // full content is shown as before.
  const displayContent = useMemo(() => {
    if (!hasTimeline) return message.content
    const texts = timeline!.filter((e) => e.kind === 'text' && e.text)
    const last = texts[texts.length - 1]
    return last?.text ?? message.content
  }, [hasTimeline, timeline, message.content])

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
        {/* Collapsible thinking + tool calls (+ chronological timeline) */}
        {hasMeta && (
          <CollapsibleMeta thinking={message.thinking} toolCalls={message.tool_calls ?? []} timeline={timeline} />
        )}

        {/* Main content */}
        {displayContent && (
          <div className="whitespace-pre-wrap break-words">{displayContent}</div>
        )}

        {/* No text content but has tool calls / thinking — show a placeholder
            so the bubble isn't completely empty */}
        {!displayContent && hasMeta && (
          <div className="text-muted-foreground italic text-xs">（未生成文本回复）</div>
        )}

        {message.is_edited && (
          <span className="text-xs opacity-50 mt-1 block">(已编辑)</span>
        )}

        {/* Interrupted indicator — user stopped the response mid-stream */}
        {message.interrupted && (
          <div className="flex items-center gap-1.5 mt-2 pt-2 border-t border-dashed border-agent-warn/40">
            <Square className="h-3 w-3 text-agent-warn" />
            <span className="text-xs text-agent-warn">回复已被用户中断</span>
          </div>
        )}
      </div>
    </div>
  )
}

function CollapsibleMeta({ thinking, toolCalls, timeline }: {
  thinking?: string
  toolCalls?: ToolCallRecord[]
  timeline?: MessageTimelineEntry[]
}) {
  const [open, setOpen] = useState(false)
  const tcCount = toolCalls?.length ?? 0
  const hasThinking = !!thinking
  const hasTimeline = !!timeline && timeline.length > 0

  // The final text fragment is the bubble body — don't repeat it in the meta.
  const lastTextIdx = useMemo(() => {
    if (!hasTimeline) return -1
    for (let i = timeline!.length - 1; i >= 0; i--) {
      if (timeline![i].kind === 'text') return i
    }
    return -1
  }, [hasTimeline, timeline])

  const label = hasTimeline
    ? `💭 过程（时间序）· ${timeline!.length} 步`
    : [
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
          {hasTimeline ? (
            timeline!.map((entry, i) => {
              if (entry.kind === 'thinking') {
                return (
                  <div key={i}>
                    <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground mb-1">
                      <Brain className="h-3 w-3" /> 思考
                    </div>
                    <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-mono bg-background/30 rounded p-2 max-h-60 overflow-y-auto">
                      {entry.text}
                    </pre>
                  </div>
                )
              }
              if (entry.kind === 'tool') {
                const tc = toolCalls?.find((t) => t.id === entry.id)
                return tc ? <ToolCallCard key={i} toolCall={tc} /> : null
              }
              // text fragment (skip the final one — it's the bubble body)
              if (i === lastTextIdx) return null
              return (
                <div key={i}>
                  <div className="text-xs font-medium text-muted-foreground mb-1">agent 输出片段</div>
                  <div className="text-xs whitespace-pre-wrap break-words bg-background/30 rounded p-2 text-muted-foreground">
                    {entry.text}
                  </div>
                </div>
              )
            })
          ) : (
            <>
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
            </>
          )}
        </div>
      )}
    </div>
  )
}
