"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts"
import { ChartContainer, ChartTooltipContent } from "@/components/ui/chart"
import type { CostTrendPoint } from "@/lib/analytics-types"

interface CostTrendChartProps {
  data: CostTrendPoint[]
  days: number
}

export function CostTrendChart({ data, days }: CostTrendChartProps) {
  if (data.length === 0) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">成本趋势</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">暂无成本数据</p></CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">成本趋势（最近 {days} 天）</CardTitle></CardHeader>
      <CardContent>
        <ChartContainer config={{ cost: { label: "成本 ($)", color: "hsl(var(--chart-1))" } }} className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="date" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} tickFormatter={v => `$${v}`} />
              <Tooltip content={<ChartTooltipContent />} />
              <Bar dataKey="totalCostUsd" name="成本" fill="var(--color-cost)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}
