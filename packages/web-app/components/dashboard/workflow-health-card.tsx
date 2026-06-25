"use client"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"

const GRADE_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  A: { bg: "bg-emerald-500/10", text: "text-emerald-600", border: "border-emerald-200" },
  B: { bg: "bg-blue-500/10", text: "text-blue-600", border: "border-blue-200" },
  C: { bg: "bg-amber-500/10", text: "text-amber-600", border: "border-amber-200" },
  D: { bg: "bg-orange-500/10", text: "text-orange-600", border: "border-orange-200" },
  F: { bg: "bg-red-500/10", text: "text-red-600", border: "border-red-200" },
}

interface WorkflowHealthCardProps {
  workflowRef: string
  healthScore: number
  grade: string
  successRate: number
  avgDurationMs: number
  totalCost: number
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
        <span className="tabular-nums">成功率: {(successRate * 100).toFixed(0)}%</span>
        <span className="tabular-nums">{(avgDurationMs / 1000).toFixed(1)}s</span>
        <span className="tabular-nums">${totalCost.toFixed(2)}</span>
      </div>
    </div>
  )
}
