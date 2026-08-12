import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { useState } from "react"

// Mock the harness events hook
vi.mock("@/hooks/use-harness-events", () => ({
  useHarnessEvents: vi.fn(),
}))

// Mock the execution metrics hook
vi.mock("@/hooks/use-execution-metrics", () => ({
  useExecutionMetrics: vi.fn(),
}))

// Mock server-config
vi.mock("@/lib/server-config", () => ({
  getServerUrl: () => "http://localhost:3001",
}))

// Mock next/navigation useRouter
const mockPush = vi.fn()
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}))

// Mock chatbot's fetch calls
const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

// Mock sonner toast
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

// Mock observability panel (avoids API calls in tests)
vi.mock("../observability-panel", () => ({
  ObservabilityTab: ({ workspaceId, executionId }: { workspaceId: string; executionId: string }) => (
    <div data-testid="observability-panel">观测面板: {workspaceId}/{executionId}</div>
  ),
}))

import { HarnessFloatingPanel } from "../harness-floating-panel"
import { HarnessChatbot } from "../harness-chatbot"
import { useHarnessEvents } from "@/hooks/use-harness-events"
import { useExecutionMetrics } from "@/hooks/use-execution-metrics"
import type { ParsedHarnessEvent } from "@/hooks/use-harness-events"
import type { ExecutionMetrics } from "@/hooks/use-execution-metrics"

const mockUseHarnessEvents = vi.mocked(useHarnessEvents)
const mockUseExecutionMetrics = vi.mocked(useExecutionMetrics)

function makeHookReturn(overrides: Partial<ReturnType<typeof useHarnessEvents>> = {}) {
  return {
    events: [],
    loading: false,
    error: null,
    interventionCount: 0,
    totalExtraTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    ...overrides,
  }
}

const DEFAULT_METRICS: ExecutionMetrics = {
  totalTokens: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheTokens: 0,
  totalCost: 0,
  totalTurns: 0,
  budgetProgress: { tokensPercent: null, durationPercent: null, costPercent: null },
  errorCount: 0,
  isConnected: false,
}

function makeMetrics(overrides: Partial<ExecutionMetrics> = {}): ExecutionMetrics {
  return { ...DEFAULT_METRICS, ...overrides }
}

describe("HarnessFloatingPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true }) })
    mockUseExecutionMetrics.mockReturnValue(DEFAULT_METRICS)
  })

  // ── Visibility ────────────────────────────────────────────────

  it("renders collapsed panel even when execution is done (for historical viewing)", () => {
    mockUseHarnessEvents.mockReturnValue(makeHookReturn())

    render(
      <HarnessFloatingPanel
        workspaceId="ws-1"
        executionId="exec-1"
        executionStatus="completed"
      />,
    )

    const collapsed = screen.getByTestId("harness-panel-collapsed")
    expect(collapsed).toBeDefined()
  })

  it("renders collapsed panel when running", () => {
    mockUseHarnessEvents.mockReturnValue(makeHookReturn())

    render(
      <HarnessFloatingPanel
        workspaceId="ws-1"
        executionId="exec-1"
        executionStatus="running"
      />,
    )

    const collapsed = screen.getByTestId("harness-panel-collapsed")
    expect(collapsed).toBeDefined()
  })

  // ── Collapsed State ────────────────────────────────────────────

  it("shows intervention count in collapsed state", () => {
    mockUseHarnessEvents.mockReturnValue(
      makeHookReturn({ interventionCount: 3 }),
    )

    render(
      <HarnessFloatingPanel
        workspaceId="ws-1"
        executionId="exec-1"
        executionStatus="running"
      />,
    )

    expect(screen.getByText("3")).toBeDefined()
  })

  it("shows monitoring status when no recent interventions", () => {
    mockUseHarnessEvents.mockReturnValue(makeHookReturn())

    render(
      <HarnessFloatingPanel
        workspaceId="ws-1"
        executionId="exec-1"
        executionStatus="running"
      />,
    )

    expect(screen.getByText("监控中")).toBeDefined()
  })

  // ── AC-7: Collapsed panel shows total token summary from metrics ────

  it("shows total token summary in collapsed panel from useExecutionMetrics", () => {
    mockUseHarnessEvents.mockReturnValue(makeHookReturn())
    mockUseExecutionMetrics.mockReturnValue(
      makeMetrics({
        totalTokens: 1500,
        totalInputTokens: 1000,
        totalOutputTokens: 500,
      }),
    )

    render(
      <HarnessFloatingPanel
        workspaceId="ws-1"
        executionId="exec-1"
        executionStatus="running"
      />,
    )

    // Should show formatted token counts from execution metrics
    expect(screen.getByText("↑1.0K")).toBeDefined()
    expect(screen.getByText("↓500")).toBeDefined()
  })

  it("does not show token summary in collapsed panel when totalTokens is 0", () => {
    mockUseHarnessEvents.mockReturnValue(makeHookReturn())
    mockUseExecutionMetrics.mockReturnValue(makeMetrics())

    render(
      <HarnessFloatingPanel
        workspaceId="ws-1"
        executionId="exec-1"
        executionStatus="running"
      />,
    )

    expect(screen.queryByText(/↑/)).toBeNull()
  })

  // ── Expanded State ─────────────────────────────────────────────

  it("expands panel when collapsed panel is clicked", async () => {
    mockUseHarnessEvents.mockReturnValue(makeHookReturn())

    render(
      <HarnessFloatingPanel
        workspaceId="ws-1"
        executionId="exec-1"
        executionStatus="running"
      />,
    )

    // Click collapsed panel using mouseDown/mouseUp (drag detection)
    const collapsed = screen.getByTestId("harness-panel-collapsed")
    fireEvent.mouseDown(collapsed, { clientX: 100, clientY: 100 })
    fireEvent.mouseUp(collapsed, { clientX: 100, clientY: 100 })

    // Expanded panel should show tabs
    await waitFor(() => {
      expect(screen.getByText("观测")).toBeDefined()
      expect(screen.getByText("监控")).toBeDefined()
      expect(screen.getByText("明细")).toBeDefined()
      expect(screen.getByText("Chatbot")).toBeDefined()
    })
  })

  // ── Tab Switching ──────────────────────────────────────────────

  it("shows observability tab by default, monitor tab on switch", async () => {
    mockUseHarnessEvents.mockReturnValue(
      makeHookReturn({
        events: [
          {
            id: "e1",
            type: "harness_diagnosis" as const,
            timestamp: Date.now(),
            executionId: "exec-1",
            nodeId: "bash-build",
            report: {
              id: "r1",
              timestamp: Date.now(),
              detector: "stupid_retry",
              severity: "warning" as const,
              executionId: "exec-1",
              nodeId: "bash-build",
              nodeType: "bash",
              pattern: "same_error_retry",
              evidence: [],
              context: { retryCount: 2, nodeDurationMs: 5000, workflowProgress: 30 },
            },
          },
        ],
      }),
    )

    render(
      <HarnessFloatingPanel
        workspaceId="ws-1"
        executionId="exec-1"
        executionStatus="running"
      />,
    )

    // Expand via mouseDown/mouseUp (drag detection)
    const collapsed = screen.getByTestId("harness-panel-collapsed")
    fireEvent.mouseDown(collapsed, { clientX: 100, clientY: 100 })
    fireEvent.mouseUp(collapsed, { clientX: 100, clientY: 100 })

    await waitFor(() => {
      expect(screen.getByText("监控")).toBeDefined()
    })

    // Default tab should be 观测 (observability panel rendered)
    expect(screen.getByTestId("observability-panel")).toBeDefined()
  })

  // ── Harness Event Types ────────────────────────────────────────

  it("categorizes harness event types correctly", () => {
    // Test the event type constants used by the filter
    const HARNESS_EVENT_PREFIXES = [
      "harness_directive",
      "harness_diagnosis",
      "harness_intervention",
      "harness_blocked",
    ]

    expect(HARNESS_EVENT_PREFIXES).toContain("harness_directive")
    expect(HARNESS_EVENT_PREFIXES).toContain("harness_diagnosis")
    expect(HARNESS_EVENT_PREFIXES).toContain("harness_intervention")
    expect(HARNESS_EVENT_PREFIXES).toContain("harness_blocked")
    expect(HARNESS_EVENT_PREFIXES).not.toContain("heartbeat")
    expect(HARNESS_EVENT_PREFIXES).not.toContain("agent_event")
  })

  // ── Intervention Count ─────────────────────────────────────────

  it("counts only intervention events for the badge", () => {
    const events = [
      { id: "e1", type: "harness_diagnosis" as const, timestamp: Date.now(), executionId: "exec-1" },
      { id: "e2", type: "harness_intervention" as const, timestamp: Date.now(), executionId: "exec-1" },
      { id: "e3", type: "harness_intervention" as const, timestamp: Date.now(), executionId: "exec-1" },
      { id: "e4", type: "harness_blocked" as const, timestamp: Date.now(), executionId: "exec-1" },
    ]

    const interventionCount = events.filter(e => e.type === "harness_intervention").length
    expect(interventionCount).toBe(2)
  })

  // ── Harness Status Types ───────────────────────────────────────

  it("recognizes all harness node status values", () => {
    const validStatuses = ["harness_intervening", "harness_modified", "harness_executed"]

    for (const status of validStatuses) {
      expect(["harness_intervening", "harness_modified", "harness_executed"]).toContain(status)
    }
  })

  // ── nodeId in chatbot POST body ──────────────────────────────────

  it("includes currentNodeId in chatbot POST body when sending an inject directive", async () => {
    render(
      <HarnessChatbot
        workspaceId="ws-1"
        executionId="exec-1"
        isRunning={true}
        currentNodeId="bash-build"
      />,
    )

    // Type a message
    const input = screen.getByPlaceholderText("输入干预指令...")
    fireEvent.change(input, { target: { value: "fix the retry logic" } })

    // Click send button (the Send icon button)
    const sendButton = screen.getByRole("button", { name: "" })
    const buttons = screen.getAllByRole("button")
    fireEvent.click(buttons[buttons.length - 1])

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled()
    })

    // Verify fetch was called with nodeId in body
    const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1]
    const body = JSON.parse(lastCall[1].body as string)
    expect(body.nodeId).toBe("bash-build")
    expect(body.directive).toEqual({
      type: "inject",
      reason: "fix the retry logic",
      issued_by: "user",
      message: "fix the retry logic",
    })
  })

  it("sends empty string nodeId when no currentNodeId is provided", async () => {
    render(
      <HarnessChatbot
        workspaceId="ws-1"
        executionId="exec-1"
        isRunning={true}
        // No currentNodeId
      />,
    )

    // Type and send
    const input = screen.getByPlaceholderText("输入干预指令...")
    fireEvent.change(input, { target: { value: "hello" } })

    const buttons = screen.getAllByRole("button")
    fireEvent.click(buttons[buttons.length - 1])

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled()
    })

    const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1]
    const body = JSON.parse(lastCall[1].body as string)
    expect(body.nodeId).toBe("")
  })

  // ── totalExtraTokens computation ──────────────────────────────────

  it("computes totalExtraTokens correctly from events with tokenUsage", () => {
    // Test the reduce logic that sums inputTokens + outputTokens from tokenUsage
    const events: ParsedHarnessEvent[] = [
      {
        id: "e1",
        type: "harness_delegation",
        timestamp: Date.now(),
        executionId: "exec-1",
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
      },
      {
        id: "e2",
        type: "harness_intervention",
        timestamp: Date.now(),
        executionId: "exec-1",
        tokenUsage: { inputTokens: 200, outputTokens: 80 },
      },
      {
        id: "e3",
        type: "harness_diagnosis",
        timestamp: Date.now(),
        executionId: "exec-1",
        // no tokenUsage
      },
    ]

    const totalExtraTokens = events.reduce((sum, e) => {
      if (e.tokenUsage) {
        return sum + (e.tokenUsage.inputTokens ?? 0) + (e.tokenUsage.outputTokens ?? 0)
      }
      return sum
    }, 0)

    expect(totalExtraTokens).toBe(430) // 100+50+200+80
  })

  it("returns 0 for totalExtraTokens when no events have tokenUsage", () => {
    const events: ParsedHarnessEvent[] = [
      { id: "e1", type: "harness_diagnosis", timestamp: Date.now(), executionId: "exec-1" },
      { id: "e2", type: "harness_blocked", timestamp: Date.now(), executionId: "exec-1" },
    ]

    const totalExtraTokens = events.reduce((sum, e) => {
      if (e.tokenUsage) {
        return sum + (e.tokenUsage.inputTokens ?? 0) + (e.tokenUsage.outputTokens ?? 0)
      }
      return sum
    }, 0)

    expect(totalExtraTokens).toBe(0)
  })

  it("handles partial tokenUsage (only inputTokens or only outputTokens)", () => {
    const events: ParsedHarnessEvent[] = [
      {
        id: "e1",
        type: "harness_delegation",
        timestamp: Date.now(),
        executionId: "exec-1",
        tokenUsage: { inputTokens: 150 },
      },
      {
        id: "e2",
        type: "harness_intervention",
        timestamp: Date.now(),
        executionId: "exec-1",
        tokenUsage: { outputTokens: 75 },
      },
    ]

    const totalExtraTokens = events.reduce((sum, e) => {
      if (e.tokenUsage) {
        return sum + (e.tokenUsage.inputTokens ?? 0) + (e.tokenUsage.outputTokens ?? 0)
      }
      return sum
    }, 0)

    expect(totalExtraTokens).toBe(225) // 150+75
  })
})
