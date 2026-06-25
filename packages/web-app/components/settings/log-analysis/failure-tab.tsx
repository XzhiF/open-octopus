"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useAnalytics } from "@/hooks/use-analytics"
import { getFailurePatterns } from "@/lib/analytics-client"
import { FragilityRanking } from "./fragility-ranking"
import { FailureChainCard } from "./failure-chain-card"
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts"
import { ChartContainer, ChartTooltipContent } from "@/components/ui/chart"
import { XCircle, CheckCircle2 } from "lucide-react"

const COLORS = ["#ef4444", "#f97316", "#eab308", "#3b82f6", "#8b5cf6", "#6b7280", "#94a3b8"]

export function FailureTab({ workspaceId }: { workspaceId: string }) {

  const { data, loading, error } = useAnalytics(
    (signal) => getFailurePatterns(workspaceId, 30, signal),
    [workspaceId]
  )

  if (loading) {
    return <div className="space-y-6"><Skeleton className="h-64" /><Skeleton className="h-48" /></div>
  }

  if (error) {
    return (
      <Card className="p-12 text-center border-destructive">
        <XCircle className="h-12 w-12 mx-auto text-destructive mb-4" />
        <p className="text-destructive font-medium mb-2">加载失败模式数据失败</p>
        <p className="text-sm text-muted-foreground">{error}</p>
      </Card>
    )
  }

  if (!data) return null

  if (data.errorCategories.length === 0 && data.fragilityRanking.length === 0) {
    return (
      <Card className="p-12 text-center">
        <CheckCircle2 className="h-12 w-12 mx-auto text-muted-foreground mb-4" aria-hidden="true" />
        <p className="text-muted-foreground">最近没有失败记录，一切正常</p>
      </Card>
    )
  }

  const chartConfig = Object.fromEntries(
    data.errorCategories.map((cat, i) => [cat.category, { label: cat.category, color: COLORS[i % COLORS.length] }])
  )

  return (
    <div className="space-y-6">
      {/* 错误分类分布 */}
      <Card>
        <CardHeader><CardTitle className="text-base">错误分类分布</CardTitle></CardHeader>
        <CardContent>
          <div className="flex items-center gap-6">
            {data.errorCategories.length > 0 && (
              <ChartContainer config={chartConfig} className="h-48 w-48 shrink-0">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={data.errorCategories} dataKey="count" nameKey="category" cx="50%" cy="50%" outerRadius={80}>
                      {data.errorCategories.map((_, i) => (
                        <Cell key={i} fill={COLORS[i % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip content={<ChartTooltipContent />} />
                  </PieChart>
                </ResponsiveContainer>
              </ChartContainer>
            )}
            <div className="flex-1 space-y-1">
              {data.errorCategories.map(cat => (
                <div key={cat.category} className="flex items-center justify-between text-sm py-1">
                  <div className="flex items-center gap-2">
                    <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: COLORS[data.errorCategories.indexOf(cat) % COLORS.length] }} />
                    <span>{cat.category}</span>
                  </div>
                  <span className="text-muted-foreground tabular-nums">{cat.count} ({cat.percentage}%)</span>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 脆弱度排行 */}
      <FragilityRanking data={data.fragilityRanking} />

      {/* 失败链 */}
      <FailureChainCard data={data.failureChains} />
    </div>
  )
}
