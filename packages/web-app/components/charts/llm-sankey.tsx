"use client"

import { useEffect, useRef } from "react"
import { ChartErrorBoundary } from "@/components/ui/chart-error-boundary"

interface LlmSankeyProps {
  data: Array<{
    node: string
    model: string
    stopReason: string
    costUsd: number
  }>
}

export function LlmSankey({ data }: LlmSankeyProps) {
  const svgRef = useRef<SVGSVGElement>(null)

  useEffect(() => {
    if (!data.length || !svgRef.current) return

    const models = [...new Set(data.map(d => d.model))]
    const svg = svgRef.current
    svg.innerHTML = ''

    const width = 400
    const height = 250
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`)

    const totalCost = data.reduce((s, d) => s + d.costUsd, 0)
    const modelCosts = models.map(m => ({
      model: m,
      cost: data.filter(d => d.model === m).reduce((s, d) => s + d.costUsd, 0),
    }))

    let x = 10
    for (const mc of modelCosts) {
      const barHeight = totalCost > 0 ? (mc.cost / totalCost) * (height - 40) : 0
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      rect.setAttribute('x', String(x))
      rect.setAttribute('y', '20')
      rect.setAttribute('width', '60')
      rect.setAttribute('height', String(Math.max(barHeight, 4)))
      rect.setAttribute('fill', 'hsl(var(--primary) / 0.6)')
      rect.setAttribute('rx', '2')
      svg.appendChild(rect)

      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text')
      text.setAttribute('x', String(x + 30))
      text.setAttribute('y', String(20 + Math.max(barHeight, 4) + 14))
      text.setAttribute('text-anchor', 'middle')
      text.setAttribute('class', 'fill-muted-foreground')
      text.setAttribute('font-size', '9')
      text.textContent = mc.model.replace('claude-', '').slice(0, 8)
      svg.appendChild(text)

      x += 80
    }
  }, [data])

  if (data.length === 0) {
    return <div className="text-xs text-muted-foreground">暂无桑基图数据</div>
  }

  return (
    <ChartErrorBoundary componentName="LLM 桑基图">
      <div>
        <svg ref={svgRef} className="w-full h-64" />
      </div>
    </ChartErrorBoundary>
  )
}
