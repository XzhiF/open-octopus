"use client"

import { useState, useEffect } from "react"
import type { ChatMessage } from "@/lib/types"
import { Wrench, Loader2 } from "lucide-react"

interface ToolCardProps {
  message: ChatMessage
}

const statusConfig = {
  running: {
    icon: Loader2,
    iconClass: "text-pop-cyan animate-spin",
    text: "",
    textClass: "text-muted-foreground",
    card: "bg-pop-paper hover:bg-pop-yellow-soft",
  },
  done: {
    icon: Wrench,
    iconClass: "text-pop-green",
    text: "完成",
    textClass: "text-pop-green",
    card: "bg-pop-paper hover:bg-pop-yellow-soft",
  },
  error: {
    icon: Wrench,
    iconClass: "text-pop-red",
    text: "失败",
    textClass: "text-pop-red",
    card: "bg-pop-pink-soft hover:bg-pop-pink-soft/70",
  },
}

export function ToolCard({ message }: ToolCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [liveElapsed, setLiveElapsed] = useState<number>(0)

  useEffect(() => {
    if (message.toolStatus !== "running") return
    const startTime = new Date(message.timestamp).getTime()
    const tick = () => setLiveElapsed(Number(((Date.now() - startTime) / 1000).toFixed(1))) // fmt-ok: 协议数值
    tick()
    const timer = setInterval(tick, 100)
    return () => clearInterval(timer)
  }, [message.toolStatus, message.timestamp])

  const config = statusConfig[message.toolStatus ?? "running"]
  const Icon = config.icon
  const hasDetails = Boolean(message.toolInput) || Boolean(message.toolResult)

  const displayDuration = message.toolStatus === "running"
    ? liveElapsed > 0 ? `${liveElapsed.toFixed(1)}s` : undefined // fmt-ok: 协议文本
    : message.toolDuration

  return (
    <div className="mb-1.5">
      <div
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs border-2 border-pop-bd shadow-pop-sm transition-colors ${config.card} max-w-full cursor-pointer`}
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
        <div className="mt-1 ml-2 rounded-lg border-2 border-pop-bd bg-pop-bg p-2 text-xs font-mono text-muted-foreground max-h-32 overflow-y-auto whitespace-pre-wrap break-all">
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