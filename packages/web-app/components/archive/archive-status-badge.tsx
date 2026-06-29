"use client"

import { cn } from "@/lib/utils"
import { Loader2, CheckCircle2, XCircle } from "lucide-react"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

type ArchiveStatus = "none" | "archiving" | "archived" | "archive_failed"

interface ArchiveStatusBadgeProps {
  status?: ArchiveStatus | string
  error?: string | null
  className?: string
}

const statusConfig: Record<ArchiveStatus, { label: string; bgClass: string; textClass: string; Icon?: React.ComponentType<{ className?: string }> }> = {
  none: { label: "—", bgClass: "bg-archive-none/10", textClass: "text-archive-none", Icon: undefined },
  archiving: { label: "归档中...", bgClass: "bg-archive-archiving", textClass: "text-white", Icon: Loader2 },
  archived: { label: "已归档", bgClass: "bg-archive-archived", textClass: "text-white", Icon: CheckCircle2 },
  archive_failed: { label: "归档失败", bgClass: "bg-archive-failed", textClass: "text-white", Icon: XCircle },
}

export function ArchiveStatusBadge({ status = "none", error, className }: ArchiveStatusBadgeProps) {
  const key = (status || "none") as ArchiveStatus
  const config = statusConfig[key] ?? statusConfig.none

  if (key === "none") return <span className="text-muted-foreground text-xs">—</span>

  const { label, bgClass, textClass, Icon } = config

  const badge = (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-sm px-2 py-0.5 text-xs font-medium",
        bgClass,
        textClass,
        className,
      )}
      aria-label={`归档状态: ${label}`}
    >
      {Icon && <Icon className={cn("h-3 w-3", key === "archiving" && "animate-spin")} />}
      {label}
    </span>
  )

  if (key === "archive_failed" && error) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{badge}</TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <p className="text-xs">{error}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return badge
}
