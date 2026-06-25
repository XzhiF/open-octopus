import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { FragilityRanking } from "../fragility-ranking"
import type { FragilityScore } from "@/lib/analytics-types"

const mockData: FragilityScore[] = [
  { nodeId: "step-03", nodeType: "bash", workflowRef: "wf-a", totalRuns: 12, failures: 8, failureRate: 66.7, fragilityScore: 66.7, avgDurationMs: 5000, lastFailure: "2026-06-04" },
  { nodeId: "climax", nodeType: "agent", workflowRef: "wf-a", totalRuns: 12, failures: 4, failureRate: 33.3, fragilityScore: 33.3, avgDurationMs: 30000, lastFailure: "2026-06-03" },
]

describe("FragilityRanking", () => {
  it("渲染节点排行", () => {
    render(<FragilityRanking data={mockData} />)
    expect(screen.getByText("step-03")).toBeInTheDocument()
    expect(screen.getByText("climax")).toBeInTheDocument()
    expect(screen.getByText("66.7%")).toBeInTheDocument()
  })

  it("空数据时显示空状态", () => {
    render(<FragilityRanking data={[]} />)
    expect(screen.getByText(/暂无失败数据/)).toBeInTheDocument()
  })
})
