"use client"

import { useState, useEffect, useCallback } from "react"
import { cn } from "@/lib/utils"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ChevronDown, ChevronUp } from "lucide-react"
import { format, parseISO } from "date-fns"
import {
  listAuditLogs,
  type SchedulerAuditLog,
  type AuditAction,
} from "@/lib/scheduler-api"

interface AuditLogListProps {
  jobId: string
}

const ACTION_LABELS: Record<AuditAction, string> = {
  created: "创建",
  updated: "更新",
  deleted: "删除",
  enabled: "启用",
  disabled: "禁用",
  triggered: "手动触发",
  ai_created: "AI 创建",
  ai_updated: "AI 更新",
  ai_deleted: "AI 删除",
}

const ACTION_VARIANTS: Record<AuditAction, string> = {
  created: "bg-scheduler-success/10 text-scheduler-success border-transparent",
  updated: "bg-scheduler-info/10 text-scheduler-info border-transparent",
  deleted: "bg-destructive/10 text-destructive border-transparent",
  enabled: "bg-scheduler-success/10 text-scheduler-success border-transparent",
  disabled: "bg-scheduler-paused/10 text-scheduler-paused border-transparent",
  triggered: "bg-scheduler-primary/10 text-scheduler-primary border-transparent",
  ai_created: "bg-scheduler-accent/10 text-scheduler-accent border-transparent",
  ai_updated: "bg-scheduler-accent/10 text-scheduler-accent border-transparent",
  ai_deleted: "bg-destructive/10 text-destructive border-transparent",
}

function AuditLogItem({ log }: { log: SchedulerAuditLog }) {
  const [expanded, setExpanded] = useState(false)
  const hasChanges = log.changes && Object.keys(log.changes).length > 0

  return (
    <div className="border-b last:border-0">
      <div
        className={cn(
          "flex items-center gap-3 px-3 py-2.5 text-sm",
          hasChanges && "cursor-pointer hover:bg-muted/50"
        )}
        onClick={hasChanges ? () => setExpanded(!expanded) : undefined}
      >
        <Badge variant="outline" className={cn("text-xs", ACTION_VARIANTS[log.action])}>
          {ACTION_LABELS[log.action] ?? log.action}
        </Badge>
        <span className="font-medium">{log.actor}</span>
        <span className="ml-auto text-xs text-muted-foreground">
          {format(parseISO(log.created_at), "MM-dd HH:mm")}
        </span>
        {hasChanges && (
          <span className="text-muted-foreground">
            {expanded ? (
              <ChevronUp className="size-3.5" />
            ) : (
              <ChevronDown className="size-3.5" />
            )}
          </span>
        )}
      </div>
      {expanded && hasChanges && (
        <div className="border-t bg-muted/30 px-3 py-2">
          <dl className="space-y-2 text-xs">
            {Object.entries(log.changes!).map(([field, change]) => (
              <div key={field} className="space-y-0.5">
                <dt className="font-medium text-muted-foreground">{field}</dt>
                <dd className="flex gap-2">
                  <span className="rounded bg-destructive/10 px-1.5 py-0.5 font-mono text-destructive line-through">
                    {JSON.stringify(change.before)}
                  </span>
                  <span className="text-muted-foreground">&rarr;</span>
                  <span className="rounded bg-scheduler-success/10 px-1.5 py-0.5 font-mono text-scheduler-success">
                    {JSON.stringify(change.after)}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  )
}

export function AuditLogList({ jobId }: AuditLogListProps) {
  const [logs, setLogs] = useState<SchedulerAuditLog[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)

  const fetchLogs = useCallback(async () => {
    setLoading(true)
    try {
      const data = await listAuditLogs(jobId, { page, limit: 20 })
      setLogs(data.items)
      setTotal(data.total)
    } catch {
      setLogs([])
    } finally {
      setLoading(false)
    }
  }, [jobId, page])

  useEffect(() => {
    fetchLogs()
  }, [fetchLogs])

  if (loading) {
    return (
      <div className="space-y-2 py-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    )
  }

  if (logs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <p className="text-sm text-muted-foreground">暂无变更记录</p>
      </div>
    )
  }

  return (
    <div>
      <div className="divide-y rounded-md border">
        {logs.map((log) => (
          <AuditLogItem key={log.id} log={log} />
        ))}
      </div>
      {total > 20 && (
        <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
          <span>
            第 {page} 页 / 共 {Math.ceil(total / 20)} 页
          </span>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              上一页
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page * 20 >= total}
              onClick={() => setPage((p) => p + 1)}
            >
              下一页
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
