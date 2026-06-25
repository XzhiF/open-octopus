"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ExpertAvatar } from "../atoms/expert-avatar"
import { StatusDot } from "../atoms/status-dot"
import { TokenBar } from "../atoms/token-bar"
import { ChevronDown, ChevronRight, AlertCircle } from "lucide-react"
import type { ExpertInfo } from "@/lib/swarm-types"

export interface ExpertRowProps {
  expert: ExpertInfo
  highlighted?: boolean
}

export function ExpertRow({ expert, highlighted = false }: ExpertRowProps) {
  const [reasoningOpen, setReasoningOpen] = useState(false)
  const isFailed = expert.status === "failed" || expert.status === "budget_exceeded"
  const isDynamic = expert.source === "dynamic"

  const modelLabel = expert.model

  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors",
        highlighted ? "border-swarm-primary bg-swarm-primary/5 ring-1 ring-swarm-primary/30" : "border-border bg-card",
        isFailed && "border-swarm-expert-failed/40",
      )}
    >
      <ExpertAvatar role={expert.role} size="sm" status={expert.status} />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium truncate">{expert.role}</span>
          <StatusDot status={expert.status} pulse={expert.status === "running"} />
          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
            {modelLabel}
          </Badge>
          {isDynamic && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
              Dynamic
            </Badge>
          )}
          {expert.attempts > 1 && (
            <span className="text-[10px] text-muted-foreground">
              x{expert.attempts}
            </span>
          )}
        </div>

        <div className="mt-1.5">
          <TokenBar consumed={expert.tokensConsumed} inputTokens={expert.inputTokens} outputTokens={expert.outputTokens} showLabel />
        </div>

        {expert.output && expert.status === "completed" && (
          <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
            {expert.output.length > 200 ? expert.output.slice(0, 200) + "..." : expert.output}
          </p>
        )}

        {isFailed && expert.error && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="mt-1 flex items-center gap-1 text-xs text-swarm-expert-failed cursor-default">
                <AlertCircle className="h-3 w-3" />
                <span className="line-clamp-1">{expert.error}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs">
              <p className="whitespace-pre-wrap">{expert.error}</p>
            </TooltipContent>
          </Tooltip>
        )}

        {isDynamic && expert.routerReasoning && (
          <Collapsible open={reasoningOpen} onOpenChange={setReasoningOpen}>
            <CollapsibleTrigger className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground mt-1">
              {reasoningOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              Router 推理
            </CollapsibleTrigger>
            <CollapsibleContent>
              <p className="text-[10px] text-muted-foreground mt-1 whitespace-pre-wrap pl-4">
                {expert.routerReasoning}
              </p>
              {expert.matchScore != null && (
                <div className="flex items-center gap-2 mt-1 pl-4">
                  <span className="text-[10px] text-muted-foreground">匹配分:</span>
                  <div className="h-1 w-16 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-swarm-primary"
                      style={{ width: `${expert.matchScore * 100}%` }}
                    />
                  </div>
                  <span className="text-[10px] font-medium tabular-nums">
                    {(expert.matchScore * 100).toFixed(0)}%
                  </span>
                </div>
              )}
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </div>
  )
}
