import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"

// Mock useAnalytics hook
vi.mock("@/hooks/use-analytics", () => ({
  useAnalytics: vi.fn(),
}))

// Mock analytics-client
vi.mock("@/lib/analytics-client", () => ({
  getFailurePatterns: vi.fn(),
  getAnomalies: vi.fn(),
  getCostAnalysis: vi.fn(),
}))

import { useAnalytics } from "@/hooks/use-analytics"
import { FailureTab } from "../failure-tab"
import { AnomalyTab } from "../anomaly-tab"
import { CostTab } from "../cost-tab"

const mockUseAnalytics = vi.mocked(useAnalytics)

describe("Tab 空状态 (R2-M-5)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("失败分析 Tab 空数据显示'没有失败记录'", async () => {
    mockUseAnalytics.mockReturnValue({
      data: { errorCategories: [], fragilityRanking: [], failureChains: [] },
      loading: false,
      error: null,
      refresh: vi.fn(),
    })

    render(<FailureTab workspaceId="ws-test" />)
    await waitFor(() => {
      expect(screen.getByText(/没有失败记录/)).toBeInTheDocument()
    })
  })

  it("异常检测 Tab 空数据显示'未发现异常'", async () => {
    mockUseAnalytics.mockReturnValue({
      data: { durationAnomalies: [], consecutiveFailures: [], costAnomalies: [] },
      loading: false,
      error: null,
      refresh: vi.fn(),
    })

    render(<AnomalyTab workspaceId="ws-test" />)
    await waitFor(() => {
      expect(screen.getByText(/未发现异常/)).toBeInTheDocument()
    })
  })

  it("成本分析 Tab 空数据显示'暂无成本数据'", async () => {
    mockUseAnalytics.mockReturnValue({
      data: { costTrend: [], tokenDistribution: [], costByWorkflow: [] },
      loading: false,
      error: null,
      refresh: vi.fn(),
    })

    render(<CostTab workspaceId="ws-test" />)
    await waitFor(() => {
      expect(screen.getByText(/暂无成本数据/)).toBeInTheDocument()
    })
  })
})
