"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { format, parseISO } from "date-fns"
import type { SchedulerJob, WorkflowConfig, AgentConfig } from "@/lib/scheduler-api"
import { StatusBadge } from "./status-badge"
import { JobTypeBadge } from "./job-type-badge"
import { ToggleSwitch } from "./toggle-switch"

interface ConfigSummaryCardProps {
  job: SchedulerJob
  onToggle?: () => Promise<void>
}

function ConfigRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("text-sm font-medium", mono && "font-mono text-xs")}>
        {value ?? <span className="text-muted-foreground">-</span>}
      </dd>
    </div>
  )
}

const PARALLEL_LABELS: Record<string, string> = {
  allow: "允许并行",
  wait: "排队等待",
  skip: "跳过执行",
}

export function ConfigSummaryCard({ job, onToggle }: ConfigSummaryCardProps) {
  const isWorkflow = job.job_type === "workflow"
  const config = job.config as WorkflowConfig | AgentConfig

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between">
          <span className="text-base">配置概览</span>
          {onToggle && (
            <ToggleSwitch
              jobId={job.id}
              enabled={job.enabled}
              jobName={job.name}
              onToggle={onToggle}
            />
          )}
        </CardTitle>
      </CardHeader>
      <Separator />
      <CardContent className="pt-0">
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <ConfigRow label="名称" value={job.name} />
          <ConfigRow
            label="类型"
            value={<JobTypeBadge type={job.job_type} />}
          />
          <ConfigRow
            label="状态"
            value={
              <StatusBadge
                enabled={job.enabled}
                lastExecutionStatus={job.last_execution?.status}
                consecutiveFailures={job.consecutive_failures}
              />
            }
          />
          <ConfigRow
            label="组织"
            value={job.org ?? (config as WorkflowConfig).workspace_spec?.org ?? "-"}
          />
          <ConfigRow
            label="Cron"
            value={job.cron_expression}
            mono
          />
          <ConfigRow label="时区" value={job.timezone} />
          <ConfigRow
            label="并行策略"
            value={PARALLEL_LABELS[job.parallel_policy] ?? job.parallel_policy}
          />
          <ConfigRow
            label="超时"
            value={`${job.timeout_seconds}s`}
          />

          {isWorkflow ? (
            <>
              <ConfigRow
                label="工作流链"
                value={
                  (config as WorkflowConfig).workflow_chain
                    ? `${(config as WorkflowConfig).workflow_chain.length} 步`
                    : (config as WorkflowConfig).workflow_ref ?? "-"
                }
              />
              <ConfigRow
                label="保留数量"
                value={String((config as WorkflowConfig).max_retain ?? job.max_retain ?? 10)}
              />
            </>
          ) : (
            <>
              <ConfigRow
                label="模型"
                value={(config as AgentConfig).model ?? "default"}
              />
              <ConfigRow
                label="重试次数"
                value={String((config as AgentConfig).retry_policy?.max_attempts ?? 0)}
              />
            </>
          )}

          <ConfigRow
            label="创建时间"
            value={format(parseISO(job.created_at), "yyyy-MM-dd HH:mm")}
          />
          <ConfigRow
            label="更新时间"
            value={format(parseISO(job.updated_at), "yyyy-MM-dd HH:mm")}
          />
          {job.description && (
            <div className="col-span-full">
              <ConfigRow label="描述" value={job.description} />
            </div>
          )}
        </dl>
      </CardContent>
    </Card>
  )
}
