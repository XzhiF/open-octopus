"use client"

import { useState, useEffect, useCallback } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import {
  Archive,
  Clock,
  DollarSign,
  Filter,
  X,
  ArrowUpDown,
} from "lucide-react"

import { cn } from "@/lib/utils"
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableCell,
  TableHead,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
  EmptyMedia,
} from "@/components/ui/empty"
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationPrevious,
  PaginationNext,
  PaginationEllipsis,
} from "@/components/ui/pagination"
import { toast } from "sonner"
import {
  fetchArchiveExecutions,
  fetchWorkflowStats,
} from "@/lib/archive-api"
import type {
  ArchiveExecutionItem,
  WorkflowStat,
} from "@/lib/archive-api"

const PAGE_SIZE = 20

// ---- Format helpers ----

function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "-"
  const minutes = Math.floor(ms / 60000)
  if (minutes < 60) return `${minutes}min`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}h ${remainingMinutes}min`
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60))

  if (diffHours < 1) return "刚刚"
  if (diffHours < 24) return `${diffHours} 小时前`
  if (diffHours < 48) return "1 天前"
  if (diffHours < 24 * 30) return `${Math.floor(diffHours / 24)} 天前`

  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${month}-${day}`
}

function statusVariant(
  status: string,
): { variant: "default" | "destructive" | "secondary"; className?: string } {
  switch (status) {
    case "completed":
      return { variant: "default", className: "bg-emerald-600 text-white" }
    case "failed":
      return { variant: "destructive" }
    case "cancelled":
      return { variant: "secondary" }
    default:
      return { variant: "secondary" }
  }
}

// ---- Page ----

export default function ArchiveListPage() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [executions, setExecutions] = useState<ArchiveExecutionItem[]>([])
  const [total, setTotal] = useState(0)
  const [workflows, setWorkflows] = useState<WorkflowStat[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Read filters from URL
  const workflow = searchParams.get("workflow") || ""
  const status = (searchParams.get("status") || "") as
    | ""
    | "completed"
    | "failed"
    | "cancelled"
  const from = searchParams.get("from") || ""
  const to = searchParams.get("to") || ""
  const sort = (searchParams.get("sort") || "created_at") as
    | "created_at"
    | "total_cost_usd"
    | "duration_ms"
  const order = (searchParams.get("order") || "desc") as "asc" | "desc"
  const page = parseInt(searchParams.get("page") || "1", 10)

  const hasFilters = Boolean(workflow || status || from || to)

  // Sync filter changes to URL
  const updateFilter = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString())
      if (value) {
        params.set(key, value)
      } else {
        params.delete(key)
      }
      if (key !== "page") params.set("page", "1")
      router.push(`/archive?${params.toString()}`)
    },
    [searchParams, router],
  )

  const clearFilters = useCallback(() => {
    router.push("/archive")
  }, [router])

  // Fetch workflow options for dropdown
  useEffect(() => {
    fetchWorkflowStats({ limit: 100 })
      .then((data) => setWorkflows(data.items))
      .catch(() => {})
  }, [])

  // Fetch executions
  const fetchExecutions = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchArchiveExecutions({
        page,
        limit: PAGE_SIZE,
        workflow_ref: workflow || undefined,
        status: status || undefined,
        date_from: from || undefined,
        date_to: to || undefined,
        sort,
        order,
      })
      setExecutions(data.items)
      setTotal(data.total)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "获取归档数据失败"
      setError(message)
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }, [page, workflow, status, from, to, sort, order])

  useEffect(() => {
    fetchExecutions()
  }, [fetchExecutions])

  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <div className="container mx-auto space-y-6 px-4 py-6 lg:px-6">
      {/* Page Title */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">归档执行记录</h1>
        <p className="text-muted-foreground">
          查看历史工作流执行数据与成本分析
        </p>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center gap-4">
        {/* Workflow filter */}
        <Select
          value={workflow}
          onValueChange={(v) => updateFilter("workflow", v === "all" ? "" : v)}
        >
          <SelectTrigger>
            <Filter className="mr-1 h-3.5 w-3.5 text-muted-foreground" />
            <SelectValue placeholder="全部工作流" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部工作流</SelectItem>
            {workflows.map((w) => (
              <SelectItem key={w.workflow_ref} value={w.workflow_ref}>
                {w.workflow_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Status filter */}
        <Select
          value={status}
          onValueChange={(v) => updateFilter("status", v === "all" ? "" : v)}
        >
          <SelectTrigger>
            <SelectValue placeholder="全部状态" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="completed">completed</SelectItem>
            <SelectItem value="failed">failed</SelectItem>
            <SelectItem value="cancelled">cancelled</SelectItem>
          </SelectContent>
        </Select>

        {/* Date range */}
        <input
          type="date"
          value={from}
          onChange={(e) => updateFilter("from", e.target.value)}
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs"
        />
        <span className="text-muted-foreground text-sm">至</span>
        <input
          type="date"
          value={to}
          onChange={(e) => updateFilter("to", e.target.value)}
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs"
        />

        {/* Sort */}
        <Select
          value={sort}
          onValueChange={(v) => updateFilter("sort", v)}
        >
          <SelectTrigger>
            <ArrowUpDown className="mr-1 h-3.5 w-3.5 text-muted-foreground" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="created_at">时间</SelectItem>
            <SelectItem value="total_cost_usd">成本</SelectItem>
            <SelectItem value="duration_ms">耗时</SelectItem>
          </SelectContent>
        </Select>

        {/* Order toggle */}
        <Select
          value={order}
          onValueChange={(v) => updateFilter("order", v)}
        >
          <SelectTrigger size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="desc">降序</SelectItem>
            <SelectItem value="asc">升序</SelectItem>
          </SelectContent>
        </Select>

        {/* Clear filters */}
        {hasFilters && (
          <button
            onClick={clearFilters}
            className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-sm transition-colors"
          >
            <X className="h-3.5 w-3.5" />
            清除过滤
          </button>
        )}
      </div>

      {/* Error State */}
      {error && !loading && (
        <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed py-12 text-center">
          <p className="text-destructive text-sm">{error}</p>
          <button
            onClick={fetchExecutions}
            className="text-primary text-sm underline"
          >
            重试
          </button>
        </div>
      )}

      {/* Loading State */}
      {loading && !error && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>工作流名</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>耗时</TableHead>
              <TableHead>成本</TableHead>
              <TableHead>创建时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: 5 }).map((_, i) => (
              <TableRow key={i}>
                <TableCell>
                  <Skeleton className="h-4 w-32" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-5 w-16" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-16" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-12" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-20" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {/* Empty State (no data, no filters) */}
      {!loading && !error && executions.length === 0 && !hasFilters && (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Archive className="h-6 w-6" />
            </EmptyMedia>
            <EmptyTitle>暂无归档执行记录</EmptyTitle>
            <EmptyDescription>
              工作流执行完成后，记录会自动归档到此处
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {/* Filter Empty State (no results with filters) */}
      {!loading && !error && executions.length === 0 && hasFilters && (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Filter className="h-6 w-6" />
            </EmptyMedia>
            <EmptyTitle>未找到匹配的执行记录</EmptyTitle>
            <EmptyDescription>
              尝试调整过滤条件或清除所有过滤
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <button
              onClick={clearFilters}
              className="text-primary inline-flex items-center gap-1 text-sm underline"
            >
              <X className="h-3.5 w-3.5" />
              清除所有过滤
            </button>
          </EmptyContent>
        </Empty>
      )}

      {/* Success State: Table + Pagination */}
      {!loading && !error && executions.length > 0 && (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>工作流名</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>耗时</TableHead>
                <TableHead>成本</TableHead>
                <TableHead>创建时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {executions.map((item) => {
                const sv = statusVariant(item.status)
                return (
                  <TableRow key={item.id} className="cursor-pointer">
                    <TableCell>
                      <Link
                        href={`/archive/${item.id}`}
                        className="font-medium hover:underline"
                      >
                        {item.workflow_name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant={sv.variant} className={sv.className}>
                        {item.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <Clock className="mr-1 inline h-3.5 w-3.5" />
                      {formatDuration(item.duration_ms)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <DollarSign className="mr-0.5 inline h-3.5 w-3.5" />
                      {formatCost(item.total_cost_usd)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatTime(item.created_at)}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>

          {/* Pagination */}
          {totalPages > 1 && (
            <Pagination>
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    onClick={() => {
                      if (page > 1) updateFilter("page", String(page - 1))
                    }}
                    className={cn(
                      page <= 1 && "pointer-events-none opacity-50",
                    )}
                  />
                </PaginationItem>

                {Array.from({ length: totalPages }, (_, i) => i + 1).map(
                  (p) => {
                    // Show first, last, current +/-1, ellipsis for gaps
                    if (
                      p === 1 ||
                      p === totalPages ||
                      (p >= page - 1 && p <= page + 1)
                    ) {
                      return (
                        <PaginationItem key={p}>
                          <PaginationLink
                            onClick={() => updateFilter("page", String(p))}
                            isActive={p === page}
                          >
                            {p}
                          </PaginationLink>
                        </PaginationItem>
                      )
                    }
                    if (p === page - 2 || p === page + 2) {
                      return (
                        <PaginationItem key={p}>
                          <PaginationEllipsis />
                        </PaginationItem>
                      )
                    }
                    return null
                  },
                )}

                <PaginationItem>
                  <PaginationNext
                    onClick={() => {
                      if (page < totalPages)
                        updateFilter("page", String(page + 1))
                    }}
                    className={cn(
                      page >= totalPages &&
                        "pointer-events-none opacity-50",
                    )}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          )}
        </>
      )}
    </div>
  )
}
