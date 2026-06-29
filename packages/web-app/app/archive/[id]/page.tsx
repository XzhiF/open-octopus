"use client"

import { useState, useEffect, use, useCallback } from "react"
import Link from "next/link"
import {
  ArrowLeft,
  Clock,
  DollarSign,
  Calendar,
  AlertTriangle,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
} from "@/components/ui/breadcrumb"
import { toast } from "sonner"
import { fetchArchiveExecution } from "@/lib/archive-api"
import type { ArchiveExecutionDetail } from "@/lib/archive-api"
import { NodeSummaryTable } from "@/components/archive/node-summary-table"
import { TokenPieChart } from "@/components/archive/token-pie-chart"
import { KeyValueTable } from "@/components/archive/key-value-table"
import { LessonsPanel } from "@/components/archive/lessons-panel"
import { ChainRelation } from "@/components/archive/chain-relation"

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

function formatDate(iso: string): string {
  const date = new Date(iso)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  const h = String(date.getHours()).padStart(2, "0")
  const min = String(date.getMinutes()).padStart(2, "0")
  return `${y}-${m}-${d} ${h}:${min}`
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

export default function ArchiveDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const [detail, setDetail] = useState<ArchiveExecutionDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)

  const fetchDetail = useCallback(async () => {
    setLoading(true)
    setError(null)
    setNotFound(false)
    try {
      const data = await fetchArchiveExecution(id)
      setDetail(data)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "获取归档详情失败"
      if (message.includes("404") || message.includes("not found") || message.includes("Not Found")) {
        setNotFound(true)
      } else {
        setError(message)
        toast.error(message)
      }
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    fetchDetail()
  }, [fetchDetail])

  // ---- Loading State ----
  if (loading) {
    return (
      <div className="container mx-auto space-y-6 px-4 py-6 lg:px-6">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href="/archive">
                  <ArrowLeft className="mr-1 h-3.5 w-3.5" />
                  返回执行列表
                </Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="space-y-4">
          <Skeleton className="h-8 w-64" />
          <div className="flex gap-4">
            <Skeleton className="h-6 w-20" />
            <Skeleton className="h-6 w-24" />
            <Skeleton className="h-6 w-16" />
          </div>
          <Skeleton className="h-48 w-full" />
          <div className="grid gap-6 md:grid-cols-3">
            <Skeleton className="h-64" />
            <Skeleton className="col-span-2 h-64" />
          </div>
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    )
  }

  // ---- 404 State ----
  if (notFound) {
    return (
      <div className="container mx-auto space-y-6 px-4 py-6 lg:px-6">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href="/archive">
                  <ArrowLeft className="mr-1 h-3.5 w-3.5" />
                  返回执行列表
                </Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed py-12 text-center">
          <p className="text-muted-foreground">
            归档记录不存在或已被删除
          </p>
          <Link
            href="/archive"
            className="text-primary text-sm underline"
          >
            返回列表
          </Link>
        </div>
      </div>
    )
  }

  // ---- Error State ----
  if (error) {
    return (
      <div className="container mx-auto space-y-6 px-4 py-6 lg:px-6">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href="/archive">
                  <ArrowLeft className="mr-1 h-3.5 w-3.5" />
                  返回执行列表
                </Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed py-12 text-center">
          <AlertTriangle className="h-6 w-6 text-amber-500" />
          <p className="text-destructive text-sm">{error}</p>
          <div className="flex gap-4">
            <button
              onClick={fetchDetail}
              className="text-primary text-sm underline"
            >
              重试
            </button>
            <Link
              href="/archive"
              className="text-muted-foreground text-sm underline"
            >
              返回列表
            </Link>
          </div>
        </div>
      </div>
    )
  }

  if (!detail) return null

  // ---- Success State ----
  const sv = statusVariant(detail.status)

  return (
    <div className="container mx-auto space-y-6 px-4 py-6 lg:px-6">
      {/* Breadcrumb */}
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/archive">
                <ArrowLeft className="mr-1 h-3.5 w-3.5" />
                返回执行列表
              </Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {/* Title */}
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight">
          {detail.workflow_name}
        </h1>
        <Badge variant="outline" className="font-mono text-xs">
          {detail.id.slice(0, 8)}
        </Badge>
      </div>

      {/* Meta Row */}
      <div className="text-muted-foreground flex flex-wrap items-center gap-4 text-sm">
        <Badge variant={sv.variant} className={sv.className}>
          {detail.status}
        </Badge>
        <span className="flex items-center gap-1">
          <Clock className="h-3.5 w-3.5" />
          {formatDuration(detail.duration_ms)}
        </span>
        <span className="flex items-center gap-1">
          <DollarSign className="h-3.5 w-3.5" />
          {formatCost(detail.total_cost_usd)}
        </span>
        <span className="flex items-center gap-1">
          <Calendar className="h-3.5 w-3.5" />
          {formatDate(detail.created_at)}
        </span>
      </div>

      {/* Error message */}
      {detail.error_message && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-4">
          <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
          <p className="text-sm text-destructive">
            {detail.error_message}
          </p>
        </div>
      )}

      {/* Node Summary Table */}
      <NodeSummaryTable nodes={detail.node_summary} />

      {/* Token PieChart + KeyValueTable grid */}
      <div className="grid gap-6 md:grid-cols-3">
        <div className="md:col-span-1">
          <TokenPieChart modelBreakdown={detail.model_breakdown} />
        </div>
        <div className="md:col-span-2">
          <KeyValueTable vars={detail.vars_snapshot} />
        </div>
      </div>

      {/* Lessons Panel */}
      <LessonsPanel
        lessons={detail.lessons_learned}
        experiences={detail.experiences}
      />

      {/* Chain Relation */}
      <ChainRelation
        parentExecutionId={detail.parent_execution_id}
        chainPosition={detail.chain_position}
      />
    </div>
  )
}
