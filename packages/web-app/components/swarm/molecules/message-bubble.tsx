"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import { ExpertAvatar } from "../atoms/expert-avatar"
import { ChevronDown, ChevronUp } from "lucide-react"
import { formatTokenCount } from "@/lib/format"
import type { SwarmMessage } from "@/lib/swarm-types"

export interface MessageBubbleProps {
  message: SwarmMessage
  isNew?: boolean
  onCollapse?: () => void
}

const COLLAPSE_THRESHOLD = 500

export function MessageBubble({ message, isNew = false, onCollapse }: MessageBubbleProps) {
  const [expanded, setExpanded] = useState(false)
  const shouldCollapse = message.content.length > COLLAPSE_THRESHOLD
  const displayContent = shouldCollapse && !expanded
    ? message.content.slice(0, COLLAPSE_THRESHOLD) + "..."
    : message.content

  const timeStr = new Date(message.timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })

  return (
    <div
      className={cn(
        "flex items-start gap-3 py-2",
        isNew && "animate-swarm-fade-in",
      )}
    >
      <div
        className={cn("shrink-0", onCollapse && "cursor-pointer")}
        onClick={onCollapse}
      >
        <ExpertAvatar role={message.from} size="xs" />
      </div>

      <div className="flex-1 min-w-0">
        <div
          className={cn(
            "flex items-center gap-2 text-xs",
            onCollapse && "cursor-pointer hover:text-foreground/80",
          )}
          onClick={onCollapse}
        >
          <span className="font-medium">{message.from}</span>
          <span className="text-muted-foreground">{timeStr}</span>
          {message.tokens != null && message.tokens > 0 && (
            <span className="text-muted-foreground/60 tabular-nums">
              {formatTokenCount(message.tokens)}
            </span>
          )}
        </div>

        <div className="mt-1 text-sm text-foreground/90 whitespace-pre-wrap break-words">
          {displayContent}
        </div>

        {shouldCollapse && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 text-xs text-swarm-primary hover:text-swarm-primary-hover mt-1"
          >
            {expanded ? (
              <>
                <ChevronUp className="h-3 w-3" />
                收起
              </>
            ) : (
              <>
                <ChevronDown className="h-3 w-3" />
                展开全部 ({message.content.length} 字符)
              </>
            )}
          </button>
        )}
      </div>
    </div>
  )
}
