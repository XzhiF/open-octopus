"use client"

import { memo, useState, useMemo, useCallback, useRef } from "react"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { formatDuration } from "@/lib/format"
import { IterationTimeline } from "./iteration-timeline"
import type { LoopIterationSummary, IterationDetail } from "@/lib/types"
import {
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
} from "lucide-react"

interface LoopOverviewProps {
  loopNodeId: string
  summary: LoopIterationSummary
  compact?: boolean
}

const iterStatusIcon: Record<IterationDetail["status"], { icon: React.ElementType; className: string }> = {
  completed: { icon: CheckCircle2, className: "text-emerald-500" },
  failed: { icon: XCircle, className: "text-red-400" },
  running: { icon: Loader2, className: "text-amber-400 animate-spin" },
  pending: { icon: Clock, className: "text-muted-foreground" },
}

// ponytail: 200 DOM node budget for 100+ iterations — collapse all by default
const LARGE_THRESHOLD = 100
const AUTO_COLLAPSE_THRESHOLD = 3

export const LoopOverview = memo(function LoopOverview({
  loopNodeId,
  summary,
  compact = false,
}: LoopOverviewProps) {
  const { iterations, completed, failed, total, mode } = summary
  const isLarge = iterations.length >= LARGE_THRESHOLD
  const autoCollapse = iterations.length > AUTO_COLLAPSE_THRESHOLD

  // ponytail: default expand only latest when >3 iterations
  const [expandedIters, setExpandedIters] = useState<Set<number>>(() => {
    if (iterations.length === 0) return new Set()
    if (!autoCollapse) return new Set(iterations.map((i) => i.iteration))
    // Expand only the latest
    return new Set([iterations[iterations.length - 1].iteration])
  })
  const [showAll, setShowAll] = useState(!isLarge)
  const failedIters = useMemo(
    () => iterations.filter((i) => i.status === "failed"),
    [iterations],
  )
  const [highlightedIter, setHighlightedIter] = useState<number | null>(null)
  const iterRefs = useRef<Map<number, HTMLDivElement>>(new Map())

  const toggleIter = useCallback((iterNum: number) => {
    setExpandedIters((prev) => {
      const next = new Set(prev)
      if (next.has(iterNum)) next.delete(iterNum)
      else next.add(iterNum)
      return next
    })
  }, [])

  const expandAll = useCallback(() => {
    setExpandedIters(new Set(iterations.map((i) => i.iteration)))
    setShowAll(true)
  }, [iterations])

  const jumpToIteration = useCallback((iterNum: number) => {
    setHighlightedIter(iterNum)
    setExpandedIters((prev) => new Set(prev).add(iterNum))
    setShowAll(true)
    // Scroll after render
    requestAnimationFrame(() => {
      const el = iterRefs.current.get(iterNum)
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" })
        // Clear highlight after animation
        setTimeout(() => setHighlightedIter(null), 2000)
      }
    })
  }, [])

  // Progress percentage
  const denominator = mode === "fixed" && total ? total : iterations.length || 1
  const progressPct = Math.round((completed / denominator) * 100)

  // Visible iterations (for large sets, limit unless showAll)
  const visibleIterations = useMemo(() => {
    if (showAll || !isLarge) return iterations
    // Show last 20 for large sets
    return iterations.slice(-20)
  }, [iterations, showAll, isLarge])

  return (
    <div className={cn("space-y-2", compact ? "text-xs" : "")} data-loop-node={loopNodeId}>
      {/* Progress header */}
      <div className="space-y-1">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">
            {mode === "dynamic"
              ? `已完成 ${completed} 次迭代`
              : `${completed}/${total ?? "?"} 迭代完成`}
          </span>
          <span className="tabular-nums text-muted-foreground/60">{progressPct}%</span>
        </div>
        {mode === "fixed" && (
          <Progress value={progressPct} className="h-1.5" />
        )}
      </div>

      {/* Failed iteration jump-to (TC-016) */}
      {failed > 0 && (
        <div className="flex items-center gap-2 text-xs">
          <Badge variant="outline" className="text-red-400 border-red-400/30 shrink-0">
            <AlertTriangle className="h-3 w-3 mr-0.5" />
            {failed} 个失败迭代
          </Badge>
          {failedIters.length === 1 ? (
            <button
              onClick={() => jumpToIteration(failedIters[0].iteration)}
              className="text-red-400 hover:text-red-300 underline underline-offset-2 transition-colors"
            >
              跳转到失败迭代
            </button>
          ) : (
            <div className="flex items-center gap-1 flex-wrap">
              <span className="text-muted-foreground">跳转:</span>
              {failedIters.map((fi) => (
                <button
                  key={fi.iteration}
                  onClick={() => jumpToIteration(fi.iteration)}
                  className="text-red-400 hover:text-red-300 underline underline-offset-2 transition-colors"
                >
                  #{fi.iteration}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Iteration list */}
      <div className="space-y-0.5">
        {!showAll && isLarge && (
          <div className="text-xs text-muted-foreground py-1">
            显示最近 {visibleIterations.length} / {iterations.length} 次迭代
          </div>
        )}

        {visibleIterations.map((iter) => {
          const cfg = iterStatusIcon[iter.status]
          const Icon = cfg.icon
          const isExpanded = expandedIters.has(iter.iteration)
          const isHighlighted = highlightedIter === iter.iteration
          const hasNodes = iter.nodes.length > 0

          return (
            <div
              key={iter.iteration}
              data-iteration={iter.iteration}
              ref={(el) => {
                if (el) iterRefs.current.set(iter.iteration, el)
                else iterRefs.current.delete(iter.iteration)
              }}
              className={cn(
                "rounded transition-colors",
                isHighlighted && "ring-1 ring-red-400/50 bg-red-400/5",
              )}
            >
              <Collapsible open={isExpanded} onOpenChange={() => toggleIter(iter.iteration)}>
                <CollapsibleTrigger asChild>
                  <button
                    className={cn(
                      "flex items-center gap-1.5 w-full px-2 py-1 text-xs rounded",
                      "hover:bg-muted/40 transition-colors cursor-pointer",
                    )}
                  >
                    {hasNodes ? (
                      isExpanded
                        ? <ChevronDown className="h-3 w-3 shrink-0" />
                        : <ChevronRight className="h-3 w-3 shrink-0" />
                    ) : (
                      <span className="w-3 shrink-0" />
                    )}
                    <span className="text-muted-foreground">iter-{iter.iteration}</span>
                    <Icon className={cn("h-3.5 w-3.5 shrink-0", cfg.className)} />
                    {iter.durationMs != null && (
                      <span className="text-muted-foreground/60 tabular-nums ml-auto shrink-0">
                        {formatDuration(iter.durationMs / 1000)}
                      </span>
                    )}
                    {iter.status === "running" && (
                      <span className="text-amber-400 ml-auto shrink-0">running...</span>
                    )}
                    {iter.status === "pending" && (
                      <span className="text-muted-foreground ml-auto shrink-0">pending</span>
                    )}
                    {iter.error && (
                      <span className="text-red-400 truncate max-w-[100px] shrink-0" title={iter.error}>
                        {iter.error}
                      </span>
                    )}
                  </button>
                </CollapsibleTrigger>
                {hasNodes && (
                  <CollapsibleContent>
                    <div className="ml-5 border-l border-border/30 pl-2">
                      <IterationTimeline nodes={iter.nodes} />
                    </div>
                  </CollapsibleContent>
                )}
              </Collapsible>
            </div>
          )
        })}

        {/* Expand all button (TC-021) */}
        {(isLarge && !showAll) || (autoCollapse && expandedIters.size < iterations.length) ? (
          <button
            onClick={expandAll}
            className="w-full text-xs text-muted-foreground hover:text-foreground py-1 transition-colors"
          >
            展开全部 ({iterations.length} 次迭代)
          </button>
        ) : null}
      </div>
    </div>
  )
})
