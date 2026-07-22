"use client"

import { useMemo } from "react"
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
  Area,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
} from "recharts"
import type { ConsensusDataPoint } from "@/lib/swarm-types"

export interface ConsensusChartTabProps {
  data: ConsensusDataPoint[]
  threshold?: number
}

export function ConsensusChartTab({ data, threshold = 0.8 }: ConsensusChartTabProps) {
  const chartData = useMemo(() => {
    return data.map(d => ({
      round: d.round,
      score: d.score,
      shouldContinue: d.shouldContinue,
    }))
  }, [data])

  if (data.length < 1) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
        等待共识数据...
      </div>
    )
  }

  return (
    <div className="w-full h-[300px]">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.5} />
          <XAxis
            dataKey="round"
            tick={{ fontSize: 12, fill: "var(--muted-foreground)" }}
            tickLine={false}
            label={{ value: "轮次", position: "insideBottom", offset: -5, fontSize: 11, fill: "var(--muted-foreground)" }}
          />
          <YAxis
            domain={[0, 1]}
            tick={{ fontSize: 12, fill: "var(--muted-foreground)" }}
            tickLine={false}
            tickFormatter={(v: number) => v.toFixed(1)}
            label={{ value: "共识分", angle: -90, position: "insideLeft", offset: 10, fontSize: 11, fill: "var(--muted-foreground)" }}
          />
          <RechartsTooltip
            contentStyle={{
              backgroundColor: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              fontSize: "12px",
            }}
            formatter={(value: number) => [value.toFixed(3), "共识分"]}
            labelFormatter={(label: number) => `第 ${label} 轮`}
          />

          {/* Threshold line */}
          <ReferenceLine
            y={threshold}
            stroke="var(--swarm-threshold-line)"
            strokeDasharray="6 3"
            strokeWidth={1.5}
            label={{
              value: `阈值 ${threshold}`,
              position: "right",
              fontSize: 10,
              fill: "var(--swarm-threshold-line)",
            }}
          />

          {/* Area fill under line */}
          <Area
            type="monotone"
            dataKey="score"
            fill="var(--swarm-consensus-area)"
            stroke="none"
          />

          {/* Line */}
          <Line
            type="monotone"
            dataKey="score"
            stroke="var(--swarm-consensus-line)"
            strokeWidth={2}
            dot={{
              fill: "var(--swarm-consensus-dot)",
              stroke: "var(--swarm-consensus-line)",
              strokeWidth: 2,
              r: 4,
            }}
            activeDot={{
              fill: "var(--swarm-consensus-dot)",
              stroke: "var(--swarm-consensus-line)",
              strokeWidth: 2,
              r: 6,
            }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
