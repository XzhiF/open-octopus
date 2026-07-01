'use client'

import { useState, useRef, useEffect } from 'react'
import { Send, Square, MessageSquare } from 'lucide-react'
import type { AgentMessage, ToolCallRecord } from '@/lib/agent/types'
import { AutoResizeTextarea } from '@/components/ui/auto-resize-textarea'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ChatBubble } from './ChatBubble'
import { ToolCallCard } from './ToolCallCard'
import { StreamingIndicator } from './StreamingIndicator'
import { DangerConfirmCard } from './DangerConfirmCard'
import { EvolutionConfirmCard } from './EvolutionConfirmCard'
import { AgentEmptyState } from '../shared/AgentEmptyState'
import { SkillProposalCard } from '../knowledge/cards/SkillProposalCard'
import { ReviewCard } from '../knowledge/cards/ReviewCard'

interface ChatAreaProps {
  messages: AgentMessage[]
  streaming: boolean
  streamContent: string
  streamThinking: string
  isThinking: boolean
  toolCalls: ToolCallRecord[]
  pendingConfirm: {
    event_id: string
    type: 'dangerous_command' | 'evolution_major'
    operation: string
    detail: string
  } | null
  error: string | null
  statusMessage: string
  onSend: (message: string) => void
  onStop: () => void
  onConfirm: (eventId: string, decision: 'accept' | 'reject') => void
  hasSession: boolean
  skillProposal?: {
    skillName: string
    category: string
    content: string
    confidence: number
  } | null
  onSkillAction?: (action: 'generate' | 'reject' | 'adjust') => void
  reviewItems?: Array<{
    id: string
    type: 'rule' | 'skill'
    content: string
    source: string
    sourceLabel: string
    targetFile: string
    scope: string
    conflicts: Array<{ existingRule: string; conflictType: string }> | null
    confidence: number
  }>
  onReviewAction?: (id: string, action: 'approve' | 'reject' | 'defer' | 'edit') => void
}

export function ChatArea({
  messages, streaming, streamContent, streamThinking, isThinking, toolCalls, pendingConfirm,
  error, statusMessage, onSend, onStop, onConfirm, hasSession,
  skillProposal, onSkillAction, reviewItems, onReviewAction,
}: ChatAreaProps) {
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, streamContent, toolCalls])

  const handleSend = () => {
    if (!input.trim() || streaming) return
    onSend(input.trim())
    setInput('')
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Content area */}
      {!hasSession ? (
        <AgentEmptyState
          icon={MessageSquare}
          title="开始你的第一个对话"
          description="Agent 可以理解你的意图，自动编排工作流、管理记忆和分身。试试发送一条指令吧。"
        />
      ) : (
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
            {Array.from(new Map(messages.map(m => [m.id, m])).values()).map((msg) => (
              <ChatBubble key={msg.id} message={msg} />
            ))}

            {/* Streaming: thinking first */}
            {streaming && streamThinking && (
              <div className="border-l-2 border-agent-divider pl-3 py-1">
                <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
                  <span className="animate-pulse">💭</span> 思考中{isThinking ? '...' : ' (完成)'}
                </div>
                <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-mono max-h-40 overflow-y-auto">
                  {streamThinking}
                </pre>
              </div>
            )}

            {/* Streaming: tool calls second */}
            {streaming && toolCalls.length > 0 && (
              <div className="space-y-2">
                {Array.from(new Map(toolCalls.map(tc => [tc.id, tc])).values()).map((tc) => (
                  <ToolCallCard key={tc.id} toolCall={tc} />
                ))}
              </div>
            )}

            {/* Streaming: text response last */}
            {streaming && streamContent && (
              <ChatBubble
                message={{
                  id: 'streaming',
                  session_id: '',
                  role: 'assistant',
                  content: streamContent,
                  created_at: new Date().toISOString(),
                  is_summary: false,
                  is_compressed: false,
                  is_edited: false,
                }}
              />
            )}

            {/* Status message */}
            {streaming && statusMessage && (
              <div className="text-xs text-muted-foreground italic">{statusMessage}</div>
            )}

            {/* Streaming indicator — only when no thinking and no content yet */}
            {streaming && !streamContent && !streamThinking && (
              <StreamingIndicator />
            )}

            {/* Confirm cards */}
            {pendingConfirm && pendingConfirm.type === 'dangerous_command' && (
              <DangerConfirmCard
                eventId={pendingConfirm.event_id}
                operation={pendingConfirm.operation}
                detail={pendingConfirm.detail}
                onConfirm={(decision) => onConfirm(pendingConfirm.event_id, decision)}
              />
            )}
            {pendingConfirm && pendingConfirm.type === 'evolution_major' && (
              <EvolutionConfirmCard
                eventId={pendingConfirm.event_id}
                detail={pendingConfirm.detail}
                onConfirm={(decision) => onConfirm(pendingConfirm.event_id, decision)}
              />
            )}

            {/* Knowledge cards: skill proposal + review items */}
            {skillProposal && onSkillAction && (
              <div data-testid="skill-proposal-card">
                <SkillProposalCard
                  skill={skillProposal}
                  onAction={onSkillAction}
                />
              </div>
            )}
            {reviewItems && reviewItems.length > 0 && onReviewAction && (
              <div className="space-y-2">
                {reviewItems.map((item) => (
                  <ReviewCard
                    key={item.id}
                    item={item}
                    onAction={onReviewAction}
                  />
                ))}
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="rounded-md bg-agent-error-light border border-agent-error/20 p-3 text-sm text-agent-error">
                {error}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Input area — always visible */}
      <div className="border-t border-agent-divider bg-agent-surface-raised p-4">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-end gap-2">
            <AutoResizeTextarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleSend()
                }
              }}
              placeholder={streaming ? 'Agent 正在回复中...' : '输入消息，Enter 发送，Shift+Enter 换行'}
              disabled={streaming || !!pendingConfirm}
              className="min-h-[44px] max-h-[200px] resize-none rounded-lg border-agent-divider bg-agent-surface-inset focus-visible:ring-agent-primary"
            />
            {streaming ? (
              <Button
                onClick={onStop}
                variant="outline"
                size="icon"
                className="shrink-0 h-10 w-10 rounded-lg border-agent-error/30 text-agent-error hover:bg-agent-error-light"
              >
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                onClick={handleSend}
                disabled={!input.trim()}
                size="icon"
                className="shrink-0 h-10 w-10 rounded-lg bg-agent-primary hover:bg-agent-primary-hover text-agent-primary-foreground"
              >
                <Send className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
