"use client"

import { useSearchParams } from "next/navigation"
import Link from "next/link"
import { useAuditLog } from "@/hooks/use-audit-log"
import { AuditFilterBar } from "@/components/resources/audit-filter-bar"
import { AuditTable } from "@/components/resources/audit-table"
import { EmptyState } from "@/components/resources/empty-state"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { ScrollText, ArrowLeft, RotateCcw, PackageOpen, AlertTriangle } from "lucide-react"

export function AuditPage() {
  const searchParams = useSearchParams()

  const action = searchParams.get("action") ?? undefined
  const resource = searchParams.get("resource") ?? undefined
  const last = searchParams.get("last") ? Number(searchParams.get("last")) : 20

  const { entries, loading, error, partial, refetch } = useAuditLog({ action, resource, last })

  const hasFilters = !!action || !!resource

  return (
    <div className="container mx-auto space-y-6 px-4 py-6 lg:px-6">
      {/* Header */}
      <div className="space-y-1">
        <div className="flex items-center gap-2 mb-2">
          <Button variant="ghost" size="sm" asChild className="gap-1.5 -ml-2">
            <Link href="/resources">
              <ArrowLeft className="size-3.5" />
              资源管理
            </Link>
          </Button>
        </div>
        <h1 className="text-2xl font-bold tracking-tight">审计日志</h1>
        <p className="text-muted-foreground">追溯所有资源操作记录</p>
      </div>

      {/* Filter bar */}
      <AuditFilterBar resourceNames={[]} />

      {/* F14: Partial data banner — archived logs exist but not extracted */}
      {partial && (
        <Alert className="border-amber-200 bg-amber-50">
          <AlertTriangle className="size-4 text-amber-600" />
          <AlertDescription className="text-amber-800">
            显示的数据不完整 — 部分历史日志已归档压缩，当前查询结果不包含归档内容。
          </AlertDescription>
        </Alert>
      )}

      {/* Error */}
      {error && (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center gap-2">
            <span>{error}</span>
            <Button variant="outline" size="sm" onClick={refetch} className="gap-1.5 ml-auto">
              <RotateCcw className="size-3.5" />
              重试
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Loading */}
      {loading && (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      )}

      {/* Empty */}
      {!loading && !error && entries.length === 0 && (
        <EmptyState
          icon={hasFilters ? PackageOpen : ScrollText}
          title={hasFilters ? "无匹配的审计记录" : "暂无审计记录"}
          description={hasFilters ? "尝试调整过滤条件" : "资源操作后将在此显示审计记录"}
        />
      )}

      {/* Table */}
      {!loading && !error && entries.length > 0 && (
        <AuditTable entries={entries} />
      )}
    </div>
  )
}
