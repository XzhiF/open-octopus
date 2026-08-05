"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Send, Loader2, ShieldCheck } from "lucide-react"
import { getServerUrl } from "@/lib/server-config"

// ============ Types ============

export interface ChatMessage {
  id: string
  role: "user" | "system"
  content: string
  timestamp: number
  status?: "sending" | "success" | "error"
}

interface HarnessChatbotProps {
  workspaceId: string
  executionId: string
  isRunning?: boolean
}

let msgCounter = 0

export function HarnessChatbot({ workspaceId, executionId, isRunning }: HarnessChatbotProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState("")
  const [sending, setSending] = useState(false)
  const [delegating, setDelegating] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || sending) return

    const userMsg: ChatMessage = {
      id: `msg-${++msgCounter}`,
      role: "user",
      content: text,
      timestamp: Date.now(),
      status: "sending",
    }

    setMessages((prev) => [...prev, userMsg])
    setInput("")
    setSending(true)

    try {
      const res = await fetch(
        `${getServerUrl()}/api/workspaces/${workspaceId}/executions/${executionId}/harness-intervene`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            directive: {
              type: "inject",
              reason: text,
              issued_by: "user",
              message: text,
            },
          }),
        },
      )

      const data = await res.json()

      if (res.ok && data.success) {
        // Update user message status
        setMessages((prev) =>
          prev.map((m) => (m.id === userMsg.id ? { ...m, status: "success" as const } : m)),
        )

        // Add system response
        const sysMsg: ChatMessage = {
          id: `msg-${++msgCounter}`,
          role: "system",
          content: data.message ?? "已注入指令，节点将收到纠正",
          timestamp: Date.now(),
          status: "success",
        }
        setMessages((prev) => [...prev, sysMsg])
      } else {
        // Check if this is a delegation (agent thinking)
        if (data.delegating) {
          setDelegating(true)
          const sysMsg: ChatMessage = {
            id: `msg-${++msgCounter}`,
            role: "system",
            content: "Harness Agent 正在分析并处理...",
            timestamp: Date.now(),
            status: "sending",
          }
          setMessages((prev) => [...prev, sysMsg])
        } else {
          const sysMsg: ChatMessage = {
            id: `msg-${++msgCounter}`,
            role: "system",
            content: data.error ?? "干预失败，请重试",
            timestamp: Date.now(),
            status: "error",
          }
          setMessages((prev) => [...prev, sysMsg])
          setMessages((prev) =>
            prev.map((m) => (m.id === userMsg.id ? { ...m, status: "error" as const } : m)),
          )
        }
      }
    } catch (err) {
      const sysMsg: ChatMessage = {
        id: `msg-${++msgCounter}`,
        role: "system",
        content: `网络错误: ${err instanceof Error ? err.message : "连接失败"}`,
        timestamp: Date.now(),
        status: "error",
      }
      setMessages((prev) => [...prev, sysMsg])
    } finally {
      setSending(false)
      setDelegating(false)
    }
  }, [input, sending, workspaceId, executionId])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Message list */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0 p-2 space-y-2">
        {messages.length === 0 && (
          <div className="text-xs text-muted-foreground text-center py-4">
            输入干预指令，发送给正在执行的节点
          </div>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex gap-2 text-xs ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            {msg.role === "system" && (
              <ShieldCheck className="h-4 w-4 text-violet-500 shrink-0 mt-0.5" />
            )}
            <div
              className={`max-w-[80%] rounded-lg px-2.5 py-1.5 ${
                msg.role === "user"
                  ? "bg-blue-600 text-white"
                  : msg.status === "error"
                    ? "bg-red-950/30 text-red-300 border border-red-800"
                    : "bg-muted text-foreground"
              }`}
            >
              <p className="whitespace-pre-wrap break-words">{msg.content}</p>
              {msg.role === "user" && msg.status === "sending" && (
                <Loader2 className="h-3 w-3 animate-spin inline-block ml-1" />
              )}
            </div>
          </div>
        ))}
        {delegating && (
          <div className="flex items-center gap-2 text-xs text-violet-400 py-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>Harness Agent 思考中...</span>
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="shrink-0 border-t border-border p-2 flex gap-2">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isRunning ? "输入干预指令..." : "执行已结束"}
          disabled={!isRunning || sending}
          className="flex-1 h-8 px-2 text-xs rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
        />
        <Button
          size="sm"
          variant="default"
          className="h-8 w-8 p-0"
          disabled={!input.trim() || sending || !isRunning}
          onClick={handleSend}
        >
          {sending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
    </div>
  )
}
