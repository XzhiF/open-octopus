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
import { JobTypeBadge } from "./job-type-badge"
import { ToggleSwitch } from "./toggle-switch"
import { ActionMenu } from "./action-menu"
import { SchedulerTableSkeleton } from "./skeleton-loader"
import { isBuiltinJob, type SchedulerJob } from "@/lib/scheduler-api"
import { formatDuration } from "@/lib/format"

interface SchedulerTableProps {
  jobs: SchedulerJob[]
  onToggle: (job: SchedulerJob) => void
  onEdit: (job: SchedulerJob) => void
  onDelete: (job: SchedulerJob) => void
  onTrigger: (job: SchedulerJob) => void
  loading?: boolean
}

/** 上次触发 + 耗时（票06 手测⑤：系统调度页的内置 job 一行要能看出「上次触发与耗时」）。
 *  数字念法走 lib/format.ts 的 formatDuration（C4 单源立法，私有副本会被
 *  formatter-revival-gate 钉住）。duration_ms 为 null 是两种真实情况——那一轮还在跑，
 *  或它是 skip/miss 行（根本没有引擎可计时）——此时整段不显示，而不是写「耗时 —」：
 *  这两类行本来就没有跑过，缺一个数字不是待填的空。 */
function formatLastExecution(job: SchedulerJob): string {
  const exec = job.last_execution
  if (!exec) return "-"
  try {
    const when = formatDistanceToNow(new Date(exec.triggered_at), {
      addSuffix: true,
      locale: zhCN,
    })
    return typeof exec.duration_ms === "number"
      ? `${when} · 耗时 ${formatDuration(exec.duration_ms)}`
      : when
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
    <div className="rounded-xl border-[2.5px] border-pop-bd bg-pop-paper shadow-pop-sm overflow-hidden">
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
          {jobs.map((job) => {
            return (
            <TableRow key={job.id}>
              <TableCell>
                <Link
                  href={`/scheduler/jobs/${job.id}`}
                  className="font-medium text-scheduler-primary hover:underline"
                  aria-label={`查看任务 ${job.name}`}
                >
                  {job.name}
                </Link>
              </TableCell>
              <TableCell>
                <JobTypeBadge type={job.job_type} />
              </TableCell>
              <TableCell>
                <code className="text-xs bg-muted rounded px-1.5 py-0.5 font-mono">
                  {job.cron_expression ?? "-"}
                </code>
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <StatusBadge
                    enabled={job.enabled}
                    lastExecutionStatus={job.last_execution?.status}
                    consecutiveFailures={job.consecutive_failures}
                  />
                  {/* 票03 (ADR-0021): every row of this table IS a job definition now
                      (the origin_* columns + the task envelopes' one-shot rows left with
                      schema v42), so toggleJob has no origin to reject on — the switch
                      is unconditional, including for a job_type='job' row like the
                      built-in 系统 · 任务生命周期. */}
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
                  editable={job.job_type !== "job"}
                  deletable={!isBuiltinJob(job)}
                  onEdit={() => onEdit(job)}
                  onDelete={() => onDelete(job)}
                  onTrigger={() => onTrigger(job)}
                />
              </TableCell>
            </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
