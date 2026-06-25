"use client"

import { cn } from "@/lib/utils"
import type { LucideIcon } from "lucide-react"

export interface MetricCardProps {
  label: string
  value: string | number
  icon: LucideIcon
  warning?: boolean
  maxValue?: number
}

export function MetricCard({ label, value, icon: Icon, warning = false, maxValue }: MetricCardProps) {
  const numericValue = typeof value === "number" ? value : null
  const progress = numericValue != null && maxValue ? Math.min((numericValue / maxValue) * 100, 100) : null

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border px-3 py-2 bg-card",
        warning ? "border-swarm-budget-warning bg-swarm-budget-warning/5" : "border-border",
      )}
    >
      <Icon className={cn("h-4 w-4 shrink-0", warning ? "text-swarm-budget-warning" : "text-muted-foreground")} />
      <div className="flex flex-col min-w-0">
        <span className="text-[10px] text-muted-foreground uppercase tracking-wider leading-none">{label}</span>
        <span className={cn("text-sm font-semibold leading-tight", warning && "text-swarm-budget-warning")}>
          {value}
        </span>
      </div>
      {progress != null && (
        <div className="ml-auto h-1 w-10 rounded-full bg-muted overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-300",
              progress >= 90 ? "bg-swarm-budget-warning" : "bg-swarm-primary",
            )}
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
    </div>
  )
}
