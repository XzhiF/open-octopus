"use client"

import { useState, useRef, useEffect, useCallback, useMemo } from "react"
import { formatDuration } from "@/lib/format"
import type { ChatMessage, ChatSession } from "@/lib/types"
import { MessageBubble } from "./message-bubble"
import { SessionTabs } from "./session-tabs"
import { getLastAskIdx, isQuestionAnswered, shouldHideAfterCard } from "./message-filter"
import { Send, Square, Check, X } from "lucide-react"

const SHORT_PLACEHOLDER = "输入消息..."
const LONG_PLACEHOLDER = "输入消息... (Enter发送，Shift+Enter换行)"

interface StreamingStatusBarProps {
  isStreaming: boolean
  streamStartMs: number | null
  streamEndState: 'done' | 'aborted' | null
}

function StreamingStatusBar({ isStreaming, streamStartMs, streamEndState }: StreamingStatusBarProps) {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!streamStartMs) return
    if (streamEndState !== null) return
    const tick = () => setElapsed(Math.floor((Date.now() - streamStartMs) / 1000))
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [streamStartMs, streamEndState])

  const visible = isStreaming || streamEndState !== null
  if (!visible) return null

  if (streamEndState === 'done') {
    return (
      <div className="px-4 py-1.5 text-xs text-emerald-500 border-t border-border/50 flex items-center gap-1.5 shrink-0">
        <Check className="w-3 h-3 shrink-0" />
        <span>完成 耗时 {formatDuration(elapsed * 1000)}</span>
      </div>
    )
  }

  if (streamEndState === 'aborted') {
    return (
      <div className="px-4 py-1.5 text-xs text-red-400 border-t border-border/50 flex items-center gap-1.5 shrink-0">
        <X className="w-3 h-3 shrink-0" />
        <span>已中断 {formatDuration(elapsed * 1000)}</span>
      </div>
    )
  }

  return (
    <div className="px-4 py-1.5 text-xs text-muted-foreground border-t border-border/50 flex items-center gap-2 shrink-0">
      <div className="w-2 h-2 bg-blue-400 rounded-full animate-pulse shrink-0" />
      <span>AI 正在工作 {formatDuration(elapsed * 1000)}</span>
    </div>
  )
}

interface ChatPanelProps {
  messages: ChatMessage[]
  sessions: ChatSession[]
  activeSessionId: string | null
  isStreaming: boolean
  status: 'compacting' | 'requesting' | null
  streamStartMs: number | null
  streamEndState: 'done' | 'aborted' | null
  hasMoreMessages: boolean
  onLoadMoreMessages: () => void
  onSendMessage: (content: string) => Promise<void>
  onAbort: () => void
  onCreateSession: () => Promise<string>
  onSelectSession: (sessionId: string) => void
  onDeleteSession: (sessionId: string) => void
  onRenameSession: (sessionId: string, title: string) => void
}

export function ChatPanel({
  messages,
  sessions,
  activeSessionId,
  isStreaming,
  status,
  streamStartMs,
  streamEndState,
  hasMoreMessages,
  onLoadMoreMessages,
  onSendMessage,
  onAbort,
  onCreateSession,
  onSelectSession,
  onDeleteSession,
  onRenameSession,
}: ChatPanelProps) {
  const [input, setInput] = useState("")
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const inputWrapRef = useRef<HTMLDivElement>(null)
  const [placeholder, setPlaceholder] = useState(LONG_PLACEHOLDER)

  useEffect(() => {
    const el = inputWrapRef.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      setPlaceholder(el.offsetWidth < 250 ? SHORT_PLACEHOLDER : LONG_PLACEHOLDER)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const handleSend = async () => {
    const content = input.trim()
    if (!content || isStreaming) return
    setInput("")
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto"
    }
    await onSendMessage(content)
  }

  const handleCreateSession = async () => {
    const id = await onCreateSession()
    onSelectSession(id)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto"
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`
    }
  }

  const answeringState = useMemo(() => {
    const idx = getLastAskIdx(messages)
    return {
      lastAskIdx: idx,
      questionAnswered: isQuestionAnswered(messages, idx),
      lastAskId: idx >= 0 ? messages[idx].id : null,
    }
  }, [messages])

  const scrollRef = useRef<HTMLDivElement>(null)
  const userScrolledUpRef = useRef(false)
  const lastMessageCountRef = useRef(0)

  // Detect user scrolling up — pause auto-scroll so they can read history
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50
    userScrolledUpRef.current = !atBottom
  }, [])

  // Auto-scroll to bottom ONLY when new messages are added (not on every re-render)
  useEffect(() => {
    const el = scrollRef.current
    if (!el || userScrolledUpRef.current) return
    // Only scroll if message count actually increased
    if (messages.length <= lastMessageCountRef.current) return
    lastMessageCountRef.current = messages.length
    el.scrollTop = el.scrollHeight
  }, [messages.length])

  return (
    <div className="flex flex-col h-full bg-background">
      <SessionTabs
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelectSession={onSelectSession}
        onCreateSession={handleCreateSession}
        onDeleteSession={onDeleteSession}
        onRenameSession={onRenameSession}
      />

      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-4 flex flex-col">
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            开始对话 — 发送消息即可与 AI 助手交互
          </div>
        )}
        {hasMoreMessages && (
          <button
            onClick={onLoadMoreMessages}
            className="mb-3 w-full text-xs text-muted-foreground hover:text-foreground py-1.5 border border-border/50 rounded-md transition-colors"
          >
            加载更多消息
          </button>
        )}
        {messages.map((msg, idx) => {
          if (shouldHideAfterCard(msg, idx, answeringState)) return null
          // T-11: per-AI-message retry — re-send last user message before this assistant turn.
          // Walks backward through messages to find the nearest preceding user message.
          const onRetry = msg.role === "assistant" ? (() => {
            for (let i = idx - 1; i >= 0; i--) {
              if (messages[i].role === "user" && messages[i].displayType === "user") {
                return () => { void onSendMessage(messages[i].content) }
              }
            }
            return undefined
          })() : undefined
          return (
            <MessageBubble
              key={`${msg.id}-${msg.displayType}`}
              message={msg}
              isStreaming={isStreaming && (
                msg.displayType === "text" && msg.id === messages[messages.length - 1]?.id
              )}
              isSessionStreaming={isStreaming}
              onAnswer={onSendMessage}
              onRetry={onRetry}
            />
          )
        })}
      </div>

      <StreamingStatusBar isStreaming={isStreaming} streamStartMs={streamStartMs} streamEndState={streamEndState} />

      <div className="border-t border-border p-3 shrink-0">
        <div className="flex items-end gap-2">
          <div ref={inputWrapRef} className="flex-1 min-w-0">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              aria-label="发送消息给 AI 助手"
              rows={1}
              disabled={isStreaming}
              className="w-full bg-secondary rounded-lg px-3 py-2 text-sm resize-none outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 max-h-[120px] placeholder:text-xs"
            />
          </div>
          {isStreaming ? (
            <button
              onClick={onAbort}
              aria-label="停止生成"
              className="p-2 bg-red-500 hover:bg-red-600 text-white rounded-lg transition-colors shrink-0"
              title="停止生成"
            >
              <Square className="w-4 h-4" aria-hidden="true" />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              aria-label="发送消息"
              className="p-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors shrink-0 disabled:opacity-50"
            >
              <Send className="w-4 h-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}