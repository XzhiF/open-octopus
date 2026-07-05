import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Check, ArrowUpCircle, AlertTriangle } from "lucide-react"

export type ResourceStatus = "installed" | "outdated" | "missing"

const statusConfig: Record<ResourceStatus, {
  label: string
  colorClass: string
  icon: typeof Check
}> = {
  installed: {
    label: "已安装",
    colorClass: "text-resource-installed bg-resource-installed/10",
    icon: Check,
  },
  outdated: {
    label: "有更新",
    colorClass: "text-resource-outdated bg-resource-outdated/10",
    icon: ArrowUpCircle,
  },
  missing: {
    label: "缺失",
    colorClass: "text-resource-missing bg-resource-missing/10",
    icon: AlertTriangle,
  },
}

interface ResourceStatusBadgeProps {
  status: ResourceStatus
  className?: string
}

export function ResourceStatusBadge({ status, className }: ResourceStatusBadgeProps) {
  const config = statusConfig[status]
  if (!config) return null

  const Icon = config.icon

  return (
    <Badge
      variant="secondary"
      className={cn("gap-1 font-medium", config.colorClass, className)}
    >
      <Icon className="size-3" />
      {config.label}
    </Badge>
  )
}
