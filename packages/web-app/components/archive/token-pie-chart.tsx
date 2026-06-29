"use client"

import { PieChart, Pie, Cell } from "recharts"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import {
  ChartContainer,
  type ChartConfig,
} from "@/components/ui/chart"
import { ChartErrorBoundary } from "@/components/ui/chart-error-boundary"

interface ModelData {
  input_tokens: number
  output_tokens: number
  cost_usd: number
}

interface TokenPieChartProps {
  modelBreakdown: Record<string, ModelData> | null
}

const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
]

export function TokenPieChart({ modelBreakdown }: TokenPieChartProps) {
  if (
    !modelBreakdown ||
    Object.keys(modelBreakdown).length === 0
  ) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Token 分布</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-center text-sm">
            无 Token 分布数据
          </p>
        </CardContent>
      </Card>
    )
  }

  const data = Object.entries(modelBreakdown).map(([model, info]) => ({
    name: model,
    value: info.input_tokens + info.output_tokens,
    input: info.input_tokens,
    output: info.output_tokens,
    cost: info.cost_usd,
  }))

  const config: ChartConfig = Object.fromEntries(
    data.map((d, i) => [
      d.name,
      {
        label: d.name,
        color: CHART_COLORS[i % CHART_COLORS.length],
      },
    ]),
  )

  const totalTokens = data.reduce((sum, d) => sum + d.value, 0)
  const totalCost = data.reduce((sum, d) => sum + d.cost, 0)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Token 分布</CardTitle>
      </CardHeader>
      <CardContent>
        <ChartErrorBoundary componentName="TokenPieChart">
          <ChartContainer config={config} className="aspect-square max-h-[250px]">
            <PieChart>
              <Pie
                data={data}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={50}
                strokeWidth={2}
              >
                {data.map((_, index) => (
                  <Cell
                    key={index}
                    fill={CHART_COLORS[index % CHART_COLORS.length]}
                  />
                ))}
              </Pie>
            </PieChart>
          </ChartContainer>
        </ChartErrorBoundary>

        {/* Legend */}
        <div className="mt-4 space-y-2">
          {data.map((d, i) => (
            <div
              key={d.name}
              className="flex items-center justify-between text-xs"
            >
              <div className="flex items-center gap-2">
                <div
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{
                    backgroundColor:
                      CHART_COLORS[i % CHART_COLORS.length],
                  }}
                />
                <span className="truncate">{d.name}</span>
              </div>
              <div className="text-muted-foreground flex shrink-0 gap-3 font-mono">
                <span>{d.value.toLocaleString()} tokens</span>
                <span>${d.cost.toFixed(4)}</span>
              </div>
            </div>
          ))}
          <div className="border-t pt-2 text-xs font-medium">
            <div className="flex justify-between">
              <span>总计</span>
              <div className="text-muted-foreground flex gap-3 font-mono">
                <span>{totalTokens.toLocaleString()} tokens</span>
                <span>${totalCost.toFixed(4)}</span>
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
