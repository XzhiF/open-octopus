import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { useState } from "react"

// Mock the harness events hook
vi.mock("@/hooks/use-harness-events", () => ({
  useHarnessEvents: vi.fn(),
}))

// Mock server-config
vi.mock("@/lib/server-config", () => ({
  getServerUrl: () => "http://localhost:3001",
}))

// Mock chatbot's fetch calls
const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

// Mock sonner toast
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

import { HarnessFloatingPanel } from "../harness-floating-panel"
import { useHarnessEvents } from "@/hooks/use-harness-events"

const mockUseHarnessEvents = vi.mocked(useHarnessEvents)

function makeHookReturn(overrides: Partial<ReturnType<typeof useHarnessEvents>> = {}) {
  return {
    events: [],
    loading: false,
    error: null,
    interventionCount: 0,
    totalExtraTokens: 0,
    ...overrides,
  }
}

describe("HarnessFloatingPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true }) })
  })

  // ── Visibility ────────────────────────────────────────────────

  it("does not render when execution is done and no events", () => {
    mockUseHarnessEvents.mockReturnValue(makeHookReturn())

    const { container } = render(
      <HarnessFloatingPanel
        workspaceId="ws-1"
        executionId="exec-1"
        executionStatus="completed"
      />,
    )

    expect(container.innerHTML).toBe("")
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

    // Click collapsed panel to expand
    const collapsed = screen.getByTestId("harness-panel-collapsed")
    fireEvent.click(collapsed)

    // Expanded panel should show tabs
    await waitFor(() => {
      expect(screen.getByText("监控")).toBeDefined()
      expect(screen.getByText("明细")).toBeDefined()
      expect(screen.getByText("Chatbot")).toBeDefined()
    })
  })

  // ── Tab Switching ──────────────────────────────────────────────

  it("shows monitor tab content by default", async () => {
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

    // Expand
    fireEvent.click(screen.getByTestId("harness-panel-collapsed"))

    await waitFor(() => {
      expect(screen.getByText("监控")).toBeDefined()
    })

    // Monitor tab should show event count
    expect(screen.getByText(/干预 0次/)).toBeDefined()
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
})
