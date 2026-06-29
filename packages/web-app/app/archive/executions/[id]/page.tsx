"use client"

import { useState, useEffect } from "react"
import { useParams, useRouter } from "next/navigation"
import {
  getArchiveExecution,
  type ArchiveExecutionDetail,
} from "@/lib/archive-api"
import { formatCostUSD, formatDuration } from "@/lib/cost-format"
import { NodeSummaryTable } from "@/components/archive/node-summary-table"
import { TokenPieChart } from "@/components/archive/token-pie-chart"
import { KeyValueTable } from "@/components/archive/key-value-table"
import { LessonsPanel } from "@/components/archive/lessons-panel"
import { ChainRelation } from "@/components/archive/chain-relation"
import { ArrowLeft, RefreshCw, Archive } from "lucide-react"
import { format } from "date-fns"
import { cn } from "@/lib/utils"

export default function ArchiveExecutionDetailPage() {
  const params = useParams()
  const router = useRouter()
  const id = params.id as string

  const [detail, setDetail] = useState<ArchiveExecutionDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [notFound, setNotFound] = useState(false)

  const fetchData = () => {
    setLoading(true)
    setError(null)
    setNotFound(false)
    getArchiveExecution(id)
      .then(setDetail)
      .catch((err: Error) => {
        if (
          err.message?.includes("404") ||
          err.message?.includes("not found")
        ) {
          setNotFound(true)
        } else {
          setError(err)
        }
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    fetchData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  if (loading) {
    return (
      <div
        className="container mx-auto px-4 py-6 lg:px-6 space-y-6"
        aria-busy="true"
      >
        <button
          onClick={() => router.push("/archive/executions")}
          className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          <ArrowLeft className="h-4 w-4" /> 返回执行列表
        </button>
        <div className="space-y-4">
          <div className="h-8 w-64 rounded bg-muted animate-pulse" />
          <div className="h-4 w-96 rounded bg-muted animate-pulse" />
          <div className="h-48 rounded bg-muted animate-pulse" />
        </div>
      </div>
    )
  }

  if (notFound) {
    return (
      <div className="container mx-auto px-4 py-6 lg:px-6">
        <button
          onClick={() => router.push("/archive/executions")}
          className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mb-6"
        >
          <ArrowLeft className="h-4 w-4" /> 返回执行列表
        </button>
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
          <Archive className="h-12 w-12 text-muted-foreground mb-4" />
          <p className="text-lg font-medium">归档记录不存在</p>
          <p className="text-sm text-muted-foreground mt-1">
            该归档记录不存在或已被删除。
          </p>
          <button
            onClick={() => router.push("/archive/executions")}
            className="mt-4 text-sm text-primary hover:underline"
          >
            返回执行列表
          </button>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="container mx-auto px-4 py-6 lg:px-6">
        <button
          onClick={() => router.push("/archive/executions")}
          className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mb-6"
        >
          <ArrowLeft className="h-4 w-4" /> 返回执行列表
        </button>
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12 text-center">
          <p className="text-sm text-destructive">数据加载失败</p>
          <button
            onClick={fetchData}
            className="mt-2 inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            <RefreshCw className="h-3 w-3" /> 重试
          </button>
        </div>
      </div>
    )
  }

  if (!detail) return null

  const statusLabel =
    detail.status === "completed"
      ? "已完成"
      : detail.status === "failed"
        ? "失败"
        : "已取消"

  return (
    <div className="container mx-auto px-4 py-6 lg:px-6 space-y-6">
      {/* Breadcrumb */}
      <button
        onClick={() => router.push("/archive/executions")}
        className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
      >
        <ArrowLeft className="h-4 w-4" /> 返回执行列表
      </button>

      {/* Header */}
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">{detail.workflow_name}</h1>
          <span className="text-sm text-muted-foreground font-mono">
            #{detail.id.slice(0, 8)}
          </span>
        </div>
        <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground">
          <span
            className={cn(
              "inline-flex items-center gap-1",
              detail.status === "completed"
                ? "text-green-600"
                : detail.status === "failed"
                  ? "text-destructive"
                  : "",
            )}
          >
            {statusLabel}
          </span>
          <span>{formatDuration(detail.duration_ms)}</span>
          <span>{formatCostUSD(detail.total_cost_usd)}</span>
          <span>{format(new Date(detail.started_at), "yyyy-MM-dd HH:mm")}</span>
        </div>
      </div>

      {/* Node Summary */}
      <NodeSummaryTable nodes={detail.node_summary} />

      {/* Token Pie + Key-Value */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1">
          <TokenPieChart breakdown={detail.model_breakdown} />
        </div>
        <div className="lg:col-span-2">
          <KeyValueTable data={detail.vars_snapshot} />
        </div>
      </div>

      {/* Lessons */}
      <LessonsPanel
        lessons={detail.lessons_learned}
        experiences={detail.experiences}
      />

      {/* Chain Relation */}
      {detail.parent_execution_id && (
        <ChainRelation
          parentId={detail.parent_execution_id}
          chainPosition={detail.chain_position}
        />
      )}
    </div>
  )
}
