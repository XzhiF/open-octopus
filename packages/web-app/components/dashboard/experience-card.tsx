"use client"

import { Bug, Wrench, Coins, AlertTriangle } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { ExperienceType, ExperienceStatus } from "@octopus/shared"

const typeConfig: Record<ExperienceType, { label: string; icon: React.ElementType; variant: "default" | "secondary" | "destructive" | "outline"; iconColor: string }> = {
  bug: { label: "Bug", icon: Bug, variant: "destructive", iconColor: "text-destructive" },
  pattern: { label: "模式", icon: Wrench, variant: "default", iconColor: "text-emerald-500" },
  cost: { label: "成本", icon: Coins, variant: "secondary", iconColor: "text-blue-500" },
  failure: { label: "故障", icon: AlertTriangle, variant: "outline", iconColor: "text-amber-500" },
}

const statusLabels: Record<ExperienceStatus, string> = {
  active: "活跃",
  resolved: "已解决",
  obsolete: "过时",
  superseded: "已替代",
}

interface ExperienceCardProps {
  type: ExperienceType
  title: string
  content: string
  status: ExperienceStatus
  project?: string | null
  className?: string
}

export function ExperienceCard({ type, title, content, status, project, className }: ExperienceCardProps) {
  const cfg = typeConfig[type] ?? { label: type, icon: Bug, variant: "outline" as const, iconColor: "text-muted-foreground" }
  const Icon = cfg.icon

  return (
    <div className={cn("rounded-lg border p-3 space-y-2", className)}>
      <div className="flex items-start gap-2">
        <Icon className={cn("h-4 w-4 shrink-0 mt-0.5", cfg.iconColor)} aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium leading-snug truncate">{title}</p>
            <div className="flex shrink-0 items-center gap-1">
              <Badge variant={cfg.variant} className="text-[10px]">{cfg.label}</Badge>
              <Badge variant="outline" className="text-[10px]">{statusLabels[status] ?? status}</Badge>
            </div>
          </div>
          <p className="text-xs text-muted-foreground line-clamp-3">{content}</p>
          {project && (
            <Badge variant="outline" className="text-[10px]">{project}</Badge>
          )}
        </div>
      </div>
    </div>
  )
}
