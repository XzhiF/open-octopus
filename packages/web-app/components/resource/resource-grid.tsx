"use client"

import Link from "next/link"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Package, Bot, Workflow, CheckCircle2, Circle } from "lucide-react"
import type { RegistryEntry, ResourceType } from "@/lib/resource/api"

const typeIcons: Record<ResourceType, typeof Package> = {
  skill: Package,
  agent: Bot,
  workflow: Workflow,
}

const typeColors: Record<ResourceType, string> = {
  skill: "text-blue-500",
  agent: "text-purple-500",
  workflow: "text-orange-500",
}

interface ResourceGridProps {
  resources: RegistryEntry[]
}

export function ResourceGrid({ resources }: ResourceGridProps) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {resources.map((r) => {
        const Icon = typeIcons[r.type]
        return (
          <Link
            key={`${r.type}-${r.name}`}
            href={`/resources/${r.type}/${r.name}`}
            role="button"
            aria-label={`查看 ${r.name} 详情`}
          >
            <Card className="transition-colors hover:border-primary/50 hover:shadow-md h-full">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Icon className={cn("h-5 w-5", typeColors[r.type])} />
                    <CardTitle className="text-base leading-tight">{r.name}</CardTitle>
                  </div>
                  {r.installed ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />
                  ) : (
                    <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                </div>
                <CardDescription className="line-clamp-2">
                  {r.description ?? `${r.type} · v${r.version}`}
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="text-xs">
                    {r.type}
                  </Badge>
                  <span className="text-xs text-muted-foreground">v{r.version}</span>
                  {r.dependencies.length > 0 && (
                    <span className="text-xs text-muted-foreground">
                      · {r.dependencies.length} dep{r.dependencies.length > 1 ? "s" : ""}
                    </span>
                  )}
                </div>
              </CardContent>
            </Card>
          </Link>
        )
      })}
    </div>
  )
}

export function ResourceGridSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <Card key={i}>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Skeleton className="h-5 w-5 rounded" />
              <Skeleton className="h-5 w-32" />
            </div>
            <Skeleton className="h-4 w-full" />
          </CardHeader>
          <CardContent className="pt-0">
            <Skeleton className="h-5 w-20" />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
