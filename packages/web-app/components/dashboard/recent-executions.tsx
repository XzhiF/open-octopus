import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { formatDuration } from "@/lib/format"
import type { Execution, ExecutionStatus } from "@/lib/types"
import {
  CheckCircle2,
  XCircle,
  Clock,
  Play,
  ArrowRight,
  Timer,
  PauseCircle,
  SkipForward,
  Ban,
} from "lucide-react"

interface RecentExecutionsProps {
  executions: Execution[]
}

const statusConfig: Record<
  ExecutionStatus,
  { icon: React.ElementType; label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  completed: { icon: CheckCircle2, label: "完成", variant: "default" },
  completed_with_failures: { icon: CheckCircle2, label: "部分失败", variant: "default" },
  failed: { icon: XCircle, label: "失败", variant: "destructive" },
  running: { icon: Play, label: "运行中", variant: "secondary" },
  pending: { icon: Clock, label: "待开始", variant: "outline" },
  cancelled: { icon: XCircle, label: "已取消", variant: "outline" },
  paused: { icon: PauseCircle, label: "已暂停", variant: "outline" },
  skipped: { icon: SkipForward, label: "已跳过", variant: "outline" },
  rejected: { icon: Ban, label: "已拒绝", variant: "destructive" },
  pending_approval: { icon: Clock, label: "待审批", variant: "outline" },
}

function formatTime(dateString: string): string {
  const date = new Date(dateString)
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  })
}

function ExecutionRow({ execution }: { execution: Execution }) {
  const config = statusConfig[execution.status]
  const StatusIcon = config.icon

  return (
    <Link
      href={`/workspaces/${execution.workspaceId}?tab=detail&execId=${execution.id}`}
      className="group flex items-center gap-4 rounded-lg px-3 py-2.5 transition-colors hover:bg-accent"
    >
      {/* Status Icon */}
      <div
        className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full ${
          execution.status === "completed"
            ? "bg-emerald-500/10 text-emerald-500"
            : execution.status === "completed_with_failures"
              ? "bg-amber-500/10 text-amber-500"
              : execution.status === "failed" || execution.status === "rejected"
                ? "bg-destructive/10 text-destructive"
                : "bg-muted text-muted-foreground"
        }`}
      >
        <StatusIcon className="h-4 w-4" />
      </div>

      {/* Info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{execution.workflowName}</span>
          <Badge variant={config.variant} className="flex-shrink-0 text-xs">
            {config.label}
          </Badge>
        </div>
        <p className="truncate text-sm text-muted-foreground">
          {execution.workspaceName}
        </p>
      </div>

      {/* Duration */}
      <div className="flex flex-shrink-0 items-center gap-1 text-sm text-muted-foreground">
        <Timer className="h-3.5 w-3.5" />
        <span className="tabular-nums">{formatDuration(execution.duration)}</span>
      </div>

      {/* Time */}
      <div className="w-16 flex-shrink-0 text-right text-sm tabular-nums text-muted-foreground">
        {formatTime(execution.startedAt)}
      </div>

      {/* Arrow */}
      <ArrowRight className="h-4 w-4 flex-shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </Link>
  )
}

export function RecentExecutions({ executions }: RecentExecutionsProps) {
  // Filter to show only completed/failed executions (not running/pending)
  const completedExecutions = executions.filter(
    (e) => e.status === "completed" || e.status === "failed" || e.status === "cancelled" || e.status === "rejected"
  )

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold">最近执行记录</CardTitle>
          <span className="text-sm text-muted-foreground">查看全部</span>
        </div>
      </CardHeader>
      <CardContent className="px-3 flex-1">
        {completedExecutions.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
              <CheckCircle2 className="h-5 w-5 text-muted-foreground" />
            </div>
            <h3 className="mt-3 text-sm font-medium">暂无执行记录</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              在工作空间中执行工作流后，历史记录将显示在这里
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {completedExecutions.map((execution) => (
              <ExecutionRow key={execution.id} execution={execution} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
