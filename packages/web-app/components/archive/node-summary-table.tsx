"use client"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableCell,
  TableHead,
} from "@/components/ui/table"

interface NodeSummary {
  node_id: string
  type: string
  status: string
  duration_ms: number | null
  exit_code: number | null
}

interface NodeSummaryTableProps {
  nodes: NodeSummary[]
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "-"
  const minutes = Math.floor(ms / 60000)
  if (minutes < 60) return `${minutes}min`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}h ${remainingMinutes}min`
}

function nodeStatusVariant(
  status: string,
): { variant: "default" | "destructive" | "secondary"; className?: string } {
  switch (status) {
    case "completed":
      return { variant: "default", className: "bg-emerald-600 text-white" }
    case "failed":
      return { variant: "destructive" }
    case "skipped":
      return { variant: "secondary" }
    case "running":
      return { variant: "default", className: "bg-blue-600 text-white" }
    default:
      return { variant: "secondary" }
  }
}

export function NodeSummaryTable({ nodes }: NodeSummaryTableProps) {
  if (!nodes || nodes.length === 0) {
    return (
      <p className="text-muted-foreground py-4 text-center text-sm">
        无节点摘要数据
      </p>
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>节点 ID</TableHead>
          <TableHead>类型</TableHead>
          <TableHead>状态</TableHead>
          <TableHead>耗时</TableHead>
          <TableHead>退出码</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {nodes.map((node) => {
          const sv = nodeStatusVariant(node.status)
          return (
            <TableRow key={node.node_id}>
              <TableCell className="font-mono text-xs">
                {node.node_id}
              </TableCell>
              <TableCell>
                <Badge variant="outline">{node.type}</Badge>
              </TableCell>
              <TableCell>
                <Badge variant={sv.variant} className={sv.className}>
                  {node.status}
                </Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatDuration(node.duration_ms)}
              </TableCell>
              <TableCell>
                {node.exit_code !== null ? (
                  <span
                    className={cn(
                      "font-mono text-xs",
                      node.exit_code !== 0 && "text-destructive",
                    )}
                  >
                    {node.exit_code}
                  </span>
                ) : (
                  <span className="text-muted-foreground">-</span>
                )}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
