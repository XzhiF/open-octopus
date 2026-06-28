"use client"

import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts"
import { ChartErrorBoundary } from "@/components/ui/chart-error-boundary"
import { formatCostUSD } from "@/lib/cost-format"

interface TokenPieChartProps {
  breakdown: Record<
    string,
    { input_tokens: number; output_tokens: number; cost_usd: number }
  > | null
}

const COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
]

function CustomTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: Array<{ payload: { name: string; input_tokens: number; output_tokens: number; cost_usd: number } }>
}) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div className="rounded-lg border bg-card p-3 shadow-sm text-xs">
      <p className="font-medium">{d.name}</p>
      <p>输入: {d.input_tokens.toLocaleString()} tokens</p>
      <p>输出: {d.output_tokens.toLocaleString()} tokens</p>
      <p className="text-memory-cost-line">{formatCostUSD(d.cost_usd)}</p>
    </div>
  )
}

export function TokenPieChart({ breakdown }: TokenPieChartProps) {
  if (!breakdown || Object.keys(breakdown).length === 0) {
    return (
      <div className="rounded-lg border bg-card p-4 h-full">
        <h3 className="text-sm font-medium mb-3">Token 分布</h3>
        <p className="text-sm text-muted-foreground">无 Token 分布数据</p>
      </div>
    )
  }

  const data = Object.entries(breakdown).map(([model, info]) => ({
    name: model,
    ...info,
    totalTokens: info.input_tokens + info.output_tokens,
  }))

  return (
    <div className="rounded-lg border bg-card p-4 h-full">
      <h3 className="text-sm font-medium mb-3">Token 分布</h3>
      <ChartErrorBoundary>
        <div className="h-[200px]" role="img" aria-label="Token 分布饼图">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                dataKey="totalTokens"
                nameKey="name"
                cx="50%"
                cy="50%"
                outerRadius={80}
              >
                {data.map((_, index) => (
                  <Cell
                    key={index}
                    fill={COLORS[index % COLORS.length]}
                  />
                ))}
              </Pie>
              <Tooltip content={<CustomTooltip />} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </ChartErrorBoundary>
      {/* Legend */}
      <div className="mt-2 space-y-1">
        {data.map((d, i) => (
          <div key={d.name} className="flex items-center gap-2 text-xs">
            <span
              className="h-3 w-3 rounded-sm shrink-0"
              style={{ backgroundColor: COLORS[i % COLORS.length] }}
            />
            <span className="truncate">{d.name}</span>
            <span className="text-muted-foreground ml-auto">
              {formatCostUSD(d.cost_usd)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
