"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import { Brain, ChevronDown } from "lucide-react"

interface ThinkingBlockProps {
  content: string
  isExpanded: boolean
  isStreaming: boolean
}

export function ThinkingBlock({ content, isExpanded, isStreaming }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(isExpanded)

  if (!content) return null

  return (
    <div className="rounded-md border bg-violet-500/5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-violet-600 dark:text-violet-400 hover:text-violet-700 transition-colors"
      >
        <Brain className="h-3.5 w-3.5" />
        <span className="font-medium">
          {isStreaming ? "思考中..." : "思考"}
        </span>
        <ChevronDown
          className={cn("h-3 w-3 ml-auto transition-transform", expanded && "rotate-180")}
        />
      </button>
      {expanded && (
        <div className="border-t border-violet-500/10 px-3 py-2">
          <pre className="whitespace-pre-wrap break-words text-xs font-mono text-muted-foreground leading-relaxed">
            {content}
          </pre>
        </div>
      )}
    </div>
  )
}
