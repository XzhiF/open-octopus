"use client"

import Link from "next/link"
import { ArrowUpRight } from "lucide-react"

interface ChainRelationProps {
  parentId: string
  chainPosition: number | null
}

export function ChainRelation({ parentId, chainPosition }: ChainRelationProps) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <h3 className="text-sm font-medium mb-3">链条关系</h3>
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">父执行:</span>
        <Link
          href={`/archive/executions/${parentId}`}
          className="inline-flex items-center gap-1 text-primary hover:underline font-mono text-xs"
        >
          #{parentId.slice(0, 8)} <ArrowUpRight className="h-3 w-3" />
        </Link>
        {chainPosition !== null && (
          <span className="text-xs text-muted-foreground ml-2">
            (链条位置: {chainPosition})
          </span>
        )}
      </div>
    </div>
  )
}
