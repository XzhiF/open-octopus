"use client"

import { useState, useRef, useEffect } from "react"
import { Send, Square, Wrench, Brain } from "lucide-react"
import type { CloneMessage } from "@/lib/clone-chat"

interface CloneChatViewProps {
  messages: CloneMessage[]
  isStreaming: boolean
  status: "requesting" | null
  onSend: (content: string) => void
  onAbort: () => void
}

function ThinkingBlock({ content }: { content: string }) {
  return (
    <div className="flex items-start gap-2 my-2 text-xs text-muted-foreground border-l-2 border-primary/40 pl-3">
      <Brain className="size-3.5 mt-0.5 shrink-0" />
      <pre className="whitespace-pre-wrap font-sans break-words">{content}</pre>
    </div>
  )
}

function ToolBlock({ msg }: { msg: CloneMessage }) {
  const statusColor =
    msg.toolStatus === "done"
      ? "text-emerald-500"
      : msg.toolStatus === "error"
        ? "text-red-400"
        : "text-blue-400"
  return (
    <div className="my-2 rounded-md border border-border bg-muted/40 p-2 text-xs">
      <div className={`flex items-center gap-1.5 font-medium ${statusColor}`}>
        <Wrench className="size-3.5 shrink-0" />
        <span>{msg.toolName ?? "tool"}</span>
        <span className="text-muted-foreground">
          {msg.toolStatus === "running" ? "执行中…" : msg.toolStatus === "error" ? "失败" : "完成"}
        </span>
      </div>
      {msg.toolResult ? (
        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">
          {msg.toolResult}
        </pre>
      ) : null}
    </div>
  )
}

function StreamingStatusBar({ isStreaming, status }: { isStreaming: boolean; status: "requesting" | null }) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!isStreaming) {
      setElapsed(0)
      return
    }
    const tick = () => setElapsed((e) => e + 1)
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [isStreaming])

  if (!isStreaming) return null
  return (
    <div className="flex items-center gap-2 px-4 py-1.5 text-xs text-muted-foreground border-t border-border/50 shrink-0">
      <div className="size-2 bg-blue-400 rounded-full animate-pulse shrink-0" />
      <span>{status === "requesting" ? "请求中…" : `AI 正在工作 ${elapsed}s`}</span>
    </div>
  )
}

export function CloneChatView({ messages, isStreaming, status, onSend, onAbort }: CloneChatViewProps) {
  const [input, setInput] = useState("")
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages.length])

  const handleSend = () => {
    const content = input.trim()
    if (!content || isStreaming) return
    setInput("")
    if (textareaRef.current) textareaRef.current.style.height = "auto"
    onSend(content)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0 bg-background" data-clone-chat>
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 flex flex-col gap-1">
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm text-center px-4">
            描述你的需求 — task-author 会生成结构化 spec，确认后点 [入队] 执行。
          </div>
        )}
        {messages.map((msg) => {
          if (msg.role === "user") {
            return (
              <div key={msg.id} className="self-end max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground whitespace-pre-wrap break-words">
                {msg.content}
              </div>
            )
          }
          if (msg.kind === "thinking") {
            return msg.content ? <ThinkingBlock key={msg.id} content={msg.content} /> : null
          }
          if (msg.kind === "tool_call") {
            return <ToolBlock key={msg.id} msg={msg} />
          }
          return (
            <div key={msg.id} className="self-start max-w-[85%] rounded-lg bg-secondary px-3 py-2 text-sm whitespace-pre-wrap break-words">
              {msg.content}
            </div>
          )
        })}
      </div>

      <StreamingStatusBar isStreaming={isStreaming} status={status} />

      <div className="border-t border-border p-2.5 shrink-0">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              if (textareaRef.current) {
                textareaRef.current.style.height = "auto"
                textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`
              }
            }}
            onKeyDown={handleKeyDown}
            placeholder="描述需求… (Enter 发送，Shift+Enter 换行)"
            aria-label="发送消息给 task-author"
            rows={1}
            disabled={isStreaming}
            className="flex-1 min-w-0 bg-secondary rounded-lg px-3 py-2 text-sm resize-none outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 max-h-[120px] placeholder:text-xs"
          />
          {isStreaming ? (
            <button
              onClick={onAbort}
              aria-label="停止生成"
              className="p-2 bg-red-500 hover:bg-red-600 text-white rounded-lg transition-colors shrink-0"
              title="停止生成"
            >
              <Square className="size-4" aria-hidden="true" />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              aria-label="发送消息"
              className="p-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors shrink-0 disabled:opacity-50"
            >
              <Send className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
