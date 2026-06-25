"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import { format, parseISO } from "date-fns"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ChevronUp, Eye } from "lucide-react"
import type { SchedulerExecution, JobType, ExecutionStatus } from "@/lib/scheduler-api"
import { LogViewer } from "./log-viewer"
import { AgentOutputViewer } from "./agent-output-viewer"

interface ExecutionHistoryTableProps {
  executions: SchedulerExecution[]
  jobId: string
  loading?: boolean
  jobType: JobType
}

const TRIGGER_LABELS: Record<string, string> = {
  scheduled: "定时触发",
  manual: "手动触发",
  retry: "重试",
}

const EXEC_STATUS_STYLES: Record<string, string> = {
  triggered: "bg-scheduler-info/10 text-scheduler-info border-transparent",
  running: "bg-scheduler-info/10 text-scheduler-info border-transparent",
  success: "bg-scheduler-success/10 text-scheduler-success border-transparent",
  failure: "bg-scheduler-error/10 text-scheduler-error border-transparent",
  timeout: "bg-scheduler-error/10 text-scheduler-error border-transparent",
  cancelled: "bg-scheduler-paused/10 text-scheduler-paused border-transparent",
  skipped: "bg-scheduler-paused/10 text-scheduler-paused border-transparent",
  missed: "bg-scheduler-warn/10 text-scheduler-warn border-transparent",
}

const EXEC_STATUS_LABELS: Record<string, string> = {
  triggered: "已触发",
  running: "运行中",
  success: "成功",
  failure: "失败",
  timeout: "超时",
  cancelled: "已取消",
  skipped: "已跳过",
  missed: "已错过",
}

function ExecutionStatusBadge({ status }: { status: ExecutionStatus }) {
  return (
    <Badge
      variant="outline"
      className={cn("text-xs", EXEC_STATUS_STYLES[status] ?? "")}
    >
      {EXEC_STATUS_LABELS[status] ?? status}
    </Badge>
  )
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "-"
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
}

function ExecutionRow({
  execution,
  jobId,
  jobType,
}: {
  execution: SchedulerExecution
  jobId: string
  jobType: JobType
}) {
  const [expanded, setExpanded] = useState(false)
  const isFailed = execution.status === "failure" || execution.status === "timeout"

  return (
    <>
      <tr
        className={cn(
          "border-b transition-colors hover:bg-muted/50",
          isFailed && "bg-destructive/5"
        )}
      >
        <td className="px-3 py-2.5 text-sm">
          {format(parseISO(execution.triggered_at), "MM-dd HH:mm:ss")}
        </td>
        <td className="px-3 py-2.5">
          <ExecutionStatusBadge status={execution.status} />
        </td>
        <td className="px-3 py-2.5 text-sm text-muted-foreground">
          {TRIGGER_LABELS[execution.trigger_type] ?? execution.trigger_type}
        </td>
        <td className="px-3 py-2.5 font-mono text-xs">
          {formatDuration(execution.duration_ms)}
        </td>
        <td className="px-3 py-2.5 font-mono text-xs">
          {execution.exit_code != null ? execution.exit_code : "-"}
        </td>
        {jobType === "agent" && (
          <>
            <td className="px-3 py-2.5 text-xs text-muted-foreground">
              {execution.model_used ?? "-"}
            </td>
            <td className="px-3 py-2.5 font-mono text-xs">
              {execution.token_usage
                ? `${execution.token_usage.input}/${execution.token_usage.output}`
                : "-"}
            </td>
          </>
        )}
        <td className="px-3 py-2.5">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setExpanded(!expanded)}
            aria-label={expanded ? "收起日志" : "查看日志"}
          >
            {expanded ? (
              <ChevronUp className="size-4" />
            ) : (
              <Eye className="size-4" />
            )}
          </Button>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td
            colSpan={jobType === "agent" ? 8 : 6}
            className="bg-neutral-950/5 p-0"
          >
            {jobType === "agent" && execution.agent_output && (
              <div className="p-4 border-b border-border">
                <AgentOutputViewer
                  output={execution.agent_output}
                  modelUsed={execution.model_used}
                  tokenUsage={execution.token_usage ? { input_tokens: execution.token_usage.input, output_tokens: execution.token_usage.output } : null}
                />
              </div>
            )}
            <LogViewer jobId={jobId} executionId={execution.id} />
          </td>
        </tr>
      )}
    </>
  )
}

export function ExecutionHistoryTable({
  executions,
  jobId,
  loading,
  jobType,
}: ExecutionHistoryTableProps) {
  if (loading && executions.length === 0) {
    return (
      <div className="space-y-2 py-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    )
  }

  if (executions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <p className="text-sm text-muted-foreground">暂无执行记录</p>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="px-3 py-2 font-medium">触发时间</th>
            <th className="px-3 py-2 font-medium">状态</th>
            <th className="px-3 py-2 font-medium">触发方式</th>
            <th className="px-3 py-2 font-medium">耗时</th>
            <th className="px-3 py-2 font-medium">退出码</th>
            {jobType === "agent" && (
              <>
                <th className="px-3 py-2 font-medium">模型</th>
                <th className="px-3 py-2 font-medium">Token (i/o)</th>
              </>
            )}
            <th className="px-3 py-2 font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          {executions.map((exec) => (
            <ExecutionRow
              key={exec.id}
              execution={exec}
              jobId={jobId}
              jobType={jobType}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}
