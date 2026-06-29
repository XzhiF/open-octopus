"use client"

import { useState, useEffect, useCallback, Suspense } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useArchiveExecutions } from "@/hooks/use-archive-executions"
import { getWorkflowStats } from "@/lib/archive-api"
import { FilterBar } from "@/components/archive/filter-bar"
import { ExecutionTable } from "@/components/archive/execution-table"
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination"
import { Archive } from "lucide-react"

function ArchiveExecutionsContent() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const workflow = searchParams.get("workflow") ?? undefined
  const status = searchParams.get("status") ?? undefined
  const from = searchParams.get("from") ?? undefined
  const to = searchParams.get("to") ?? undefined
  const page = Number(searchParams.get("page") ?? 1)
  const pageSize = Number(searchParams.get("pageSize") ?? 20)

  const { data, loading, error, refetch } = useArchiveExecutions({
    workflow,
    status,
    from,
    to,
    page,
    pageSize,
  })

  const [workflowOptions, setWorkflowOptions] = useState<string[]>([])

  useEffect(() => {
    getWorkflowStats(30)
      .then((res) => {
        setWorkflowOptions(res.workflows.map((w) => w.workflow_ref))
      })
      .catch(() => {})
  }, [])

  const updateParams = useCallback(
    (updates: Record<string, string | undefined>) => {
      const params = new URLSearchParams(searchParams.toString())
      for (const [key, value] of Object.entries(updates)) {
        if (value) params.set(key, value)
        else params.delete(key)
      }
      if (
        "workflow" in updates ||
        "status" in updates ||
        "from" in updates ||
        "to" in updates
      ) {
        params.set("page", "1")
      }
      router.push(`/archive/executions?${params.toString()}`)
    },
    [router, searchParams],
  )

  const hasFilters = !!(workflow || status || from || to)
  const isEmpty = data.total === 0 && !loading && !hasFilters
  const isFilterEmpty = data.total === 0 && !loading && hasFilters

  const totalPages = Math.ceil(data.total / pageSize)

  function buildPageHref(targetPage: number) {
    const params = new URLSearchParams(searchParams.toString())
    params.set("page", String(targetPage))
    return `/archive/executions?${params.toString()}`
  }

  return (
    <div className="container mx-auto px-4 py-6 lg:px-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">归档执行记录</h1>
        <p className="text-muted-foreground">
          浏览所有已归档的工作流执行数据
        </p>
      </div>

      <FilterBar
        workflow={workflow}
        status={status}
        from={from}
        to={to}
        workflowOptions={workflowOptions}
        onChange={updateParams}
      />

      {isEmpty && (
        <div
          className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center"
          role="status"
        >
          <Archive className="h-12 w-12 text-muted-foreground mb-4" />
          <p className="text-lg font-medium">暂无归档执行记录</p>
          <p className="text-sm text-muted-foreground mt-1">
            工作流执行完成后，数据将自动归档并显示在这里。
          </p>
        </div>
      )}

      {isFilterEmpty && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12 text-center">
          <p className="text-sm text-muted-foreground">
            未找到匹配的执行记录。
          </p>
          <button
            onClick={() => router.push("/archive/executions")}
            className="mt-2 text-sm text-primary hover:underline"
          >
            清除所有过滤
          </button>
        </div>
      )}

      {!isEmpty && !isFilterEmpty && (
        <>
          <ExecutionTable
            executions={data.data}
            loading={loading}
            error={error}
            onRetry={refetch}
          />

          {data.total > 0 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                共 {data.total} 条记录
              </p>
              <Pagination>
                <PaginationContent>
                  <PaginationItem>
                    <PaginationPrevious
                      href={page > 1 ? buildPageHref(page - 1) : undefined}
                    />
                  </PaginationItem>
                  {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                    const p = Math.max(1, page - 2) + i
                    if (p > totalPages) return null
                    return (
                      <PaginationItem key={p}>
                        <PaginationLink
                          href={buildPageHref(p)}
                          isActive={p === page}
                        >
                          {p}
                        </PaginationLink>
                      </PaginationItem>
                    )
                  })}
                  <PaginationItem>
                    <PaginationNext
                      href={
                        page < totalPages ? buildPageHref(page + 1) : undefined
                      }
                    />
                  </PaginationItem>
                </PaginationContent>
              </Pagination>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default function ArchiveExecutionsPage() {
  return (
    <Suspense
      fallback={
        <div className="container mx-auto px-4 py-6">
          <p className="text-muted-foreground">加载中...</p>
        </div>
      }
    >
      <ArchiveExecutionsContent />
    </Suspense>
  )
}
