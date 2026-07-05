"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { ResourceTypeBadge } from "@/components/resources/resource-type-badge"
import { ChevronRight } from "lucide-react"
import Link from "next/link"
import type { DepNode, ResourceType } from "@/lib/types"

interface DepsTreeListProps {
  dependencies?: DepNode[]
  dependents?: DepNode[]
  maxDepth?: number
}

export function DepsTreeList({ dependencies = [], dependents = [], maxDepth = 3 }: DepsTreeListProps) {
  return (
    <div className="space-y-4" role="img" aria-label="资源依赖关系">
      <div>
        <h4 className="text-sm font-medium mb-2">依赖 ({dependencies.length})</h4>
        {dependencies.length === 0 ? (
          <p className="text-sm text-muted-foreground">无依赖</p>
        ) : (
          <ul className="space-y-1">
            {dependencies.map(dep => (
              <DepsTreeItem key={dep.name} node={dep} depth={0} maxDepth={maxDepth} />
            ))}
          </ul>
        )}
      </div>
      <div>
        <h4 className="text-sm font-medium mb-2">被依赖 ({dependents.length})</h4>
        {dependents.length === 0 ? (
          <p className="text-sm text-muted-foreground">无被依赖</p>
        ) : (
          <ul className="space-y-1">
            {dependents.map(dep => (
              <DepsTreeItem key={dep.name} node={dep} depth={0} maxDepth={maxDepth} />
            ))}
          </ul>
        )}
      </div>
      <p className="sr-only">
        该资源有 {dependencies.length} 个依赖和 {dependents.length} 个被依赖
      </p>
    </div>
  )
}

function DepsTreeItem({ node, depth, maxDepth }: { node: DepNode; depth: number; maxDepth: number }) {
  const [expanded, setExpanded] = useState(depth < 1)
  const hasChildren = node.children && node.children.length > 0
  const truncated = depth >= maxDepth && !!hasChildren

  return (
    <li className="text-sm" style={{ paddingLeft: `${depth * 16 + 8}px` }}>
      <div className="flex items-center gap-2 py-1">
        {hasChildren && depth < maxDepth ? (
          <button
            onClick={() => setExpanded(!expanded)}
            className="size-4 flex items-center justify-center shrink-0"
            aria-expanded={expanded}
          >
            <ChevronRight className={cn("size-3 transition-transform", expanded && "rotate-90")} />
          </button>
        ) : (
          <span className="size-4 shrink-0" />
        )}
        <ResourceTypeBadge type={node.type} showIcon={false} className="text-xs px-1.5" />
        <Link
          href={`/resources/${node.type}/${node.name}`}
          className="hover:underline font-medium"
        >
          {node.name}
        </Link>
        <span className="text-xs text-muted-foreground font-mono">v{node.version}</span>
        {truncated && (
          <Badge variant="secondary" className="text-xs">+{node.children!.length} more</Badge>
        )}
      </div>
      {expanded && hasChildren && depth < maxDepth && (
        <ul className="space-y-0.5">
          {node.children!.map(child => (
            <DepsTreeItem key={child.name} node={child} depth={depth + 1} maxDepth={maxDepth} />
          ))}
        </ul>
      )}
    </li>
  )
}
