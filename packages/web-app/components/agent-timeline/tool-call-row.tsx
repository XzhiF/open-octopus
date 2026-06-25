"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Wrench, ChevronDown, AlertCircle } from "lucide-react"

interface ToolCallRowProps {
  toolName: string
  durationMs: number
  isError: boolean
  inputPreview: string
  resultPreview: string
}

export function ToolCallRow({ toolName, durationMs, isError, inputPreview, resultPreview }: ToolCallRowProps) {
  const [expanded, setExpanded] = useState(false)
  const hasDetails = inputPreview || resultPreview

  return (
    <div className={cn(
      "rounded-md border transition-colors",
      isError ? "border-red-200 bg-red-500/5 dark:border-red-900" : "hover:bg-muted/30",
    )}>
      <button
        onClick={() => hasDetails && setExpanded(!expanded)}
        className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-sm", hasDetails && "cursor-pointer")}
      >
        <Wrench className={cn("h-3.5 w-3.5 shrink-0", isError ? "text-red-500" : "text-amber-500")} />
        <Badge variant={isError ? "destructive" : "secondary"} className="text-xs font-mono">
          {toolName}
        </Badge>
        {durationMs > 0 && (
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            {durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`}
          </span>
        )}
        {isError && <AlertCircle className="h-3.5 w-3.5 text-red-500" />}
        {hasDetails && (
          <ChevronDown className={cn("h-3 w-3 text-muted-foreground transition-transform", expanded && "rotate-180")} />
        )}
      </button>

      {expanded && hasDetails && (
        <div className="border-t px-3 py-2 space-y-1.5">
          {inputPreview && (
            <div>
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Input</span>
              <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs font-mono max-h-32 overflow-auto">
                {inputPreview}
              </pre>
            </div>
          )}
          {resultPreview && (
            <div>
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Result</span>
              <pre className={cn(
                "mt-1 whitespace-pre-wrap break-words rounded p-2 text-xs font-mono max-h-32 overflow-auto",
                isError ? "bg-red-500/10 text-red-600 dark:text-red-400" : "bg-muted",
              )}>
                {resultPreview}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
