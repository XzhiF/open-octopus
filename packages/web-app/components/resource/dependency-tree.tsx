"use client"

import { cn } from "@/lib/utils"
import type { DepNode } from "@/lib/resource/api"
import { ChevronRight } from "lucide-react"

interface DependencyTreeProps {
  forward: DepNode[]
  reverse: DepNode[]
}

export function DependencyTree({ forward, reverse }: DependencyTreeProps) {
  if (forward.length === 0 && reverse.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4">
        此资源没有依赖关系
      </p>
    )
  }

  return (
    <div className="space-y-6">
      {forward.length > 0 && (
        <div>
          <h4 className="text-sm font-medium mb-2">依赖 ({forward.length})</h4>
          <ul role="tree" aria-label="正向依赖" className="space-y-1">
            {forward.map((dep) => (
              <li
                key={dep.name}
                role="treeitem"
                aria-expanded={false}
                className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-muted"
              >
                <ChevronRight className="h-3 w-3 text-muted-foreground" />
                <span className="font-medium">{dep.name}</span>
                <span className="text-xs text-muted-foreground">
                  {dep.type} · v{dep.version}
                  {dep.depth !== undefined && ` · depth ${dep.depth}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {reverse.length > 0 && (
        <div>
          <h4 className="text-sm font-medium mb-2">被依赖 ({reverse.length})</h4>
          <ul role="tree" aria-label="反向依赖" className="space-y-1">
            {reverse.map((dep) => (
              <li
                key={dep.name}
                role="treeitem"
                className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-muted"
              >
                <ChevronRight className="h-3 w-3 text-muted-foreground rotate-180" />
                <span className="font-medium">{dep.name}</span>
                <span className="text-xs text-muted-foreground">
                  {dep.type} · v{dep.version}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
