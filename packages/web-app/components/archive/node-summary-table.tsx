"use client"

import { formatDuration } from "@/lib/cost-format"
import { CheckCircle2, XCircle, MinusCircle } from "lucide-react"
import { cn } from "@/lib/utils"

interface NodeSummary {
  nodeId: string
  type: string
  status: string
  duration_ms: number | null
}

interface NodeSummaryTableProps {
  nodes: NodeSummary[]
}

const statusIcon: Record<string, React.ComponentType<{ className?: string }>> =
  {
    completed: CheckCircle2,
    failed: XCircle,
    cancelled: MinusCircle,
    skipped: MinusCircle,
  }

export function NodeSummaryTable({ nodes }: NodeSummaryTableProps) {
  if (!nodes || nodes.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-4">
        <h3 className="text-sm font-medium mb-3">节点摘要</h3>
        <p className="text-sm text-muted-foreground">无节点摘要数据</p>
      </div>
    )
  }

  return (
    <div className="rounded-lg border bg-card">
      <div className="p-4 border-b">
        <h3 className="text-sm font-medium">节点摘要</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="text-left font-medium p-3">节点</th>
              <th className="text-left font-medium p-3">类型</th>
              <th className="text-left font-medium p-3">状态</th>
              <th className="text-left font-medium p-3">耗时</th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((node) => {
              const Icon = statusIcon[node.status] ?? MinusCircle
              return (
                <tr key={node.nodeId} className="border-b last:border-b-0">
                  <td className="p-3 font-mono text-xs">{node.nodeId}</td>
                  <td className="p-3 text-muted-foreground">{node.type}</td>
                  <td className="p-3">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1",
                        node.status === "completed"
                          ? "text-green-600"
                          : node.status === "failed"
                            ? "text-destructive"
                            : "text-muted-foreground",
                      )}
                    >
                      <Icon className="h-4 w-4" />
                      {node.status}
                    </span>
                  </td>
                  <td className="p-3 text-muted-foreground">
                    {formatDuration(node.duration_ms)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
