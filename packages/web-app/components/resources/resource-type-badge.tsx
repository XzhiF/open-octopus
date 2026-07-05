import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Wrench, Bot, GitBranch, FolderGit2 } from "lucide-react"
import type { ResourceType } from "@/lib/types"

const typeConfig: Record<ResourceType, {
  label: string
  colorClass: string
  bgClass: string
  icon: typeof Wrench
}> = {
  skill: {
    label: "Skill",
    colorClass: "text-resource-skill",
    bgClass: "bg-resource-skill/10",
    icon: Wrench,
  },
  agent: {
    label: "Agent",
    colorClass: "text-resource-agent",
    bgClass: "bg-resource-agent/10",
    icon: Bot,
  },
  workflow: {
    label: "Workflow",
    colorClass: "text-resource-workflow",
    bgClass: "bg-resource-workflow/10",
    icon: GitBranch,
  },
  source: {
    label: "Source",
    colorClass: "text-resource-source",
    bgClass: "bg-resource-source/10",
    icon: FolderGit2,
  },
}

interface ResourceTypeBadgeProps {
  type: ResourceType
  className?: string
  showIcon?: boolean
}

export function ResourceTypeBadge({ type, className, showIcon = true }: ResourceTypeBadgeProps) {
  const config = typeConfig[type]
  if (!config) return null

  const Icon = config.icon

  return (
    <Badge
      variant="secondary"
      className={cn(
        "gap-1 font-medium",
        config.bgClass,
        config.colorClass,
        "hover:" + config.bgClass,
        className
      )}
    >
      {showIcon && <Icon className="size-3" />}
      {config.label}
    </Badge>
  )
}

export function getResourceTypeLabel(type: ResourceType): string {
  return typeConfig[type]?.label ?? type
}
