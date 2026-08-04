import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// Mock hooks before importing the component
vi.mock("@/hooks/use-agent-traces", () => ({
  useAgentTraces: vi.fn(),
}))

vi.mock("@/hooks/use-llm-calls", () => ({
  useLLMCalls: vi.fn(),
}))

// Mock child components to isolate the tabs component
vi.mock("@/components/agent-timeline/agent-timeline", () => ({
  AgentTimeline: (props: Record<string, unknown>) => (
    <div data-testid="agent-timeline">
      Timeline: execId={props.executionId as string} nodeId={props.nodeId as string}
    </div>
  ),
}))

vi.mock("@/components/cost-line", () => ({
  CostLine: (props: Record<string, unknown>) => (
    <span data-testid="cost-line">${(props.costUsd as number)?.toFixed(2) ?? "0.00"}</span>
  ),
}))

import { OctopusAgentDetailTabs } from "../octopus-agent-detail-tabs"
import { useAgentTraces } from "@/hooks/use-agent-traces"
import { useLLMCalls } from "@/hooks/use-llm-calls"

const mockUseAgentTraces = vi.mocked(useAgentTraces)
const mockUseLLMCalls = vi.mocked(useLLMCalls)

function setupDefaultMocks() {
  mockUseAgentTraces.mockReturnValue({
    turns: [],
    loading: false,
    error: null,
    isDegraded: false,
  } as any)

  mockUseLLMCalls.mockReturnValue({
    calls: [],
    aggregates: {
      totalCalls: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      totalCost: 0,
      cacheHitRate: 0,
      modelBreakdown: {},
    },
    loading: false,
    error: null,
  } as any)
}

const defaultProps = {
  executionId: "exec-123",
  nodeId: "node-1",
  workspaceId: "ws-1",
  isRunning: false,
}

describe("OctopusAgentDetailTabs", () => {
  it("renders 3 tabs with correct labels", () => {
    setupDefaultMocks()

    render(<OctopusAgentDetailTabs {...defaultProps} />)

    expect(screen.getByRole("tab", { name: "追踪" })).toBeDefined()
    expect(screen.getByRole("tab", { name: "成本" })).toBeDefined()
    expect(screen.getByRole("tab", { name: "信息" })).toBeDefined()
  })

  it("defaults to the traces tab", () => {
    setupDefaultMocks()

    render(<OctopusAgentDetailTabs {...defaultProps} />)

    const tracesTab = screen.getByRole("tab", { name: "追踪" })
    expect(tracesTab.getAttribute("data-state")).toBe("active")
    expect(tracesTab.getAttribute("aria-selected")).toBe("true")
    expect(screen.getByTestId("agent-timeline")).toBeDefined()
  })

  it("switches to cost tab when clicked", async () => {
    const user = userEvent.setup()
    setupDefaultMocks()

    render(<OctopusAgentDetailTabs {...defaultProps} />)

    await user.click(screen.getByRole("tab", { name: "成本" }))

    const costTab = screen.getByRole("tab", { name: "成本" })
    expect(costTab.getAttribute("data-state")).toBe("active")
    expect(screen.getByText("暂无 LLM 调用数据")).toBeDefined()
  })

  it("switches to info tab and shows agent metadata", async () => {
    const user = userEvent.setup()
    setupDefaultMocks()

    render(
      <OctopusAgentDetailTabs
        {...defaultProps}
        agentName="octo-coder"
        version="1.2.3"
        taskBrief="Implement feature X"
      />
    )

    await user.click(screen.getByRole("tab", { name: "信息" }))

    const infoTab = screen.getByRole("tab", { name: "信息" })
    expect(infoTab.getAttribute("data-state")).toBe("active")
    expect(screen.getByText("octo-coder")).toBeDefined()
    expect(screen.getByText("1.2.3")).toBeDefined()
    expect(screen.getByText("Implement feature X")).toBeDefined()
  })

  it('shows "—" fallback when agentName and version are undefined', async () => {
    const user = userEvent.setup()
    setupDefaultMocks()

    render(<OctopusAgentDetailTabs {...defaultProps} />)

    await user.click(screen.getByRole("tab", { name: "信息" }))

    // The component renders "—" (em dash) for missing agentName and version
    const emDashes = screen.getAllByText("—")
    expect(emDashes.length).toBeGreaterThanOrEqual(2)
  })

  it("does not render taskBrief section when taskBrief is undefined", async () => {
    const user = userEvent.setup()
    setupDefaultMocks()

    render(<OctopusAgentDetailTabs {...defaultProps} />)

    await user.click(screen.getByRole("tab", { name: "信息" }))

    const infoTab = screen.getByRole("tab", { name: "信息" })
    expect(infoTab.getAttribute("data-state")).toBe("active")
    expect(screen.queryByText("任务描述:")).toBeNull()
    // Agent and version labels should still be present
    expect(screen.getByText("Agent:")).toBeDefined()
    expect(screen.getByText("版本:")).toBeDefined()
  })

  it("renders cost breakdown when LLM calls exist", async () => {
    const user = userEvent.setup()

    mockUseAgentTraces.mockReturnValue({
      turns: [],
      loading: false,
      error: null,
      isDegraded: false,
    } as any)

    mockUseLLMCalls.mockReturnValue({
      calls: [],
      aggregates: {
        totalCalls: 5,
        totalInputTokens: 1000,
        totalOutputTokens: 500,
        totalCacheReadTokens: 200,
        totalCacheCreationTokens: 100,
        totalCost: 0.05,
        cacheHitRate: 0.4,
        modelBreakdown: {
          "claude-sonnet-4-20250514": { calls: 5, inputTokens: 1000, outputTokens: 500, costUsd: 0.05 },
        },
      },
      loading: false,
      error: null,
    } as any)

    render(<OctopusAgentDetailTabs {...defaultProps} />)

    await user.click(screen.getByRole("tab", { name: "成本" }))

    expect(screen.getByTestId("cost-line")).toBeDefined()
    expect(screen.getByText("claude-sonnet-4-20250514")).toBeDefined()
    expect(screen.getByText("5 calls · $0.05")).toBeDefined()
  })

  it("does not crash with minimal props (no optional fields)", () => {
    setupDefaultMocks()

    const { container } = render(
      <OctopusAgentDetailTabs
        executionId="exec-min"
        nodeId="node-min"
        workspaceId="ws-min"
        isRunning={false}
      />
    )

    expect(container).toBeDefined()
    expect(screen.getByRole("tab", { name: "追踪" })).toBeDefined()
    expect(screen.getByRole("tab", { name: "成本" })).toBeDefined()
    expect(screen.getByRole("tab", { name: "信息" })).toBeDefined()
  })

  it("passes executionId and nodeId to AgentTimeline", () => {
    setupDefaultMocks()

    render(
      <OctopusAgentDetailTabs
        executionId="exec-trace"
        nodeId="node-trace"
        workspaceId="ws-1"
        isRunning={false}
      />
    )

    const timeline = screen.getByTestId("agent-timeline")
    expect(timeline.textContent).toContain("exec-trace")
    expect(timeline.textContent).toContain("node-trace")
  })
})
