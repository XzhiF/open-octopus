"use client"

import { useState, useEffect, useCallback } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { getArchiveStats, getCostTrends, getWorkflowStats } from "@/lib/archive-api"
import type { ArchiveStats, CostTrend, WorkflowStat } from "@/lib/archive-api"

export default function LoopDashboardPage() {
  const [stats, setStats] = useState<ArchiveStats | null>(null)
  const [trends, setTrends] = useState<CostTrend[]>([])
  const [workflows, setWorkflows] = useState<WorkflowStat[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [statsRes, trendsRes, wfRes] = await Promise.allSettled([
        getArchiveStats(),
        getCostTrends("30d"),
        getWorkflowStats(),
      ])
      if (statsRes.status === "fulfilled") setStats(statsRes.value)
      if (trendsRes.status === "fulfilled") setTrends(trendsRes.value.data)
      if (wfRes.status === "fulfilled") setWorkflows(wfRes.value.data)
      if (statsRes.status === "rejected" && trendsRes.status === "rejected" && wfRes.status === "rejected") {
        setError("数据加载失败")
      }
    } catch {
      setError("数据加载失败")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  const isEmpty = !loading && !error && (stats?.total_executions ?? 0) === 0

  return (
    <div className="container mx-auto py-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Loop Dashboard</h1>
          <p className="text-muted-foreground text-sm">归档数据概览 — 执行统计、成本趋势、工作流分析</p>
        </div>
        {error && (
          <Button onClick={fetchData} variant="outline" size="sm">重试</Button>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {isEmpty && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <h2 className="text-lg font-semibold">暂无归档数据</h2>
          <p className="text-muted-foreground mt-2 max-w-md">
            执行完成后数据将自动归档。归档数据在工作空间删除后仍然保留。
          </p>
        </div>
      )}

      {!isEmpty && (
        <>
          {/* Health Overview */}
          <section>
            <h2 className="text-lg font-semibold mb-3">健康度概览</h2>
            {loading ? (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[1,2,3,4].map(i => <Skeleton key={i} className="h-24 rounded-lg" />)}
              </div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">总执行数</CardTitle></CardHeader>
                  <CardContent><div className="text-2xl font-bold">{stats?.total_executions ?? 0}</div></CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">成功率</CardTitle></CardHeader>
                  <CardContent><div className="text-2xl font-bold">{((stats?.success_rate ?? 0) * 100).toFixed(1)}%</div></CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">平均耗时</CardTitle></CardHeader>
                  <CardContent><div className="text-2xl font-bold">{((stats?.avg_duration_ms ?? 0) / 1000).toFixed(1)}s</div></CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">总成本</CardTitle></CardHeader>
                  <CardContent><div className="text-2xl font-bold">${(stats?.total_cost ?? 0).toFixed(2)}</div></CardContent>
                </Card>
              </div>
            )}
          </section>

          {/* Cost Trend */}
          <section>
            <h2 className="text-lg font-semibold mb-3">成本趋势 (30天)</h2>
            {loading ? (
              <Skeleton className="h-48 rounded-lg" />
            ) : trends.length === 0 ? (
              <Card><CardContent className="py-8 text-center text-muted-foreground">暂无数据</CardContent></Card>
            ) : (
              <Card>
                <CardContent className="pt-6">
                  <div className="space-y-2">
                    {trends.map(t => (
                      <div key={t.date} className="flex items-center gap-3 text-sm">
                        <span className="w-24 text-muted-foreground">{t.date}</span>
                        <div className="flex-1 bg-muted rounded-full h-4 overflow-hidden">
                          <div
                            className="bg-primary h-full rounded-full"
                            style={{ width: `${Math.min(100, (t.cost / Math.max(...trends.map(x => x.cost))) * 100)}%` }}
                          />
                        </div>
                        <span className="w-20 text-right font-mono">${t.cost.toFixed(2)}</span>
                        <Badge variant="secondary" className="text-xs">{t.execution_count}次</Badge>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </section>

          {/* Workflow Stats */}
          <section>
            <h2 className="text-lg font-semibold mb-3">工作流统计</h2>
            {loading ? (
              <Skeleton className="h-48 rounded-lg" />
            ) : workflows.length === 0 ? (
              <Card><CardContent className="py-8 text-center text-muted-foreground">暂无数据</CardContent></Card>
            ) : (
              <Card>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>工作流</TableHead>
                      <TableHead className="text-right">执行次数</TableHead>
                      <TableHead className="text-right">成功率</TableHead>
                      <TableHead className="text-right">平均耗时</TableHead>
                      <TableHead className="text-right">平均成本</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {workflows.map(wf => (
                      <TableRow key={wf.workflow_name}>
                        <TableCell className="font-medium">{wf.workflow_name}</TableCell>
                        <TableCell className="text-right">{wf.execution_count}</TableCell>
                        <TableCell className="text-right">{(wf.success_rate * 100).toFixed(1)}%</TableCell>
                        <TableCell className="text-right">{(wf.avg_duration_ms / 1000).toFixed(1)}s</TableCell>
                        <TableCell className="text-right">${wf.avg_cost.toFixed(4)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Card>
            )}
          </section>
        </>
      )}
    </div>
  )
}
