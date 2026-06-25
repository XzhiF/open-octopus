"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import { AlertTriangle, XCircle, Info, X, ChevronDown, ChevronUp } from "lucide-react"

export interface AlertBannerProps {
  type: "warning" | "error" | "info"
  message: string
  detail?: string
  dismissible?: boolean
}

const typeConfig = {
  warning: {
    icon: AlertTriangle,
    borderColor: "border-l-swarm-budget-warning",
    bgColor: "bg-swarm-budget-warning/5",
    iconColor: "text-swarm-budget-warning",
  },
  error: {
    icon: XCircle,
    borderColor: "border-l-destructive",
    bgColor: "bg-destructive/5",
    iconColor: "text-destructive",
  },
  info: {
    icon: Info,
    borderColor: "border-l-swarm-primary",
    bgColor: "bg-swarm-primary/5",
    iconColor: "text-swarm-primary",
  },
}

export function AlertBanner({ type, message, detail, dismissible = false }: AlertBannerProps) {
  const [dismissed, setDismissed] = useState(false)
  const [expanded, setExpanded] = useState(false)

  if (dismissed) return null

  const config = typeConfig[type]
  const Icon = config.icon

  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-r-md border-l-4 px-3 py-2 text-sm",
        config.borderColor,
        config.bgColor,
      )}
      role="alert"
    >
      <Icon className={cn("h-4 w-4 shrink-0 mt-0.5", config.iconColor)} />
      <div className="flex-1 min-w-0">
        <p className="font-medium">{message}</p>
        {detail && (
          <>
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mt-0.5"
            >
              {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              {expanded ? "收起" : "详情"}
            </button>
            {expanded && (
              <p className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap">{detail}</p>
            )}
          </>
        )}
      </div>
      {dismissible && (
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}
