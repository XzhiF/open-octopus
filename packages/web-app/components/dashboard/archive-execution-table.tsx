"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { History, Search } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { formatDuration } from "@/lib/format"
import { fetchArchiveExecutions } from "@/lib/archive-api"
import type { ArchiveStatus, ArchiveExecutionListItem, PaginatedResult } from "@octopus/shared"

const statusConfig: Record<ArchiveStatus, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  completed: { label: "完成", variant: "default" },
  completed_with_failures: { label: "部分失败", variant: "secondary" },
  failed: { label: "失败", variant: "destructive" },
  cancelled: { label: "已取消", variant: "outline" },
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

export function ArchiveExecutionTable() {
  const router = useRouter()
  const [data, setData] = useState<PaginatedResult<ArchiveExecutionListItem> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState<string>("all")
  const [workflowFilter, setWorkflowFilter] = useState("")
  const [retryKey, setRetryKey] = useState(0)
  const pageSize = 20

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const result = await fetchArchiveExecutions({
          page,
          pageSize,
          status: statusFilter === "all" ? undefined : statusFilter,
          workflow: workflowFilter || undefined,
        })
        if (!cancelled) setData(result)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "加载失败")
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [page, statusFilter, workflowFilter, retryKey])

  const totalPages = data ? Math.ceil(data.total / pageSize) : 0

  return (
    <Card role="region" aria-label="归档执行记录">
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <History className="h-4 w-4" />
            归档执行记录
          </CardTitle>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="按工作流筛选..."
                value={workflowFilter}
                onChange={(e) => { setWorkflowFilter(e.target.value); setPage(1) }}
                className="h-8 w-48 pl-8 text-xs"
              />
            </div>
            <Select
              value={statusFilter}
              onValueChange={(v) => { setStatusFilter(v); setPage(1) }}
            >
              <SelectTrigger size="sm" className="h-8 text-xs">
                <SelectValue placeholder="全部状态" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                <SelectItem value="completed">完成</SelectItem>
                <SelectItem value="completed_with_failures">部分失败</SelectItem>
                <SelectItem value="failed">失败</SelectItem>
                <SelectItem value="cancelled">已取消</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {loading ? (
          <div className="space-y-2 px-6">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : error ? (
          <div className="px-6 py-8 text-center">
            <p className="text-sm text-destructive">{error}</p>
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => setRetryKey((k) => k + 1)}>
              重试
            </Button>
          </div>
        ) : !data || data.data.length === 0 ? (
          <div className="px-6 py-8 text-center text-sm text-muted-foreground">
            暂无执行记录
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">工作流</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>耗时</TableHead>
                  <TableHead>成本</TableHead>
                  <TableHead>工作空间</TableHead>
                  <TableHead className="pr-6 text-right">开始时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.data.map((exec) => {
                  const cfg = statusConfig[exec.status] ?? { label: exec.status, variant: "outline" as const }
                  return (
                    <TableRow
                      key={exec.id}
                      className="cursor-pointer hover:bg-accent"
                      onClick={() => router.push(`/dashboard/memory/executions/${exec.id}`)}
                    >
                      <TableCell className="pl-6 font-medium">
                        <div className="max-w-[200px] truncate" title={exec.workflow_name}>
                          {exec.workflow_name}
                        </div>
                        <p className="text-xs text-muted-foreground tabular-nums">
                          {exec.id.slice(0, 8)}
                        </p>
                      </TableCell>
                      <TableCell>
                        <Badge variant={cfg.variant} className="text-[10px]">
                          {cfg.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">
                        {formatDuration(exec.duration_ms ? exec.duration_ms / 1000 : undefined)}
                      </TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">
                        ${exec.total_cost_usd.toFixed(4)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {exec.workspace_name ?? "-"}
                      </TableCell>
                      <TableCell className="pr-6 text-right tabular-nums text-muted-foreground">
                        {formatDate(exec.started_at)}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>

            {totalPages > 1 && (
              <div className="border-t px-6 py-3">
                <Pagination>
                  <PaginationContent>
                    <PaginationItem>
                      <PaginationPrevious
                        href="#"
                        onClick={(e) => {
                          e.preventDefault()
                          if (page > 1) setPage(page - 1)
                        }}
                        aria-disabled={page <= 1}
                        className={cn(page <= 1 && "pointer-events-none opacity-50")}
                      />
                    </PaginationItem>
                    <PaginationItem>
                      <PaginationLink href="#" onClick={(e) => e.preventDefault()}>
                        {page} / {totalPages}
                      </PaginationLink>
                    </PaginationItem>
                    <PaginationItem>
                      <PaginationNext
                        href="#"
                        onClick={(e) => {
                          e.preventDefault()
                          if (page < totalPages) setPage(page + 1)
                        }}
                        aria-disabled={page >= totalPages}
                        className={cn(page >= totalPages && "pointer-events-none opacity-50")}
                      />
                    </PaginationItem>
                  </PaginationContent>
                </Pagination>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
