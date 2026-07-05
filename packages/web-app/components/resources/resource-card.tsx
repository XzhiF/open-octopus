"use client"

import Link from "next/link"
import { cn } from "@/lib/utils"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ResourceTypeBadge } from "@/components/resources/resource-type-badge"
import type { Resource } from "@/lib/types"
import { Info, Trash2 } from "lucide-react"

interface ResourceCardProps {
  resource: Resource
  onUninstall?: (name: string) => void
  className?: string
  highlight?: boolean
}

export function ResourceCard({ resource, onUninstall, className, highlight }: ResourceCardProps) {
  const { manifest, installedAt } = resource
  const sourceRef = `${manifest.source.protocol}:${manifest.source.location}`
  const isBuiltin = manifest.source.protocol === "builtin"

  return (
    <Card
      className={cn(
        "group relative overflow-hidden transition-shadow hover:shadow-md",
        highlight && "new-resource-highlight",
        className
      )}
      role="article"
      aria-label={`${manifest.name} (${manifest.type})`}
    >
      <CardContent className="p-5 space-y-3">
        {/* Top row: type badge + version */}
        <div className="flex items-center justify-between">
          <ResourceTypeBadge type={manifest.type} />
          <span className="text-xs font-mono text-muted-foreground">
            v{manifest.version}
          </span>
        </div>

        {/* Title */}
        <Link
          href={`/resources/${manifest.type}/${manifest.name}`}
          className="block"
        >
          <h3 className="text-base font-semibold hover:underline">
            {manifest.name}
          </h3>
        </Link>

        {/* Description */}
        {manifest.description && (
          <p className="text-sm text-muted-foreground line-clamp-2">
            {manifest.description}
          </p>
        )}

        {/* Source reference */}
        <p className="text-xs font-mono text-muted-foreground">
          {sourceRef}
        </p>

        {/* Tags */}
        {manifest.tags && manifest.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {manifest.tags.slice(0, 3).map(tag => (
              <span
                key={tag}
                className="text-xs px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Action bar */}
        <div className="flex items-center gap-2 pt-2 border-t border-border">
          <Button variant="ghost" size="sm" asChild className="gap-1.5">
            <Link href={`/resources/${manifest.type}/${manifest.name}`}>
              <Info className="size-3.5" />
              详情
            </Link>
          </Button>

          <div className="flex-1" />

          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-destructive hover:text-destructive"
            disabled={isBuiltin}
            title={isBuiltin ? "内置资源不可卸载" : `卸载 ${manifest.name}`}
            onClick={() => onUninstall?.(manifest.name)}
          >
            <Trash2 className="size-3.5" />
            卸载
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
