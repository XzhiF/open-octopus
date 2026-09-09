"use client"

import { cn } from "@/lib/utils"
import { formatCost, formatDuration, formatPercent } from "@/lib/format"
import { Badge } from "@/components/ui/badge"

const GRADE_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  A: { bg: "bg-pop-green/10", text: "text-pop-green", border: "border-pop-green/40" },
  B: { bg: "bg-pop-cyan/10", text: "text-pop-cyan", border: "border-pop-cyan/40" },
  C: { bg: "bg-pop-amber/10", text: "text-pop-amber", border: "border-pop-amber/40" },
  D: { bg: "bg-pop-yellow/10", text: "text-pop-ink", border: "border-pop-yellow/40" },
  F: { bg: "bg-pop-red/10", text: "text-pop-red", border: "border-pop-red/40" },
}

interface WorkflowHealthCardProps {
  workflowRef: string
  healthScore: number
  grade: string
  successRate: number
  avgDurationMs: number
  /** C3 三态：null = 未定价 */
  totalCost: number | null
}

export function WorkflowHealthCard({ workflowRef, healthScore, grade, successRate, avgDurationMs, totalCost }: WorkflowHealthCardProps) {
  const colors = GRADE_COLORS[grade] ?? GRADE_COLORS.C

  return (
    <div className={cn("rounded-lg border p-4 transition-colors hover:bg-accent/50", colors.border)}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium truncate">{workflowRef}</span>
        <Badge variant="outline" className={cn("text-sm font-bold", colors.text)}>
          {grade}
        </Badge>
      </div>
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span className="tabular-nums">健康分: {healthScore}</span>
        <span className="tabular-nums">成功率: {formatPercent(successRate)}</span>
        <span className="tabular-nums">{formatDuration(avgDurationMs)}</span>
        <span className="tabular-nums">{formatCost(totalCost)}</span>
      </div>
    </div>
  )
}
