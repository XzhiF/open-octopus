"use client"

import Link from "next/link"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { BrainCircuit, Cog, Workflow, Trash2, ExternalLink, CheckCircle2, ScrollText, Terminal, Copy, Zap, ZapOff } from "lucide-react"
import type { ResourceEntry, ResourceType } from "@/lib/resource/types"

const typeIcon: Record<ResourceType, React.ComponentType<{ className?: string }>> = {
  skill: BrainCircuit,
  agent: Cog,
  workflow: Workflow,
  rule: ScrollText,
  command: Terminal,
  clone: Copy,
}

const typeBadge = cva("text-xs font-medium", {
  variants: {
    type: {
      skill: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
      agent: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
      workflow: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
      rule: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
      command: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200",
      clone: "bg-rose-100 text-rose-800 dark:bg-rose-900 dark:text-rose-200",
    },
  },
})

interface ResourceCardProps {
  entry: ResourceEntry
  onUninstall?: (name: string, type: ResourceType) => void
  onActivate?: (name: string, type: ResourceType) => void
  onDeactivate?: (name: string, type: ResourceType) => void
}

const ACTIVATABLE_TYPES = new Set(["rule", "command", "clone"])

export function ResourceCard({ entry, onUninstall, onActivate, onDeactivate }: ResourceCardProps) {
  const Icon = typeIcon[entry.type as ResourceType] ?? BrainCircuit
  const isActivated = (entry as any).activated === true
  const canActivate = ACTIVATABLE_TYPES.has(entry.type) && !isActivated
  const canDeactivate = isActivated

  return (
    <div data-testid={`resource-card-${entry.name}`} className="group relative rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary/50">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
            <Icon className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <Link
              href={`/resources/${entry.type}/${entry.name}`}
              className="block font-semibold text-foreground hover:text-primary truncate"
              title={entry.name}
            >
              {entry.name}
            </Link>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline" className={cn("shrink-0", typeBadge({ type: entry.type as ResourceType }))}>
                {entry.type}
              </Badge>
              {isActivated && (
                <Badge variant="outline" className="shrink-0 bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 border-green-300">
                  <CheckCircle2 className="mr-1 h-3 w-3" />
                  Activated
                </Badge>
              )}
              {(entry as any).group && (
                <Badge variant="outline" className="shrink-0 text-[10px] px-1.5">{(entry as any).group}</Badge>
              )}
              <span className="break-all text-[11px] leading-relaxed" title={`${entry.source}: ${entry.ref}`}>{entry.source}: {entry.ref}</span>
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
          {canActivate && onActivate && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onActivate(entry.name, entry.type as ResourceType)}
              title="激活"
            >
              <Zap className="h-4 w-4 text-green-600" />
              <span className="sr-only">激活</span>
            </Button>
          )}
          {canDeactivate && onDeactivate && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onDeactivate(entry.name, entry.type as ResourceType)}
              title="停用"
            >
              <ZapOff className="h-4 w-4 text-amber-600" />
              <span className="sr-only">停用</span>
            </Button>
          )}
          {entry.installed && onUninstall && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onUninstall(entry.name, entry.type as ResourceType)}
              disabled={isActivated}
              title={isActivated ? "请先停用再卸载" : "卸载"}
            >
              <Trash2 className={cn("h-4 w-4", isActivated ? "text-muted-foreground" : "text-destructive")} />
              <span className="sr-only">卸载</span>
            </Button>
          )}
        </div>
      </div>

      {entry.installed && (
        <div className="mt-3 flex items-start gap-3 text-xs">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center"
            title={entry.status === "installed" ? "已安装" : "未验证"}
          >
            <CheckCircle2 className={cn(
              "h-5 w-5",
              entry.status === "installed" ? "text-green-600 dark:text-green-400" : "text-amber-500"
            )} />
          </div>
          {entry.installPath && (
            <span className="break-all text-[11px] leading-relaxed text-muted-foreground" title={entry.installPath}>
              {entry.installPath}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
