'use client'

/**
 * Traceability: P-06 × US-25 × TC-034, TC-035
 * AI assistant side panel with SSE streaming, adopt suggestions, 5-round limit
 */

import * as React from 'react'
import {
  Bot,
  Send,
  PanelRightClose,
  PanelRightOpen,
  X,
  AlertTriangle,
  CheckCheck,
  Loader2,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { useKnowledgeAssistant } from '@/hooks/useKnowledgeAssistant'
import type { AssistantMessage } from '@/lib/knowledge/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KnowledgeAssistantPanelProps {
  ruleContent?: string
  skillContent?: string
  executionContext?: {
    reviewBlockers: string[]
    e2eResults: string
    nodeOutputs?: Record<string, string>
  }
  userPreference?: string
  mode: 'review' | 'archive' | 'chat'
  collapsible?: boolean
  onAdopt?: (modifiedContent: string) => void
  onClose?: () => void
  open: boolean
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ROUNDS = 5

const MODE_BADGE: Record<
  KnowledgeAssistantPanelProps['mode'],
  { label: string; className: string }
> = {
  review: {
    label: 'review',
    className: 'bg-knowledge-primary-light text-knowledge-primary',
  },
  archive: {
    label: 'archive',
    className: 'bg-knowledge-accent-light text-knowledge-accent',
  },
  chat: {
    label: 'chat',
    className: 'bg-agent-info-light text-agent-info',
  },
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TypingIndicator() {
  return (
    <div className="flex items-center gap-1 px-3 py-2">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1.5 rounded-full bg-knowledge-primary/60 animate-pulse"
          style={{ animationDelay: `${i * 150}ms` }}
        />
      ))}
    </div>
  )
}

function MessageBubble({
  message,
  onAdopt,
}: {
  message: AssistantMessage
  onAdopt?: (suggestion: string) => void
}) {
  const isUser = message.role === 'user'

  return (
    <div className={cn('flex flex-col gap-1', isUser ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-lg p-3 text-sm leading-relaxed whitespace-pre-wrap break-words',
          isUser
            ? 'bg-knowledge-primary-light text-knowledge-primary'
            : 'bg-knowledge-accent-light',
        )}
      >
        {message.content}
      </div>

      {/* Adopt button for assistant suggestions */}
      {!isUser && message.suggestion && onAdopt && (
        <Button
          size="sm"
          onClick={() => onAdopt(message.suggestion!)}
          className="mt-1 gap-1.5 bg-knowledge-primary text-knowledge-primary-foreground hover:bg-knowledge-primary/90"
        >
          <CheckCheck className="size-3.5" />
          采纳修改
        </Button>
      )}
    </div>
  )
}

function AssistantUnavailable({
  error,
  onRetry,
}: {
  error: string
  onRetry: () => void
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex items-center gap-2 text-agent-error">
        <Bot className="size-5" />
        <AlertTriangle className="size-5" />
      </div>
      <p className="text-sm text-muted-foreground">
        AI 助手暂不可用，您仍可手动审核
      </p>
      <p className="text-xs text-muted-foreground/70">{error}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        重试连接
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function KnowledgeAssistantPanel({
  ruleContent,
  skillContent,
  executionContext,
  userPreference,
  mode,
  collapsible = false,
  onAdopt,
  onClose,
  open,
}: KnowledgeAssistantPanelProps) {
  const {
    messages,
    sendMessage,
    isConnecting,
    error,
    adoptSuggestion,
    resetConversation,
    roundCount,
  } = useKnowledgeAssistant()

  const [collapsed, setCollapsed] = React.useState(false)
  const [inputValue, setInputValue] = React.useState('')
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const scrollViewportRef = React.useRef<HTMLDivElement>(null)
  const hasReceivedFirstResponse = React.useRef(false)

  // Track whether we've received the first AI response
  React.useEffect(() => {
    if (messages.some((m) => m.role === 'assistant')) {
      hasReceivedFirstResponse.current = true
    }
  }, [messages])

  // Reset tracking when panel re-opens
  React.useEffect(() => {
    if (open) {
      hasReceivedFirstResponse.current = false
    }
  }, [open])

  // Auto-scroll to bottom when messages change or connecting state changes
  React.useEffect(() => {
    const viewport = scrollViewportRef.current
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight
    }
  }, [messages, isConnecting])

  // Auto-resize textarea
  const handleInputChange = React.useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setInputValue(e.target.value)
      const el = e.target
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 120)}px`
    },
    [],
  )

  const atRoundLimit = roundCount >= MAX_ROUNDS

  const handleSend = React.useCallback(() => {
    const trimmed = inputValue.trim()
    if (!trimmed || isConnecting || atRoundLimit) return

    const execCtx = executionContext
      ? JSON.stringify(executionContext)
      : undefined

    sendMessage(trimmed, {
      mode,
      ruleContent,
      skillContent,
      userPreference,
      executionContext: execCtx,
    }).catch((err) => {
      toast.error(err instanceof Error ? err.message : '发送失败')
    })

    setInputValue('')
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [
    inputValue,
    isConnecting,
    atRoundLimit,
    sendMessage,
    mode,
    ruleContent,
    skillContent,
    userPreference,
    executionContext,
  ])

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend],
  )

  const handleAdopt = React.useCallback(
    (suggestion: string) => {
      adoptSuggestion()
      onAdopt?.(suggestion)
      toast.success('已采纳修改')
    },
    [adoptSuggestion, onAdopt],
  )

  const handleRetry = React.useCallback(() => {
    resetConversation()
  }, [resetConversation])

  const handleToggleCollapse = React.useCallback(() => {
    setCollapsed((prev) => !prev)
  }, [])

  // Don't render if closed
  if (!open) return null

  const badge = MODE_BADGE[mode]
  const showInitialLoading =
    !error && !hasReceivedFirstResponse.current && messages.length === 0

  return (
    <div
      className={cn(
        'flex flex-col border-l border-agent-divider bg-agent-surface-raised overflow-hidden',
        'animate-[knowledge-slide-in_250ms_ease-out]',
        'transition-[width] duration-200 ease-in-out',
        collapsed ? 'w-0 border-l-0' : 'w-[45%] min-w-[320px]',
      )}
    >
      {/* ── Header (48px) ── */}
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 px-3 bg-knowledge-accent-light">
        <div className="flex items-center gap-2 min-w-0">
          <Bot className="size-4 shrink-0 text-knowledge-primary" />
          <span className="text-sm font-medium truncate">AI 助手</span>
          <span
            className={cn(
              'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium',
              badge.className,
            )}
          >
            {badge.label}
          </span>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {collapsible && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleToggleCollapse}
              aria-label={collapsed ? '展开面板' : '折叠面板'}
            >
              {collapsed ? (
                <PanelRightOpen className="size-4" />
              ) : (
                <PanelRightClose className="size-4" />
              )}
            </Button>
          )}
          {onClose && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              aria-label="关闭面板"
            >
              <X className="size-4" />
            </Button>
          )}
        </div>
      </div>

      {/* ── Body ── */}
      {error ? (
        <AssistantUnavailable error={error} onRetry={handleRetry} />
      ) : (
        <>
          {/* ── Messages ── */}
          <ScrollArea className="flex-1">
            <div
              ref={scrollViewportRef}
              className="flex flex-col gap-3 p-3"
            >
              {showInitialLoading ? (
                <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  正在分析规则上下文...
                </div>
              ) : (
                <>
                  {messages.map((msg) => (
                    <MessageBubble
                      key={msg.id}
                      message={msg}
                      onAdopt={handleAdopt}
                    />
                  ))}

                  {isConnecting && (
                    <div className="flex items-start">
                      <div className="bg-knowledge-accent-light rounded-lg">
                        <TypingIndicator />
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </ScrollArea>

          {/* ── Input area ── */}
          <div className="shrink-0 border-t border-agent-divider p-3">
            {atRoundLimit ? (
              <p className="text-center text-xs text-muted-foreground py-2">
                已达最大对话轮次 ({roundCount}/{MAX_ROUNDS})
              </p>
            ) : (
              <div className="flex items-end gap-2">
                <Textarea
                  ref={textareaRef}
                  value={inputValue}
                  onChange={handleInputChange}
                  onKeyDown={handleKeyDown}
                  placeholder="输入问题或指令..."
                  disabled={isConnecting}
                  className="min-h-[36px] max-h-[120px] resize-none text-sm"
                  rows={1}
                />
                <Button
                  size="icon"
                  onClick={handleSend}
                  disabled={
                    isConnecting || !inputValue.trim()
                  }
                  aria-label="发送"
                  className="shrink-0 bg-knowledge-primary text-knowledge-primary-foreground hover:bg-knowledge-primary/90"
                >
                  {isConnecting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Send className="size-4" />
                  )}
                </Button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
