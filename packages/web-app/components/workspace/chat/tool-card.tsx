"use client"

import { useState, useEffect } from "react"
import type { ChatMessage } from "@/lib/types"
import { Wrench, Loader2 } from "lucide-react"

interface ToolCardProps {
  message: ChatMessage
}

const statusConfig = {
  running: {
    border: "border-l-blue-400",
    icon: Loader2,
    iconClass: "text-blue-400 animate-spin",
    text: "",
    textClass: "text-muted-foreground",
    bg: "bg-secondary",
  },
  done: {
    border: "border-l-emerald-400",
    icon: Wrench,
    iconClass: "text-emerald-400",
    text: "完成",
    textClass: "text-emerald-500",
    bg: "bg-secondary",
  },
  error: {
    border: "border-l-red-400",
    icon: Wrench,
    iconClass: "text-red-400",
    text: "失败",
    textClass: "text-red-400",
    bg: "bg-red-950/20",
  },
}

export function ToolCard({ message }: ToolCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [liveElapsed, setLiveElapsed] = useState<number>(0)

  useEffect(() => {
    if (message.toolStatus !== "running") return
    const startTime = new Date(message.timestamp).getTime()
    const tick = () => setLiveElapsed(Number(((Date.now() - startTime) / 1000).toFixed(1)))
    tick()
    const timer = setInterval(tick, 100)
    return () => clearInterval(timer)
  }, [message.toolStatus, message.timestamp])

  const config = statusConfig[message.toolStatus ?? "running"]
  const Icon = config.icon
  const hasDetails = Boolean(message.toolInput) || Boolean(message.toolResult)

  const displayDuration = message.toolStatus === "running"
    ? liveElapsed > 0 ? `${liveElapsed.toFixed(1)}s` : undefined
    : message.toolDuration

  return (
    <div className="mb-1.5">
      <div
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs border-l-3 ${config.border} ${config.bg} max-w-full cursor-pointer`}
        onClick={() => hasDetails && setExpanded(!expanded)}
        title={message.toolName}
      >
        <Icon className={`w-3 h-3 shrink-0 ${config.iconClass}`} />
        <span className="font-medium truncate">{message.toolName}</span>
        {Boolean(message.toolInput) && (
          <span className="text-muted-foreground truncate max-w-[120px]">
            {typeof message.toolInput === "string"
              ? message.toolInput
              : JSON.stringify(message.toolInput).slice(0, 60)}
          </span>
        )}
        {displayDuration && (
          <span className="text-muted-foreground tabular-nums shrink-0">{displayDuration}</span>
        )}
        {config.text && (
          <span className={`shrink-0 ${config.textClass}`}>{config.text}</span>
        )}
      </div>
      {expanded && hasDetails && (
        <div className="mt-1 ml-2 bg-secondary rounded-md p-2 text-xs font-mono text-muted-foreground max-h-32 overflow-y-auto whitespace-pre-wrap break-all">
          {Boolean(message.toolInput) && (
            <div className="mb-1">
              <span className="text-muted-foreground/60">{"// 输入: "}</span>
              {typeof message.toolInput === "string"
                ? message.toolInput
                : JSON.stringify(message.toolInput, null, 2)}
            </div>
          )}
          {message.toolResult && (
            <div>
              <span className="text-muted-foreground/60">{"// 结果: "}</span>
              {message.toolResult}
            </div>
          )}
        </div>
      )}
    </div>
  )
}