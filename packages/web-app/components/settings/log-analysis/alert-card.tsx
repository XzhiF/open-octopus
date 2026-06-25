"use client"

import { AlertTriangle, Info, AlertOctagon } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { Alert } from "@/lib/analytics-types"

interface AlertCardProps {
  alert: Alert
  onDrillDown: (alert: Alert) => void
}

const severityConfig = {
  critical: {
    border: "border-l-destructive",
    bg: "bg-destructive/5",
    icon: AlertOctagon,
    iconColor: "text-destructive",
    badge: "destructive" as const,
  },
  warning: {
    border: "border-l-amber-500",
    bg: "bg-amber-500/5",
    icon: AlertTriangle,
    iconColor: "text-amber-500",
    badge: "secondary" as const,
  },
  info: {
    border: "border-l-blue-500",
    bg: "bg-blue-500/5",
    icon: Info,
    iconColor: "text-blue-500",
    badge: "outline" as const,
  },
}

export function AlertCard({ alert, onDrillDown }: AlertCardProps) {
  const config = severityConfig[alert.severity]
  const Icon = config.icon

  return (
    <Card className={cn("border-l-4 p-4", config.border, config.bg)}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <Icon className={cn("h-5 w-5 mt-0.5 shrink-0", config.iconColor)} />
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Badge variant={config.badge} className="text-xs" aria-label={`严重级别: ${alert.severity}`}>{alert.severity}</Badge>
              <span className="text-sm text-muted-foreground">{alert.workflow_ref}</span>
            </div>
            <p className="font-medium text-sm leading-tight">{alert.title}</p>
            <p className="text-sm text-muted-foreground mt-1">{alert.description}</p>
          </div>
        </div>
        <Button variant="ghost" size="sm" className="shrink-0" onClick={() => onDrillDown(alert)}>
          查看详情
        </Button>
      </div>
    </Card>
  )
}
