"use client"

import { ChartErrorBoundary } from "@/components/ui/chart-error-boundary"

interface HealthRadarProps {
  dimensions: { success: number; speedStability: number; costEfficiency: number; tokenEfficiency: number; reliability: number }
  label?: string
}

const DIMENSIONS = [
  { key: 'success', label: '成功率', weight: 40 },
  { key: 'speedStability', label: '速度稳定性', weight: 20 },
  { key: 'costEfficiency', label: '成本效率', weight: 15 },
  { key: 'tokenEfficiency', label: 'Token效率', weight: 15 },
  { key: 'reliability', label: '可靠性', weight: 10 },
] as const

function polarToCartesian(cx: number, cy: number, r: number, angle: number) {
  const rad = (angle - 90) * Math.PI / 180
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
}

export function HealthRadar({ dimensions, label }: HealthRadarProps) {
  const size = 200
  const cx = size / 2
  const cy = size / 2
  const maxR = 80
  const levels = [0.2, 0.4, 0.6, 0.8, 1.0]

  const points = DIMENSIONS.map((dim, i) => {
    const angle = (360 / DIMENSIONS.length) * i
    const value = (dimensions[dim.key] ?? 0) / 100
    return polarToCartesian(cx, cy, maxR * value, angle)
  })

  const polygonPoints = points.map(p => `${p.x},${p.y}`).join(' ')

  return (
    <ChartErrorBoundary componentName="健康雷达图">
      <div className="flex flex-col items-center">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          {levels.map(level => {
            const pts = DIMENSIONS.map((_, i) => {
              const angle = (360 / DIMENSIONS.length) * i
              return polarToCartesian(cx, cy, maxR * level, angle)
            }).map(p => `${p.x},${p.y}`).join(' ')
            return <polygon key={level} points={pts} fill="none" stroke="currentColor" className="text-border" strokeWidth="0.5" opacity={0.5} />
          })}
          {DIMENSIONS.map((_, i) => {
            const angle = (360 / DIMENSIONS.length) * i
            const end = polarToCartesian(cx, cy, maxR, angle)
            return <line key={i} x1={cx} y1={cy} x2={end.x} y2={end.y} stroke="currentColor" className="text-border" strokeWidth="0.5" />
          })}
          <polygon points={polygonPoints} fill="hsl(var(--primary) / 0.15)" stroke="hsl(var(--primary))" strokeWidth="2" />
          {points.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r="3" fill="hsl(var(--primary))" />
          ))}
          {DIMENSIONS.map((dim, i) => {
            const angle = (360 / DIMENSIONS.length) * i
            const labelPos = polarToCartesian(cx, cy, maxR + 16, angle)
            return (
              <text key={i} x={labelPos.x} y={labelPos.y} textAnchor="middle" dominantBaseline="middle"
                className="fill-muted-foreground text-[10px]">
                {dim.label}
              </text>
            )
          })}
        </svg>
        {label && <p className="text-xs text-muted-foreground mt-1">{label}</p>}
      </div>
    </ChartErrorBoundary>
  )
}
