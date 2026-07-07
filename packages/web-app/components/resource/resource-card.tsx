"use client"

import Link from "next/link"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { BrainCircuit, Cog, Workflow, Trash2, ExternalLink, CheckCircle2 } from "lucide-react"
import type { ResourceEntry, ResourceType } from "@/lib/resource/types"

const typeIcon: Record<ResourceType, React.ComponentType<{ className?: string }>> = {
  skill: BrainCircuit,
  agent: Cog,
  workflow: Workflow,
}

const typeBadge = cva("text-xs font-medium", {
  variants: {
    type: {
      skill: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
      agent: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
      workflow: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
    },
  },
})

interface ResourceCardProps {
  entry: ResourceEntry
  onUninstall?: (name: string, type: ResourceType) => void
}

export function ResourceCard({ entry, onUninstall }: ResourceCardProps) {
  const Icon = typeIcon[entry.type as ResourceType] ?? BrainCircuit

  return (
    <div data-testid={`resource-card-${entry.name}`} className="group relative rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary/50">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
            <Icon className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Link
                href={`/resources/${entry.type}/${entry.name}`}
                className="font-semibold text-foreground hover:text-primary truncate"
              >
                {entry.name}
              </Link>
              <Badge variant="outline" className={cn("shrink-0", typeBadge({ type: entry.type as ResourceType }))}>
                {entry.type}
              </Badge>
            </div>
            <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
              {(entry as any).group && (
                <Badge variant="outline" className="shrink-0 text-[10px] px-1.5">{(entry as any).group}</Badge>
              )}
              <span className="truncate">{entry.source}: {entry.ref}</span>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <Button variant="ghost" size="icon" asChild>
            <Link href={`/resources/${entry.type}/${entry.name}`}>
              <ExternalLink className="h-4 w-4" />
              <span className="sr-only">详情</span>
            </Link>
          </Button>
          {entry.installed && onUninstall && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onUninstall(entry.name, entry.type as ResourceType)}
            >
              <Trash2 className="h-4 w-4 text-destructive" />
              <span className="sr-only">卸载</span>
            </Button>
          )}
        </div>
      </div>

      {entry.installed && (
        <div className="mt-3 flex items-center gap-1.5 text-xs text-green-700 dark:text-green-400">
          <CheckCircle2 className="h-3.5 w-3.5" />
          {entry.status === "installed" ? "已安装" : "已安装 (未验证)"}
          {entry.installPath && (
            <span className="text-muted-foreground ml-1 truncate">→ {entry.installPath}</span>
          )}
        </div>
      )}
    </div>
  )
}
