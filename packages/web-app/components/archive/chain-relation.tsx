"use client"

import Link from "next/link"
import { GitFork } from "lucide-react"
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

interface ChainRelationProps {
  parentExecutionId: string | null
  chainPosition: number | null
}

export function ChainRelation({
  parentExecutionId,
  chainPosition,
}: ChainRelationProps) {
  if (!parentExecutionId) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <GitFork className="h-4 w-4" />
          链条关系
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-muted-foreground">父执行:</span>
          <Link
            href={`/archive/${parentExecutionId}`}
            className="text-primary font-mono text-xs hover:underline"
          >
            {parentExecutionId.slice(0, 12)}...
          </Link>
          {chainPosition !== null && chainPosition !== undefined && (
            <Badge variant="outline">链位置 #{chainPosition}</Badge>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
