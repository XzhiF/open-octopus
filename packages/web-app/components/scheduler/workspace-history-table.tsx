"use client"

import { useEffect, useState, useCallback } from "react"
import Link from "next/link"
import { ExternalLink, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  listScheduleWorkspaces,
  type ScheduleWorkspace,
} from "@/lib/scheduler-api"

const STATUS_STYLES: Record<string, string> = {
  running: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  completed: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
  failed: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
}

const STATUS_LABELS: Record<string, string> = {
  running: "运行中",
  completed: "已完成",
  failed: "失败",
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function formatDuration(start: string, end: string | null): string {
  if (!end) return "进行中"
  const ms = new Date(end).getTime() - new Date(start).getTime()
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${Math.round(ms / 1000)}s`
  return `${Math.round(ms / 60000)}m`
}

interface Props {
  jobId: string
  maxRetain: number
}

export function WorkspaceHistoryTable({ jobId, maxRetain }: Props) {
  const [items, setItems] = useState<ScheduleWorkspace[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const result = await listScheduleWorkspaces(jobId, { limit: 50 })
      setItems(result.items)
      setTotal(result.total)
    } catch {
      // Silently handle errors
    } finally {
      setLoading(false)
    }
  }, [jobId])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
        加载中...
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          保留: {maxRetain} 个 | 当前: {total} 个
        </p>
        <Button variant="outline" size="sm" onClick={fetchData}>
          <RefreshCw className="mr-1 h-3 w-3" />
          刷新
        </Button>
      </div>

      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
          暂无执行空间记录
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-4 py-2 text-left font-medium">时间</th>
                <th className="px-4 py-2 text-left font-medium">分支后缀</th>
                <th className="px-4 py-2 text-left font-medium">状态</th>
                <th className="px-4 py-2 text-left font-medium">耗时</th>
                <th className="px-4 py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {items.map((ws) => (
                <tr key={ws.id} className="hover:bg-muted/30">
                  <td className="px-4 py-2 font-mono text-xs">
                    {formatTime(ws.started_at)}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                    {ws.branch_suffix}
                  </td>
                  <td className="px-4 py-2">
                    <Badge
                      variant="secondary"
                      className={STATUS_STYLES[ws.status] ?? ""}
                    >
                      {STATUS_LABELS[ws.status] ?? ws.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {formatDuration(ws.started_at, ws.completed_at)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {ws.workspace_id ? (
                      <Link
                        href={`/workspaces/${ws.workspace_id}`}
                        className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                      >
                        查看空间
                        <ExternalLink className="h-3 w-3" />
                      </Link>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {items.some((ws) => ws.error) && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            查看错误详情
          </summary>
          <div className="mt-2 space-y-2">
            {items
              .filter((ws) => ws.error)
              .map((ws) => (
                <div
                  key={ws.id}
                  className="rounded border-l-2 border-red-300 bg-red-50 p-2 dark:border-red-700 dark:bg-red-950"
                >
                  <span className="font-mono text-xs">{ws.branch_suffix}</span>
                  <p className="mt-1 text-xs text-red-700 dark:text-red-300">
                    {ws.error}
                  </p>
                </div>
              ))}
          </div>
        </details>
      )}
    </div>
  )
}
