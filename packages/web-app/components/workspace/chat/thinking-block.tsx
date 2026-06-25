"use client"

import { useState, useEffect } from "react"
import type { ChatMessage } from "@/lib/types"
import { Brain, ChevronDown } from "lucide-react"

interface ThinkingBlockProps {
  message: ChatMessage
}

export function ThinkingBlock({ message }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(true)
  const [elapsed, setElapsed] = useState(0)
  const startMs = message.thinkingStartMs ?? new Date(message.timestamp).getTime()
  const isActive = !message.thinkingDone
  const hasThinking = Boolean(message.thinkingContent)

  useEffect(() => {
    if (!hasThinking || message.thinkingDone) return
    const tick = () => setElapsed(Math.floor((Date.now() - startMs) / 1000))
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [hasThinking, message.thinkingDone, startMs])

  // Only show for actual thinking content — status bar handles "agent working"
  if (!hasThinking) return null

  return (
    <div className="mb-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors mb-1.5"
      >
        <Brain className="w-3.5 h-3.5" />
        <span className="font-medium">
          {isActive ? "思考中" : "思考"}
        </span>
        {isActive && (
          <span className="tabular-nums">{elapsed}s</span>
        )}
        {!isActive && message.thinkingDuration && (
          <span className="text-emerald-500">耗时{message.thinkingDuration}</span>
        )}
        {!isActive && !message.thinkingDuration && (
          <span className="text-emerald-500">完成</span>
        )}
        <ChevronDown
          className={`w-3 h-3 transition-transform ${expanded ? "rotate-0" : "-rotate-90"}`}
        />
      </button>
      {expanded && (
        <div className="border-l-2 border-border ml-2 pl-3 text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap break-words">
          {message.thinkingContent}
        </div>
      )}
    </div>
  )
}