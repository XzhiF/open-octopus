"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ChevronDown, ChevronRight, Brain } from "lucide-react"
import type { RouterDecision } from "@/lib/swarm-types"

export interface RouterDecisionCardProps {
  decision: RouterDecision
}

export function RouterDecisionCard({ decision }: RouterDecisionCardProps) {
  const [open, setOpen] = useState(true)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-lg border border-swarm-mode-swarm/30 bg-swarm-primary/5 overflow-hidden">
        <CollapsibleTrigger className="flex items-center gap-2 w-full px-3 py-2.5 text-sm font-medium hover:bg-swarm-primary/10 transition-colors">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          <Brain className="h-4 w-4 text-swarm-primary" />
          <span>Router 决策</span>
          <span className="ml-auto text-xs text-muted-foreground font-normal">
            模式: {decision.mode}
          </span>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="px-3 pb-3 space-y-3">
            {/* Mode reasoning */}
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">模式推理</p>
              <p className="text-xs text-foreground/80 whitespace-pre-wrap">
                {decision.modeReasoning}
              </p>
            </div>

            {/* Selected experts */}
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
                选中专家 ({decision.experts.length})
              </p>
              <div className="space-y-1.5">
                {decision.experts.map((expert, i) => (
                  <div key={i} className="rounded-md border border-border bg-card px-2.5 py-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium">{expert.role}</span>
                      <span className="text-[10px] text-muted-foreground">
                        from {expert.matchedFrom}
                      </span>
                      <div className="ml-auto flex items-center gap-1.5">
                        <div className="h-1 w-12 rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-full rounded-full bg-swarm-primary"
                            style={{ width: `${expert.matchScore * 100}%` }}
                          />
                        </div>
                        <span className="text-[10px] font-medium tabular-nums">
                          {(expert.matchScore * 100).toFixed(0)}%
                        </span>
                      </div>
                    </div>
                    <p className={cn("text-[10px] text-muted-foreground mt-1 whitespace-pre-wrap")}>
                      {expert.matchReasoning}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            {/* Alternatives */}
            {decision.alternativesConsidered.length > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
                  被拒候选 ({decision.alternativesConsidered.length})
                </p>
                <div className="space-y-1">
                  {decision.alternativesConsidered.map((alt, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs">
                      <span className="text-muted-foreground/60 shrink-0">{alt.role}</span>
                      <span className="text-muted-foreground/60">—</span>
                      <span className="text-muted-foreground/80">{alt.reasonRejected}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
