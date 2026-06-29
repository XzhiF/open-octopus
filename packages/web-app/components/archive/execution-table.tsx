"use client"

import { useRouter } from "next/navigation"
import { formatCostUSD, formatDuration } from "@/lib/cost-format"
import type { ArchiveExecution } from "@/lib/archive-api"
import { cn } from "@/lib/utils"
import { CheckCircle2, XCircle, MinusCircle, RefreshCw } from "lucide-react"
import { format } from "date-fns"

interface ExecutionTableProps {
  executions: ArchiveExecution[]
  loading: boolean
  error: Error | null
  onRetry: () => void
}

const statusIcons: Record<
  string,
  React.ComponentType<{ className?: string }>
> = {
  completed: CheckCircle2,
  failed: XCircle,
  cancelled: MinusCircle,
}

const statusColors: Record<string, string> = {
  completed: "text-green-600",
  failed: "text-destructive",
  cancelled: "text-muted-foreground",
}

const statusLabels: Record<string, string> = {
  completed: "完成",
  failed: "失败",
  cancelled: "取消",
}

export function ExecutionTable({
  executions,
  loading,
  error,
  onRetry,
}: ExecutionTableProps) {
  const router = useRouter()

  if (loading) {
    return (
      <div className="space-y-2" aria-busy="true" aria-label="加载中">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="h-12 rounded bg-muted animate-pulse" />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12 text-center">
        <p className="text-sm text-destructive">数据加载失败</p>
        <button
          onClick={onRetry}
          className="mt-2 inline-flex items-center gap-1 text-sm text-primary hover:underline"
        >
          <RefreshCw className="h-3 w-3" /> 重试
        </button>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="text-left font-medium p-3">工作流</th>
            <th className="text-left font-medium p-3">状态</th>
            <th className="text-left font-medium p-3 hidden md:table-cell">
              耗时
            </th>
            <th className="text-left font-medium p-3">成本</th>
            <th className="text-left font-medium p-3 hidden md:table-cell">
              时间
            </th>
          </tr>
        </thead>
        <tbody>
          {executions.map((exec) => {
            const StatusIcon = statusIcons[exec.status] ?? MinusCircle
            return (
              <tr
                key={exec.id}
                className="border-b last:border-b-0 hover:bg-accent/30 cursor-pointer transition-colors"
                onClick={() => router.push(`/archive/executions/${exec.id}`)}
                onKeyDown={(e) => {
                  if (e.key === "Enter")
                    router.push(`/archive/executions/${exec.id}`)
                }}
                tabIndex={0}
              >
                <td className="p-3">
                  <span className="font-medium">{exec.workflow_name}</span>
                </td>
                <td className="p-3">
                  <span
                    className={cn(
                      "inline-flex items-center gap-1",
                      statusColors[exec.status],
                    )}
                  >
                    <StatusIcon className="h-4 w-4" />
                    {statusLabels[exec.status] ?? exec.status}
                  </span>
                </td>
                <td className="p-3 hidden md:table-cell text-muted-foreground">
                  {formatDuration(exec.duration_ms)}
                </td>
                <td className="p-3">{formatCostUSD(exec.total_cost_usd)}</td>
                <td className="p-3 hidden md:table-cell text-muted-foreground text-xs">
                  {format(new Date(exec.started_at), "MM-dd HH:mm")}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
