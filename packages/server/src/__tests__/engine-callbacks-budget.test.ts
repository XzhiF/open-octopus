// packages/server/src/__tests__/engine-callbacks-budget.test.ts
//
// Tests for ticket 04: SSE execution_metrics + budget warning + budget blocking
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { EngineCallbacks } from "../services/execution/EngineCallbacks"
import type { ExecutionDAO } from "../db/dao/execution-dao"
import type { TokenUsageDAO } from "../db/dao/token-usage-dao"
import type { EnginePool } from "../services/execution/EnginePool"
import type { ObservabilityService } from "../services/observability"
import type { ServiceContext } from "../services/execution/types"

/** Helper: safely override a mock method using defineProperty to avoid vi.fn() collision */
function setMock(obj: any, method: string, returnValue: any) {
  const fn = vi.fn().mockReturnValue(returnValue)
  Object.defineProperty(obj, method, { value: fn, writable: true, configurable: true })
  return fn
}

function makeMocks() {
  const sseEmit = vi.fn()
  const sse = { emit: sseEmit } as any

  const dao = {
    findById: vi.fn().mockReturnValue({
      id: "exec-1",
      status: "running",
      budget_snapshot: null,
      started_at: "2026-08-12T00:00:00.000Z",
      instance_id: "inst-1",
      branch: "main",
      workflow_ref: "test.yaml",
    }),
    updateNodeExecution: vi.fn(),
    updateExecution: vi.fn(),
    updateExecutionProgress: vi.fn(),
    deleteAgentEventsByNode: vi.fn(),
    insertNodeTokenUsage: vi.fn(),
    insertAgentEvent: vi.fn(),
    updateNodeRetryInfo: vi.fn(),
    insertNodeExecutionOrIgnore: vi.fn(),
    replaceMergedEvents: vi.fn(),
  } as unknown as ExecutionDAO

  const tokenUsageDao = {
    aggregateByExecution: vi.fn().mockReturnValue({
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
            totalCostUsd: 0,
      totalLlmTurns: 0,
      errorCount: 0,
    }),
  } as unknown as TokenUsageDAO

  const enginePool = {
    get: vi.fn(() => ({
      engine: { getGlobalSessionId: vi.fn(() => "gsid-1") },
      abortController: { abort: vi.fn() },
    })),
    cancel: vi.fn(),
  } as unknown as EnginePool

  const observability = {
    resetNodeBuffer: vi.fn(),
    resetDegraded: vi.fn(),
    flushNode: vi.fn(),
    persistLLMCalls: vi.fn(),
    bufferEvent: vi.fn(),
  } as unknown as ObservabilityService

  const syncStateJson = vi.fn()

  const ctx: ServiceContext = {
    db: {} as any,
    sse,
    workflowService: {} as any,
    builtInWorkflowService: {} as any,
    org: "test-org",
    workspacePath: "/tmp/test",
    workspaceDbId: "ws-db-1",
  }

  return {
    ctx,
    dao,
    tokenUsageDao,
    enginePool,
    observability,
    syncStateJson,
    sseEmit,
  }
}

function buildCallbacks(mocks: ReturnType<typeof makeMocks>) {
  const builder = new EngineCallbacks({
    ctx: mocks.ctx,
    dao: mocks.dao,
    tokenUsageDao: mocks.tokenUsageDao,
    enginePool: mocks.enginePool,
    observability: mocks.observability,
    workspaceId: "ws-1",
    org: "test-org",
    workspaceDbId: "ws-db-1",
    externalCallbacks: new Map(),
    syncStateJson: mocks.syncStateJson,
  })
  return builder.buildCallbacks("exec-1")
}

const defaultNodeResult = { status: "completed" as const, durationMs: 1000, outputs: {}, logLines: [] }

describe("EngineCallbacks — execution_metrics SSE event", () => {
  let mocks: ReturnType<typeof makeMocks>

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    mocks = makeMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("emits execution_metrics after node_end", () => {
    setMock(mocks.tokenUsageDao, "aggregateByExecution", {
      usage: { inputTokens: 1500, outputTokens: 800, cacheReadTokens: 0, cacheCreationTokens: 0 },
            totalCostUsd: 0.01,
      totalLlmTurns: 3,
      errorCount: 0,
    })

    const callbacks = buildCallbacks(mocks)
    callbacks.onNodeEnd!("node-a", "completed", 1000, defaultNodeResult, "agent")

    vi.advanceTimersByTime(600)

    const metricsEvents = mocks.sseEmit.mock.calls.filter(
      (call: any[]) => call[1]?.event === "execution_metrics"
    )
    expect(metricsEvents.length).toBe(1)
    expect(metricsEvents[0][1].data).toMatchObject({
      executionId: "exec-1",
      usage: { inputTokens: 1500, outputTokens: 800, cacheReadTokens: 0, cacheCreationTokens: 0 },
            totalCostUsd: 0.01,
      totalLlmTurns: 3,
      errorCount: 0,
    })
  })

  it("throttles execution_metrics to max 1 per 500ms", () => {
    setMock(mocks.tokenUsageDao, "aggregateByExecution", {
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
            totalCostUsd: 0.001,
      totalLlmTurns: 1,
      errorCount: 0,
    })

    const callbacks = buildCallbacks(mocks)
    // Fire 3 node_end events rapidly
    callbacks.onNodeEnd!("node-a", "completed", 500, defaultNodeResult, "bash")
    callbacks.onNodeEnd!("node-b", "completed", 300, defaultNodeResult, "bash")
    callbacks.onNodeEnd!("node-c", "completed", 200, defaultNodeResult, "bash")

    vi.advanceTimersByTime(600)

    const metricsEvents = mocks.sseEmit.mock.calls.filter(
      (call: any[]) => call[1]?.event === "execution_metrics"
    )
    // Should emit only once (throttled)
    expect(metricsEvents.length).toBe(1)
  })
})

describe("EngineCallbacks — budget progress", () => {
  let mocks: ReturnType<typeof makeMocks>

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    mocks = makeMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("computes tokensPercent from budget_snapshot", () => {
    setMock(mocks.dao, "findById", {
      id: "exec-1",
      status: "running",
      budget_snapshot: JSON.stringify({ max_tokens: 10000, alert_threshold: 0.8 }),
      started_at: "2026-08-12T00:00:00.000Z",
      instance_id: "inst-1",
      branch: "main",
      workflow_ref: "test.yaml",
    })
    setMock(mocks.tokenUsageDao, "aggregateByExecution", {
      usage: { inputTokens: 5000, outputTokens: 3000, cacheReadTokens: 0, cacheCreationTokens: 0 },
            totalCostUsd: 0.05,
      totalLlmTurns: 5,
      errorCount: 1,
    })

    const callbacks = buildCallbacks(mocks)
    callbacks.onNodeEnd!("node-a", "completed", 1000, defaultNodeResult, "agent")

    vi.advanceTimersByTime(600)

    const metricsEvents = mocks.sseEmit.mock.calls.filter(
      (call: any[]) => call[1]?.event === "execution_metrics"
    )
    expect(metricsEvents.length).toBe(1)
    const budgetProgress = metricsEvents[0][1].data.budgetProgress
    // (5000 + 3000) / 10000 * 100 = 80%
    expect(budgetProgress.tokensPercent).toBe(80)
  })

  it("returns null budgetProgress when no budget_snapshot", () => {
    setMock(mocks.dao, "findById", {
      id: "exec-1",
      status: "running",
      budget_snapshot: null,
      started_at: "2026-08-12T00:00:00.000Z",
      instance_id: "inst-1",
      branch: "main",
      workflow_ref: "test.yaml",
    })
    setMock(mocks.tokenUsageDao, "aggregateByExecution", {
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
            totalCostUsd: 0.001,
      totalLlmTurns: 1,
      errorCount: 0,
    })

    const callbacks = buildCallbacks(mocks)
    callbacks.onNodeEnd!("node-a", "completed", 1000, defaultNodeResult, "bash")

    vi.advanceTimersByTime(600)

    const metricsEvents = mocks.sseEmit.mock.calls.filter(
      (call: any[]) => call[1]?.event === "execution_metrics"
    )
    expect(metricsEvents.length).toBe(1)
    const budgetProgress = metricsEvents[0][1].data.budgetProgress
    expect(budgetProgress.tokensPercent).toBeNull()
    expect(budgetProgress.costPercent).toBeNull()
    expect(budgetProgress.durationPercent).toBeNull()
  })

  it("computes durationPercent from started_at and max_duration", () => {
    // Use fake timers: set system time to 10 seconds after the started_at
    vi.setSystemTime(new Date("2026-08-12T00:00:10.000Z"))

    setMock(mocks.dao, "findById", {
      id: "exec-1",
      status: "running",
      budget_snapshot: JSON.stringify({ max_duration: 20 }), // 20 seconds max
      started_at: "2026-08-12T00:00:00.000Z", // 10 seconds ago
      instance_id: "inst-1",
      branch: "main",
      workflow_ref: "test.yaml",
    })
    setMock(mocks.tokenUsageDao, "aggregateByExecution", {
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
            totalCostUsd: 0,
      totalLlmTurns: 0,
      errorCount: 0,
    })

    const callbacks = buildCallbacks(mocks)
    callbacks.onNodeEnd!("node-a", "completed", 1000, defaultNodeResult, "bash")

    vi.advanceTimersByTime(600)

    const metricsEvents = mocks.sseEmit.mock.calls.filter(
      (call: any[]) => call[1]?.event === "execution_metrics"
    )
    expect(metricsEvents.length).toBe(1)
    const budgetProgress = metricsEvents[0][1].data.budgetProgress
    // ~10 seconds elapsed / 20 seconds max = ~50%
    expect(budgetProgress.durationPercent).toBeGreaterThanOrEqual(49)
    expect(budgetProgress.durationPercent).toBeLessThanOrEqual(55)
  })
})

describe("EngineCallbacks — budget warning", () => {
  let mocks: ReturnType<typeof makeMocks>
  const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    mocks = makeMocks()
    consoleWarnSpy.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("logs warning when tokens exceed alert_threshold", () => {
    setMock(mocks.dao, "findById", {
      id: "exec-1",
      status: "running",
      budget_snapshot: JSON.stringify({ max_tokens: 10000, alert_threshold: 0.8 }),
      started_at: "2026-08-12T00:00:00.000Z",
      instance_id: "inst-1",
      branch: "main",
      workflow_ref: "test.yaml",
    })
    setMock(mocks.tokenUsageDao, "aggregateByExecution", {
      usage: { inputTokens: 5000, outputTokens: 3500, cacheReadTokens: 0, cacheCreationTokens: 0 },
            totalCostUsd: 0.05,
      totalLlmTurns: 5,
      errorCount: 0,
    })

    const callbacks = buildCallbacks(mocks)
    callbacks.onNodeEnd!("node-a", "completed", 1000, defaultNodeResult, "agent")

    vi.advanceTimersByTime(600)

    // total = 8500 > 10000 * 0.8 = 8000 → warning
    const warningCalls = consoleWarnSpy.mock.calls.filter(
      (call: any[]) => String(call.join(" ")).includes("budget") || String(call.join(" ")).includes("Budget")
    )
    expect(warningCalls.length).toBeGreaterThan(0)
  })

  it("does NOT log warning when tokens are below alert_threshold", () => {
    setMock(mocks.dao, "findById", {
      id: "exec-1",
      status: "running",
      budget_snapshot: JSON.stringify({ max_tokens: 10000, alert_threshold: 0.8 }),
      started_at: "2026-08-12T00:00:00.000Z",
      instance_id: "inst-1",
      branch: "main",
      workflow_ref: "test.yaml",
    })
    setMock(mocks.tokenUsageDao, "aggregateByExecution", {
      usage: { inputTokens: 2000, outputTokens: 1000, cacheReadTokens: 0, cacheCreationTokens: 0 },
            totalCostUsd: 0.02,
      totalLlmTurns: 2,
      errorCount: 0,
    })

    const callbacks = buildCallbacks(mocks)
    callbacks.onNodeEnd!("node-a", "completed", 1000, defaultNodeResult, "agent")

    vi.advanceTimersByTime(600)

    // total = 3000 < 10000 * 0.8 = 8000 → no warning
    const warningCalls = consoleWarnSpy.mock.calls.filter(
      (call: any[]) => String(call.join(" ")).includes("budget") || String(call.join(" ")).includes("Budget")
    )
    expect(warningCalls.length).toBe(0)
  })
})

describe("EngineCallbacks — budget blocking (onBeforeNode)", () => {
  let mocks: ReturnType<typeof makeMocks>

  beforeEach(() => {
    mocks = makeMocks()
  })

  it("blocks node execution when tokens exceed max_tokens", async () => {
    setMock(mocks.dao, "findById", {
      id: "exec-1",
      status: "running",
      budget_snapshot: JSON.stringify({ max_tokens: 5000, alert_threshold: 0.8 }),
      started_at: "2026-08-12T00:00:00.000Z",
      instance_id: "inst-1",
      branch: "main",
      workflow_ref: "test.yaml",
    })
    setMock(mocks.tokenUsageDao, "aggregateByExecution", {
      usage: { inputTokens: 3000, outputTokens: 2500, cacheReadTokens: 0, cacheCreationTokens: 0 },
            totalCostUsd: 0.05,
      totalLlmTurns: 5,
      errorCount: 0,
    })

    const callbacks = buildCallbacks(mocks)

    const result = await callbacks.onBeforeNode!("node-b", "agent", { id: "node-b", type: "agent" } as any)

    // total = 5500 > 5000 → blocked
    expect(result.action).toBe("override")
    expect(result.overrideResult?.status).toBe("failed")

    // Should set execution status to budget_exceeded
    const updateCalls = (mocks.dao as any).updateExecution.mock.calls
    const budgetExceededCall = updateCalls.find(
      (call: any[]) => call[1]?.status === "budget_exceeded"
    )
    expect(budgetExceededCall).toBeTruthy()

    // Should emit execution_status SSE event
    const statusEvents = mocks.sseEmit.mock.calls.filter(
      (call: any[]) => call[1]?.event === "execution_status"
    )
    expect(statusEvents.length).toBeGreaterThan(0)
    expect(statusEvents[0][1].data.status).toBe("budget_exceeded")
  })

  it("allows node execution when tokens are within budget", async () => {
    setMock(mocks.dao, "findById", {
      id: "exec-1",
      status: "running",
      budget_snapshot: JSON.stringify({ max_tokens: 10000, alert_threshold: 0.8 }),
      started_at: "2026-08-12T00:00:00.000Z",
      instance_id: "inst-1",
      branch: "main",
      workflow_ref: "test.yaml",
    })
    setMock(mocks.tokenUsageDao, "aggregateByExecution", {
      usage: { inputTokens: 2000, outputTokens: 1000, cacheReadTokens: 0, cacheCreationTokens: 0 },
            totalCostUsd: 0.02,
      totalLlmTurns: 2,
      errorCount: 0,
    })

    const callbacks = buildCallbacks(mocks)

    const result = await callbacks.onBeforeNode!("node-b", "agent", { id: "node-b", type: "agent" } as any)

    // total = 3000 < 10000 → proceed
    expect(result.action).toBe("proceed")
  })

  it("allows node execution when no budget_snapshot exists", async () => {
    // Default mock has budget_snapshot: null
    const callbacks = buildCallbacks(mocks)

    const result = await callbacks.onBeforeNode!("node-b", "agent", { id: "node-b", type: "agent" } as any)

    expect(result.action).toBe("proceed")
  })

  it("cancels engine pool when budget is exceeded", async () => {
    setMock(mocks.dao, "findById", {
      id: "exec-1",
      status: "running",
      budget_snapshot: JSON.stringify({ max_tokens: 1000 }),
      started_at: "2026-08-12T00:00:00.000Z",
      instance_id: "inst-1",
      branch: "main",
      workflow_ref: "test.yaml",
    })
    setMock(mocks.tokenUsageDao, "aggregateByExecution", {
      usage: { inputTokens: 800, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0 },
            totalCostUsd: 0.01,
      totalLlmTurns: 2,
      errorCount: 0,
    })

    const callbacks = buildCallbacks(mocks)
    await callbacks.onBeforeNode!("node-b", "agent", { id: "node-b", type: "agent" } as any)

    // total = 1300 > 1000 → should cancel the engine pool
    expect((mocks.enginePool as any).cancel).toHaveBeenCalledWith("exec-1")
  })
})
