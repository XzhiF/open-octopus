'use client'

import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { AlertTriangle, ChevronDown, ChevronRight, Clock, CheckCircle2, XCircle } from 'lucide-react'
import type { ScheduledJob } from '@/lib/agent/types'
import { cn } from '@/lib/utils'
import { getServerUrl } from '@/lib/server-config'

interface ScheduledJobListProps {
  jobs: ScheduledJob[]
  loading: boolean
}

interface JobExecution {
  id: string
  status: string
  started_at: string
  finished_at: string | null
  duration_ms: number | null
  report_path: string | null
  report_summary: string | null
  error_message: string | null
  trigger_type: string
}

interface HistorySummary {
  total: number
  success: number
  failure: number
  avg_duration_ms: number
  success_rate: number
}

const statusLabels: Record<string, { label: string; className: string }> = {
  active: { label: '活跃', className: 'bg-agent-success-light text-agent-success-foreground' },
  circuit_broken: { label: '已熔断', className: 'bg-agent-error-light text-agent-error' },
  paused: { label: '已暂停', className: 'bg-muted text-muted-foreground' },
}

const execStatusIcon: Record<string, React.ReactNode> = {
  success: <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />,
  failure: <XCircle className="h-3.5 w-3.5 text-red-500" />,
  timeout: <XCircle className="h-3.5 w-3.5 text-orange-500" />,
  running: <Clock className="h-3.5 w-3.5 text-blue-500 animate-pulse" />,
  cancelled: <Clock className="h-3.5 w-3.5 text-gray-400" />,
}

export function ScheduledJobList({ jobs, loading }: ScheduledJobListProps) {
  const [expandedJob, setExpandedJob] = useState<string | null>(null)
  const [history, setHistory] = useState<Record<string, { executions: JobExecution[]; summary: HistorySummary }>>({})
  const [loadingHistory, setLoadingHistory] = useState<string | null>(null)

  const toggleHistory = async (jobName: string) => {
    if (expandedJob === jobName) {
      setExpandedJob(null)
      return
    }

    setExpandedJob(jobName)

    if (!history[jobName]) {
      setLoadingHistory(jobName)
      try {
        const res = await fetch(`${getServerUrl()}/api/agent/tasks/history?job_name=${encodeURIComponent(jobName)}&limit=20`, {
          headers: { 'Authorization': 'Bearer agent' },
        })
        if (res.ok) {
          const data = await res.json()
          setHistory(prev => ({ ...prev, [jobName]: data }))
        }
      } catch {
        // History fetch failure is non-fatal
      } finally {
        setLoadingHistory(null)
      }
    }
  }

  if (loading) {
    return (
      <div className="p-4 space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    )
  }

  if (jobs.length === 0) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        暂无定时任务
      </div>
    )
  }

  return (
    <div className="p-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8" />
            <TableHead>Cron</TableHead>
            <TableHead>工作流</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>上次执行</TableHead>
            <TableHead>下次执行</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {jobs.map((job) => {
            const statusInfo = statusLabels[job.status] ?? statusLabels.active
            const isExpanded = expandedJob === job.workflow_name
            const jobHistory = history[job.workflow_name]
            const isLoadingHistory = loadingHistory === job.workflow_name

            return (
              <JobRowGroup key={job.id}>
                <TableRow
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => toggleHistory(job.workflow_name)}
                >
                  <TableCell className="w-8">
                    {isExpanded
                      ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{job.cron}</TableCell>
                  <TableCell className="text-sm">{job.workflow_name}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={cn('text-xs', statusInfo.className)}>
                      {statusInfo.label}
                      {job.consecutive_failures > 0 && (
                        <span className="ml-1 flex items-center gap-0.5">
                          <AlertTriangle className="h-3 w-3" />{job.consecutive_failures}
                        </span>
                      )}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {job.last_run_at ? new Date(job.last_run_at).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {job.next_run_at ? new Date(job.next_run_at).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
                  </TableCell>
                </TableRow>

                {isExpanded && (
                  <TableRow>
                    <TableCell colSpan={6} className="p-0">
                      <div className="border-t bg-muted/20 p-3">
                        {isLoadingHistory ? (
                          <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                            <Clock className="h-4 w-4 animate-spin" />
                            加载执行历史...
                          </div>
                        ) : jobHistory ? (
                          <ExecutionHistory
                            executions={jobHistory.executions}
                            summary={jobHistory.summary}
                          />
                        ) : (
                          <div className="text-sm text-muted-foreground py-2">
                            暂无执行历史
                          </div>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </JobRowGroup>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

// ── Execution History Sub-Component ─────────────────────────────────

function ExecutionHistory({ executions, summary }: { executions: JobExecution[]; summary: HistorySummary }) {
  return (
    <div className="space-y-3">
      {/* Summary Stats */}
      <div className="flex items-center gap-4 text-xs">
        <span className="text-muted-foreground">
          共 <strong>{summary.total}</strong> 次执行
        </span>
        <span className="text-green-600">
          成功 {summary.success}
        </span>
        <span className="text-red-600">
          失败 {summary.failure}
        </span>
        <span className="text-muted-foreground">
          成功率 {summary.success_rate}%
        </span>
        <span className="text-muted-foreground">
          平均耗时 {summary.avg_duration_ms > 0 ? `${(summary.avg_duration_ms / 1000).toFixed(1)}s` : '—'}
        </span>
      </div>

      {/* Execution Timeline */}
      {executions.length > 0 ? (
        <div className="space-y-1">
          {executions.slice(0, 10).map((exec) => (
            <div
              key={exec.id}
              className="flex items-center gap-3 text-xs py-1.5 px-2 rounded bg-background/50"
            >
              {execStatusIcon[exec.status] ?? <Clock className="h-3.5 w-3.5 text-gray-400" />}
              <span className="font-mono text-muted-foreground w-32">
                {new Date(exec.started_at).toLocaleString('zh-CN', {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
              <span className={cn(
                'font-medium w-12',
                exec.status === 'success' && 'text-green-600',
                exec.status === 'failure' && 'text-red-600',
                exec.status === 'timeout' && 'text-orange-600',
              )}>
                {exec.status}
              </span>
              <span className="text-muted-foreground w-16">
                {exec.duration_ms != null ? `${(exec.duration_ms / 1000).toFixed(1)}s` : '—'}
              </span>
              {exec.report_summary && (
                <span className="text-muted-foreground truncate flex-1" title={exec.report_summary}>
                  {exec.report_summary}
                </span>
              )}
              {exec.error_message && (
                <span className="text-red-500 truncate flex-1" title={exec.error_message}>
                  {exec.error_message}
                </span>
              )}
              <Badge variant="outline" className="text-[10px] shrink-0">
                {exec.trigger_type}
              </Badge>
            </div>
          ))}
          {executions.length > 10 && (
            <div className="text-xs text-muted-foreground text-center py-1">
              显示最近 10 条，共 {executions.length} 条记录
            </div>
          )}
        </div>
      ) : (
        <div className="text-sm text-muted-foreground py-2">
          暂无执行记录
        </div>
      )}
    </div>
  )
}

// Helper component for grouping table rows
function JobRowGroup({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
