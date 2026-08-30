import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"

// Mock server-config
vi.mock("@/lib/server-config", () => ({
  getServerUrl: () => "http://localhost:3001",
}))

// Mock EventSource
class MockEventSource {
  static instances: MockEventSource[] = []
  url: string
  listeners: Map<string, Array<(e: MessageEvent) => void>> = new Map()
  readyState = 0
  onerror: ((e: Event) => void) | null = null

  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
    // Auto-emit "open" after a microtask, like real EventSource
    Promise.resolve().then(() => {
      const openListeners = this.listeners.get("open") ?? []
      for (const listener of openListeners) {
        listener(new MessageEvent("open") as unknown as MessageEvent)
      }
    })
  }

  addEventListener(type: string, listener: (e: MessageEvent) => void) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, [])
    }
    this.listeners.get(type)!.push(listener)
  }

  removeEventListener(type: string, listener: (e: MessageEvent) => void) {
    const arr = this.listeners.get(type)
    if (arr) {
      const idx = arr.indexOf(listener)
      if (idx >= 0) arr.splice(idx, 1)
    }
  }

  close() {
    this.readyState = 2
  }

  // Test helper: emit a mock SSE event
  emit(type: string, data: unknown) {
    const listeners = this.listeners.get(type) ?? []
    const event = new MessageEvent("message", { data: JSON.stringify(data) })
    for (const listener of listeners) {
      listener(event)
    }
  }
}

// Mock global fetch for the initial observability fetch
const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)
vi.stubGlobal("EventSource", MockEventSource)

import { useExecutionMetrics } from "../use-execution-metrics"

/** Flush all pending microtasks (promises) so state updates settle. */
async function flushPromises() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

describe("useExecutionMetrics", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    MockEventSource.instances = []
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          tokens: { usage: {  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0  }, totals: { tokens: 0, cost: { usd: null, complete: true }, cacheHitRate: null } },
          budget: { snapshot: null, progress: { tokensPercent: null, durationPercent: null, costPercent: null }, alerts: [] },
          errors: [],
          rounds: { totalLlmTurns: 0, totalLoopIterations: 0, totalSwarmRounds: 0, totalRetries: 0 },
        }),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ── AC-1: Subscribes to SSE and filters execution_metrics ───────────

  it("subscribes to /executions/events SSE channel", async () => {
    renderHook(() => useExecutionMetrics("ws-1", "exec-1"))
    await flushPromises()

    expect(MockEventSource.instances.length).toBe(1)
    expect(MockEventSource.instances[0].url).toBe(
      "http://localhost:3001/api/workspaces/ws-1/executions/events",
    )
  })

  it("filters execution_metrics events by executionId", async () => {
    const { result } = renderHook(() => useExecutionMetrics("ws-1", "exec-1"))
    await flushPromises()

    const es = MockEventSource.instances[0]

    // Emit event for a different execution — should be ignored
    act(() => {
      es.emit("execution_metrics", {
        executionId: "exec-other",
        usage: { inputTokens: 999, outputTokens: 888, cacheReadTokens: 0, cacheCreationTokens: 0 },
              totalCostUsd: 0.5,
              totals: { tokens: 1887, cost: { usd: 0.5, complete: true }, cacheHitRate: null },
        totalLlmTurns: 5,
        budgetProgress: { tokensPercent: null, durationPercent: null, costPercent: null },
        errorCount: 0,
        timestamp: new Date().toISOString(),
      })
    })

    expect(result.current.totalTokens).toBe(0)

    // Emit event for the correct execution — should be picked up
    act(() => {
      es.emit("execution_metrics", {
        executionId: "exec-1",
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
              totalCostUsd: 0.01,
              totals: { tokens: 150, cost: { usd: 0.01, complete: true }, cacheHitRate: null },
        totalLlmTurns: 3,
        budgetProgress: { tokensPercent: 10, durationPercent: null, costPercent: null },
        errorCount: 1,
        timestamp: new Date().toISOString(),
      })
    })

    expect(result.current.totalTokens).toBe(150)
  })

  // ── AC-2: Returns correct shape with real-time updates ────────────

  it("passes through server ledger totals (C3: 前端不再自加)", async () => {
    const { result } = renderHook(() => useExecutionMetrics("ws-1", "exec-1"))
    await flushPromises()

    const es = MockEventSource.instances[0]
    act(() => {
      es.emit("execution_metrics", {
        executionId: "exec-1",
        usage: { inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0 },
              totalCostUsd: 0.02,
              totals: { tokens: 300, cost: { usd: 0.02, complete: true }, cacheHitRate: null },
        totalLlmTurns: 5,
        budgetProgress: { tokensPercent: 30, durationPercent: null, costPercent: null },
        errorCount: 0,
        timestamp: new Date().toISOString(),
      })
    })

    expect(result.current.totalTokens).toBe(300) // 200 + 100
    expect(result.current.totalCost).toBe(0.02)
    expect(result.current.totalTurns).toBe(5)
    expect(result.current.errorCount).toBe(0)
    expect(result.current.budgetProgress.tokensPercent).toBe(30)
  })

  it("updates in real-time as new SSE events arrive", async () => {
    const { result } = renderHook(() => useExecutionMetrics("ws-1", "exec-1"))
    await flushPromises()

    const es = MockEventSource.instances[0]

    // First event
    act(() => {
      es.emit("execution_metrics", {
        executionId: "exec-1",
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
              totalCostUsd: 0.01,
              totals: { tokens: 150, cost: { usd: 0.01, complete: true }, cacheHitRate: null },
        totalLlmTurns: 2,
        budgetProgress: { tokensPercent: 15, durationPercent: null, costPercent: null },
        errorCount: 0,
        timestamp: new Date().toISOString(),
      })
    })

    expect(result.current.totalTokens).toBe(150)

    // Second event — cumulative values increase
    act(() => {
      es.emit("execution_metrics", {
        executionId: "exec-1",
        usage: { inputTokens: 300, outputTokens: 150, cacheReadTokens: 0, cacheCreationTokens: 0 },
              totalCostUsd: 0.03,
              totals: { tokens: 450, cost: { usd: 0.03, complete: true }, cacheHitRate: null },
        totalLlmTurns: 5,
        budgetProgress: { tokensPercent: 45, durationPercent: null, costPercent: null },
        errorCount: 1,
        timestamp: new Date().toISOString(),
      })
    })

    expect(result.current.totalTokens).toBe(450)
    expect(result.current.totalTurns).toBe(5)
    expect(result.current.errorCount).toBe(1)
  })

  // ── isConnected state ──────────────────────────────────────────────

  it("reports isConnected as true when SSE is connected", async () => {
    const { result } = renderHook(() => useExecutionMetrics("ws-1", "exec-1"))
    await flushPromises()

    expect(result.current.isConnected).toBe(true)
  })

  // ── Initial fetch from observability API ───────────────────────────

  it("fetches initial state from /executions/:eid/observability on mount", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          tokens: { usage: {  inputTokens: 500, outputTokens: 250, cacheReadTokens: 30, cacheCreationTokens: 20  }, totals: { tokens: 800, cost: { usd: 0.05, complete: true }, cacheHitRate: null } },
          budget: {
            snapshot: { max_tokens: 10000 },
            progress: { tokensPercent: 7.5, durationPercent: null, costPercent: null },
            alerts: [],
          },
          errors: [{ timestamp: "2024-01-01T00:00:00Z", nodeId: "n1", errorType: "timeout" }],
          rounds: { totalLlmTurns: 10, totalLoopIterations: 2, totalSwarmRounds: 0, totalRetries: 1 },
        }),
    })

    const { result } = renderHook(() => useExecutionMetrics("ws-1", "exec-1"))
    await flushPromises()

    // Should have fetched from the observability endpoint
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/workspaces/ws-1/executions/exec-1/observability",
    )

    // Should have populated from historical data
    expect(result.current.totalTokens).toBe(800) // 500 + 250 + 50 (cache)
    expect(result.current.totalCacheReadTokens).toBe(30)
    expect(result.current.totalCacheCreationTokens).toBe(20)
    expect(result.current.totalCost).toBe(0.05)
    expect(result.current.totalTurns).toBe(10)
    expect(result.current.errorCount).toBe(1)
    expect(result.current.budgetProgress.tokensPercent).toBe(7.5)
  })

  // ── SSE overrides initial data ─────────────────────────────────────

  it("SSE events override initial historical data", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          tokens: { usage: {  inputTokens: 500, outputTokens: 250, cacheReadTokens: 30, cacheCreationTokens: 20  }, totals: { tokens: 800, cost: { usd: 0.05, complete: true }, cacheHitRate: null } },
          budget: { snapshot: null, progress: { tokensPercent: null, durationPercent: null, costPercent: null }, alerts: [] },
          errors: [],
          rounds: { totalLlmTurns: 10, totalLoopIterations: 0, totalSwarmRounds: 0, totalRetries: 0 },
        }),
    })

    const { result } = renderHook(() => useExecutionMetrics("ws-1", "exec-1"))
    await flushPromises()

    // Historical data loaded
    expect(result.current.totalTokens).toBe(800) // 500 + 250 + 50 (cache)

    // SSE event arrives with updated cumulative data
    const es = MockEventSource.instances[0]
    act(() => {
      es.emit("execution_metrics", {
        executionId: "exec-1",
        usage: { inputTokens: 800, outputTokens: 400, cacheReadTokens: 0, cacheCreationTokens: 0 },
              totalCostUsd: 0.08,
              totals: { tokens: 1200, cost: { usd: 0.08, complete: true }, cacheHitRate: null },
        totalLlmTurns: 15,
        budgetProgress: { tokensPercent: null, durationPercent: null, costPercent: null },
        errorCount: 0,
        timestamp: new Date().toISOString(),
      })
    })

    // SSE data should override
    expect(result.current.totalTokens).toBe(1200)
    expect(result.current.totalTurns).toBe(15)
  })

  // ── Cleanup ─────────────────────────────────────────────────────────

  it("closes SSE connection on unmount", async () => {
    const { unmount } = renderHook(() => useExecutionMetrics("ws-1", "exec-1"))
    await flushPromises()

    const es = MockEventSource.instances[0]
    expect(es.readyState).not.toBe(2)

    unmount()

    expect(es.readyState).toBe(2) // CLOSED
  })

  // ── Edge: empty executionId ────────────────────────────────────────

  it("does not connect when executionId is empty", async () => {
    renderHook(() => useExecutionMetrics("ws-1", ""))
    await flushPromises()

    expect(MockEventSource.instances.length).toBe(0)
  })
})
