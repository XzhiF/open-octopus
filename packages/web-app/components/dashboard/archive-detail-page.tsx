"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { ArrowLeft, Clock, Coins, Cpu, GitBranch, BookOpen, AlertCircle } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"
import { formatDuration } from "@/lib/format"
import { cn } from "@/lib/utils"
import { fetchArchiveExecutionDetail } from "@/lib/archive-api"
import { ExperienceCard } from "./experience-card"
import type { ArchiveExecutionDetail as DetailType, ArchiveStatus } from "@octopus/shared"

const statusConfig: Record<ArchiveStatus, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  completed: { label: "完成", variant: "default" },
  completed_with_failures: { label: "部分失败", variant: "secondary" },
  failed: { label: "失败", variant: "destructive" },
  cancelled: { label: "已取消", variant: "outline" },
}

interface ArchiveDetailPageProps {
  executionId: string
}

export function ArchiveDetailPage({ executionId }: ArchiveDetailPageProps) {
  const router = useRouter()
  const [detail, setDetail] = useState<DetailType | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setNotFound(false)
      try {
        const result = await fetchArchiveExecutionDetail(executionId)
        if (!cancelled) setDetail(result)
      } catch (err) {
        if (!cancelled) {
          if (err instanceof Error && err.message.includes("404")) {
            setNotFound(true)
          } else if (err instanceof Error && err.message.includes("not found")) {
            setNotFound(true)
          } else {
            setNotFound(true)
          }
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [executionId])

  if (loading) {
    return (
      <div className="container mx-auto space-y-6 px-4 py-6 lg:px-6" role="region" aria-label="执行详情">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }

  if (notFound || !detail) {
    return (
      <div className="container mx-auto flex flex-col items-center justify-center px-4 py-24 text-center" role="region" aria-label="执行详情">
        <AlertCircle className="h-12 w-12 text-muted-foreground" />
        <h2 className="mt-4 text-lg font-semibold">执行记录未找到</h2>
        <p className="mt-2 text-sm text-muted-foreground">该执行记录可能已被清理或不存在</p>
        <Button variant="outline" className="mt-6" onClick={() => router.push("/?tab=memory")}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          返回执行列表
        </Button>
      </div>
    )
  }

  const cfg = statusConfig[detail.status] ?? { label: detail.status, variant: "outline" as const }

  return (
    <div className="container mx-auto space-y-6 px-4 py-6 lg:px-6" role="region" aria-label="执行详情">
      {/* Back button */}
      <Button variant="ghost" size="sm" onClick={() => router.push("/?tab=memory")}>
        <ArrowLeft className="mr-2 h-4 w-4" />
        返回执行列表
      </Button>

      {/* 1. Basic Info */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              基本信息
            </CardTitle>
            <Badge variant={cfg.variant}>{cfg.label}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div>
              <p className="text-xs text-muted-foreground">工作流</p>
              <p className="text-sm font-medium truncate" title={detail.workflow_name}>{detail.workflow_name}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="h-3 w-3" />耗时</p>
              <p className="text-sm font-medium tabular-nums">{formatDuration(detail.duration_ms ? detail.duration_ms / 1000 : undefined)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground flex items-center gap-1"><Coins className="h-3 w-3" />成本</p>
              <p className="text-sm font-medium tabular-nums">${detail.total_cost_usd.toFixed(4)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground flex items-center gap-1"><Cpu className="h-3 w-3" />Tokens</p>
              <p className="text-sm font-medium tabular-nums">{(detail.total_input_tokens + detail.total_output_tokens).toLocaleString()}</p>
            </div>
          </div>
          {detail.error_message && (
            <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
              <p className="text-xs font-medium text-destructive">错误信息</p>
              <p className="mt-1 text-xs text-destructive/80 font-mono whitespace-pre-wrap break-all">{detail.error_message}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 2. Node Summary */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">节点摘要</CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {detail.node_summary.length === 0 ? (
            <p className="px-6 py-4 text-sm text-muted-foreground text-center">无节点数据</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">节点 ID</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="pr-6 text-right">耗时</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.node_summary.map((node) => {
                  const nodeStatusCfg = statusConfig[node.status as ArchiveStatus] ?? { label: node.status, variant: "outline" as const }
                  return (
                    <TableRow key={node.nodeId}>
                      <TableCell className="pl-6 font-mono text-xs">{node.nodeId}</TableCell>
                      <TableCell className="text-muted-foreground">{node.type}</TableCell>
                      <TableCell>
                        <Badge variant={nodeStatusCfg.variant} className="text-[10px]">{nodeStatusCfg.label}</Badge>
                      </TableCell>
                      <TableCell className="pr-6 text-right tabular-nums text-muted-foreground">
                        {formatDuration(node.duration / 1000)}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* 3. Token Breakdown */}
      {detail.model_breakdown && Object.keys(detail.model_breakdown).length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Token 分布</CardTitle>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">模型</TableHead>
                  <TableHead className="text-right">输入</TableHead>
                  <TableHead className="text-right">输出</TableHead>
                  <TableHead className="pr-6 text-right">成本</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(detail.model_breakdown).map(([model, breakdown]) => (
                  <TableRow key={model}>
                    <TableCell className="pl-6 font-mono text-xs">{model}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{breakdown.input.toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{breakdown.output.toLocaleString()}</TableCell>
                    <TableCell className="pr-6 text-right tabular-nums">${breakdown.cost.toFixed(4)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* 4. Lessons */}
      {detail.lessons.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <BookOpen className="h-4 w-4" />
              经验条目
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {detail.lessons.map((lesson) => (
              <ExperienceCard
                key={lesson.id}
                type={lesson.type}
                title={lesson.title}
                content={lesson.content}
                status={lesson.status}
              />
            ))}
          </CardContent>
        </Card>
      )}

      {/* 5. Chain Info */}
      {(detail.chain.parent_execution_id || detail.chain.children.length > 0) && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <GitBranch className="h-4 w-4" />
              链条信息
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center gap-3">
              {detail.chain.parent_execution_id && (
                <>
                  <button
                    className="rounded-lg border px-3 py-2 text-xs hover:bg-accent transition-colors text-left"
                    onClick={() => router.push(`/dashboard/memory/executions/${detail.chain.parent_execution_id}`)}
                  >
                    <p className="text-muted-foreground">父级</p>
                    <p className="font-mono tabular-nums">{detail.chain.parent_execution_id.slice(0, 12)}</p>
                  </button>
                  <span className="text-muted-foreground">→</span>
                </>
              )}
              <div className={cn("rounded-lg border-2 border-primary px-3 py-2 text-xs")}>
                <p className="text-muted-foreground">当前</p>
                <p className="font-mono tabular-nums font-medium">{detail.id.slice(0, 12)}</p>
              </div>
              {detail.chain.children.length > 0 && (
                <>
                  <span className="text-muted-foreground">→</span>
                  {detail.chain.children.map((child) => (
                    <button
                      key={child.id}
                      className="rounded-lg border px-3 py-2 text-xs hover:bg-accent transition-colors text-left"
                      onClick={() => router.push(`/dashboard/memory/executions/${child.id}`)}
                    >
                      <p className="text-muted-foreground truncate max-w-[120px]">{child.workflow_name}</p>
                      <p className="font-mono tabular-nums">{child.id.slice(0, 12)}</p>
                    </button>
                  ))}
                </>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
