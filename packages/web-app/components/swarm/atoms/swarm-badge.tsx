"use client"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Eye, MessagesSquare, Workflow, Sparkles } from "lucide-react"
import type { SwarmMode } from "@/lib/swarm-types"

export interface SwarmBadgeProps {
  mode: SwarmMode
  size?: "sm" | "md"
  showIcon?: boolean
}

const modeConfig: Record<SwarmMode, { icon: React.ElementType; label: string; colorClass: string }> = {
  review: {
    icon: Eye,
    label: "Review",
    colorClass: "text-swarm-mode-review border-swarm-mode-review/40 bg-swarm-mode-review/10",
  },
  debate: {
    icon: MessagesSquare,
    label: "Debate",
    colorClass: "text-swarm-mode-debate border-swarm-mode-debate/40 bg-swarm-mode-debate/10",
  },
  dispatch: {
    icon: Workflow,
    label: "Dispatch",
    colorClass: "text-swarm-mode-dispatch border-swarm-mode-dispatch/40 bg-swarm-mode-dispatch/10",
  },
  swarm: {
    icon: Sparkles,
    label: "Swarm",
    colorClass: "text-swarm-mode-swarm border-swarm-mode-swarm/40 bg-swarm-mode-swarm/10",
  },
}

export function SwarmBadge({ mode, size = "md", showIcon = true }: SwarmBadgeProps) {
  const config = modeConfig[mode]
  const Icon = config.icon

  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1 font-medium",
        config.colorClass,
        size === "sm" ? "text-[10px] px-1.5 py-0" : "text-xs px-2 py-0.5",
      )}
    >
      {showIcon && <Icon className={cn(size === "sm" ? "h-2.5 w-2.5" : "h-3 w-3")} />}
      {config.label}
    </Badge>
  )
}
