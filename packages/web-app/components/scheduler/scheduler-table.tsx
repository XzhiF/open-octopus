"use client"

import Link from "next/link"
import { format, formatDistanceToNow } from "date-fns"
import { zhCN } from "date-fns/locale"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { StatusBadge } from "./status-badge"
import { JobTypeBadge, isAgentRegistered, AgentRegisteredBadge } from "./job-type-badge"
import { ToggleSwitch } from "./toggle-switch"
import { ActionMenu } from "./action-menu"
import { SchedulerTableSkeleton } from "./skeleton-loader"
import type { SchedulerJob } from "@/lib/scheduler-api"

interface SchedulerTableProps {
  jobs: SchedulerJob[]
  onToggle: (job: SchedulerJob) => void
  onEdit: (job: SchedulerJob) => void
  onDelete: (job: SchedulerJob) => void
  onTrigger: (job: SchedulerJob) => void
  loading?: boolean
}

function formatLastExecution(job: SchedulerJob): string {
  if (!job.last_execution) return "-"
  try {
    return formatDistanceToNow(new Date(job.last_execution.triggered_at), {
      addSuffix: true,
      locale: zhCN,
    })
  } catch {
    return "-"
  }
}

function formatNextTrigger(at: string | null): string {
  if (!at) return "-"
  try {
    return format(new Date(at), "MM/dd HH:mm", { locale: zhCN })
  } catch {
    return "-"
  }
}

export function SchedulerTable({
  jobs,
  onToggle,
  onEdit,
  onDelete,
  onTrigger,
  loading,
}: SchedulerTableProps) {
  if (loading) {
    return <SchedulerTableSkeleton />
  }

  return (
    <div className="rounded-md border">
      <Table aria-label="调度任务列表">
        <TableHeader>
          <TableRow>
            <TableHead>任务名称</TableHead>
            <TableHead>类型</TableHead>
            <TableHead>Cron 表达式</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>上次执行</TableHead>
            <TableHead>下次触发</TableHead>
            <TableHead>组织</TableHead>
            <TableHead className="w-[60px]">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {jobs.map((job) => (
            <TableRow key={job.id}>
              <TableCell>
                <div className="flex items-center gap-1.5">
                  <Link
                    href={`/scheduler/jobs/${job.id}`}
                    className="font-medium text-scheduler-primary hover:underline"
                    aria-label={`查看任务 ${job.name}`}
                  >
                    {job.name}
                  </Link>
                  {isAgentRegistered(job) && <AgentRegisteredBadge />}
                </div>
              </TableCell>
              <TableCell>
                <JobTypeBadge type={job.job_type} />
              </TableCell>
              <TableCell>
                <code className="text-xs bg-muted rounded px-1.5 py-0.5 font-mono">
                  {job.cron_expression}
                </code>
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <StatusBadge
                    enabled={job.enabled}
                    lastExecutionStatus={job.last_execution?.status}
                    consecutiveFailures={job.consecutive_failures}
                  />
                  <ToggleSwitch
                    jobId={job.id}
                    enabled={job.enabled}
                    jobName={job.name}
                    onToggle={async () => {
                      onToggle(job)
                    }}
                  />
                </div>
              </TableCell>
              <TableCell className="text-muted-foreground text-xs">
                {formatLastExecution(job)}
              </TableCell>
              <TableCell className="text-muted-foreground text-xs">
                {formatNextTrigger(job.next_trigger_at)}
              </TableCell>
              <TableCell className="text-muted-foreground text-xs">
                {job.org ?? "-"}
              </TableCell>
              <TableCell>
                <ActionMenu
                  jobId={job.id}
                  jobName={job.name}
                  onEdit={() => onEdit(job)}
                  onDelete={() => onDelete(job)}
                  onTrigger={() => onTrigger(job)}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
