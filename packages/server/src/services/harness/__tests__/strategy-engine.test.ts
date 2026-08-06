// packages/server/src/services/harness/__tests__/strategy-engine.test.ts
//
// Unit tests for the StrategyEngine (tri-domain router) and ActionRegistry.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { StrategyEngine } from "../strategy-engine"
import { ActionRegistry } from "../action-registry"
import type { DiagnosisReport, StrategyConfig, HarnessSystemConfigParsed } from "@octopus/shared"

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeReport(overrides: Partial<DiagnosisReport> = {}): DiagnosisReport {
  return {
    id: "report-1",
    timestamp: Date.now(),
    detector: "stupid_retry",
    severity: "warning",
    executionId: "exec-1",
    nodeId: "bash-build",
    nodeType: "bash",
    pattern: "stupid_retry",
    evidence: [{ attempt: 2, errorHash: "abc123" }],
    context: { retryCount: 2, nodeDurationMs: 5000, workflowProgress: 0.5 },
    ...overrides,
  }
}

const strategies: StrategyConfig[] = [
  {
    match: "stupid_retry",
    actions: [
      { type: "inject_message", message: "Try a different approach." },
      { type: "retry_with_hint" },
    ],
  },
  {
    match: "model_mismatch",
    actions: [{ type: "switch_model", prefer: "vision_capable" }],
  },
  {
    match: "process_conflict",
    severity: "critical",
    actions: [{ type: "abort", reason: "Process conflict detected" }],
  },
  {
    match: "timeout_cascade",
    actions: [{ type: "pause", notify: true }],
  },
  {
    match: "*",
    actions: [{ type: "pause_and_notify" }],
    delegate_to_agent: true,
  },
]

// ─── StrategyEngine.matchStrategy ───────────────────────────────────────────

describe("StrategyEngine — matchStrategy", () => {
  let engine: StrategyEngine
  let mockDao: any
  let mockSse: any

  beforeEach(() => {
    mockDao = { insertEvent: vi.fn(), findEvents: vi.fn().mockReturnValue([]) }
    mockSse = { emit: vi.fn() }
    engine = new StrategyEngine({
      strategies,
      dao: mockDao,
      sse: mockSse,
      workspaceId: "ws-1",
    })
  })

  it("matches exact detector name", () => {
    const report = makeReport({ detector: "stupid_retry" })
    const strategy = engine.matchStrategy(report)
    expect(strategy).not.toBeNull()
    expect(strategy!.match).toBe("stupid_retry")
  })

  it("matches model_mismatch detector", () => {
    const report = makeReport({ detector: "model_mismatch", severity: "warning" })
    const strategy = engine.matchStrategy(report)
    expect(strategy).not.toBeNull()
    expect(strategy!.match).toBe("model_mismatch")
  })

  it("matches process_conflict with severity filter (critical)", () => {
    const report = makeReport({
      detector: "process_conflict",
      severity: "critical",
    })
    const strategy = engine.matchStrategy(report)
    expect(strategy).not.toBeNull()
    expect(strategy!.match).toBe("process_conflict")
  })

  it("does NOT match process_conflict when severity is lower than critical", () => {
    const report = makeReport({
      detector: "process_conflict",
      severity: "warning",
    })
    const strategy = engine.matchStrategy(report)
    // Falls through to wildcard because severity filter doesn't match
    expect(strategy).not.toBeNull()
    expect(strategy!.match).toBe("*")
  })

  it("matches timeout_cascade", () => {
    const report = makeReport({
      detector: "timeout_cascade",
      severity: "critical",
    })
    const strategy = engine.matchStrategy(report)
    expect(strategy).not.toBeNull()
    expect(strategy!.match).toBe("timeout_cascade")
  })

  it("falls back to wildcard strategy for unknown detector", () => {
    const report = makeReport({ detector: "unknown_detector" })
    const strategy = engine.matchStrategy(report)
    expect(strategy).not.toBeNull()
    expect(strategy!.match).toBe("*")
    expect(strategy!.delegate_to_agent).toBe(true)
  })

  it("returns null when no strategy matches and no wildcard exists", () => {
    const noWildcardStrategies: StrategyConfig[] = [
      { match: "stupid_retry", actions: [{ type: "inject_message" }] },
    ]
    const noWildcardEngine = new StrategyEngine({
      strategies: noWildcardStrategies,
      dao: mockDao,
      sse: mockSse,
      workspaceId: "ws-1",
    })

    const report = makeReport({ detector: "unknown_detector" })
    const strategy = noWildcardEngine.matchStrategy(report)
    expect(strategy).toBeNull()
  })

  it("severity ordering: info < warning < critical", () => {
    const warningStrategies: StrategyConfig[] = [
      { match: "test_detector", severity: "warning", actions: [{ type: "pause" }] },
    ]
    const warningEngine = new StrategyEngine({
      strategies: warningStrategies,
      dao: mockDao,
      sse: mockSse,
      workspaceId: "ws-1",
    })

    // info < warning → should NOT match
    const infoReport = makeReport({ detector: "test_detector", severity: "info" })
    expect(warningEngine.matchStrategy(infoReport)).toBeNull()

    // warning = warning → should match
    const warningReport = makeReport({ detector: "test_detector", severity: "warning" })
    expect(warningEngine.matchStrategy(warningReport)).not.toBeNull()

    // critical > warning → should match
    const criticalReport = makeReport({ detector: "test_detector", severity: "critical" })
    expect(warningEngine.matchStrategy(criticalReport)).not.toBeNull()
  })
})

// ─── StrategyEngine.handleReport — tri-domain router ────────────────────────

describe("StrategyEngine — handleReport (tri-domain router)", () => {
  let mockDao: any
  let mockSse: any

  beforeEach(() => {
    mockDao = {
      insertEvent: vi.fn(),
      findEvents: vi.fn().mockReturnValue([]),
      getDb: vi.fn().mockReturnValue({
        prepare: vi.fn().mockReturnValue({
          run: vi.fn(),
          get: vi.fn().mockReturnValue(undefined),
        }),
      }),
    }
    mockSse = { emit: vi.fn() }
  })

  it("AC1: process_conflict + critical → delegate: true, synchronousBlock: true", async () => {
    const engine = new StrategyEngine({
      strategies,
      dao: mockDao,
      sse: mockSse,
      workspaceId: "ws-1",
    })

    const report = makeReport({
      detector: "process_conflict",
      severity: "critical",
    })
    const result = await engine.handleReport(report)

    expect(result.delegate).toBe(true)
    expect(result.synchronousBlock).toBe(true)
    expect(result.matchedStrategy).not.toBeNull()
    expect(result.matchedStrategy!.match).toBe("process_conflict")
    // Should have executed abort action
    expect(result.actionResults.some((r) => r.action === "abort")).toBe(true)
  })

  it("AC2: stupid_retry → delegate: true, no action execution", async () => {
    const engine = new StrategyEngine({
      strategies,
      dao: mockDao,
      sse: mockSse,
      workspaceId: "ws-1",
    })

    const report = makeReport({ detector: "stupid_retry" })
    const result = await engine.handleReport(report)

    expect(result.delegate).toBe(true)
    expect(result.synchronousBlock).toBeUndefined()
    expect(result.actionResults).toHaveLength(0)
  })

  it("AC2: model_mismatch → delegate: true, no action execution", async () => {
    const engine = new StrategyEngine({
      strategies,
      dao: mockDao,
      sse: mockSse,
      workspaceId: "ws-1",
    })

    const report = makeReport({ detector: "model_mismatch", severity: "warning" })
    const result = await engine.handleReport(report)

    expect(result.delegate).toBe(true)
    expect(result.synchronousBlock).toBeUndefined()
    expect(result.actionResults).toHaveLength(0)
  })

  it("AC2: timeout_cascade → delegate: true, no action execution", async () => {
    const engine = new StrategyEngine({
      strategies,
      dao: mockDao,
      sse: mockSse,
      workspaceId: "ws-1",
    })

    const report = makeReport({ detector: "timeout_cascade", severity: "critical" })
    const result = await engine.handleReport(report)

    expect(result.delegate).toBe(true)
    expect(result.synchronousBlock).toBeUndefined()
    expect(result.actionResults).toHaveLength(0)
  })

  it("AC2: unknown detector → delegate: true, no action execution", async () => {
    const engine = new StrategyEngine({
      strategies,
      dao: mockDao,
      sse: mockSse,
      workspaceId: "ws-1",
    })

    const report = makeReport({ detector: "unknown_detector" })
    const result = await engine.handleReport(report)

    expect(result.delegate).toBe(true)
    expect(result.synchronousBlock).toBeUndefined()
    expect(result.actionResults).toHaveLength(0)
  })

  it("process_conflict + critical emits harness_blocked SSE", async () => {
    const engine = new StrategyEngine({
      strategies,
      dao: mockDao,
      sse: mockSse,
      workspaceId: "ws-1",
    })

    const report = makeReport({
      detector: "process_conflict",
      severity: "critical",
      executionId: "exec-42",
      nodeId: "bash-test",
    })
    await engine.handleReport(report)

    const blockedSseCalls = mockSse.emit.mock.calls.filter(
      (call: any[]) => call[1].event === "harness_blocked",
    )
    expect(blockedSseCalls).toHaveLength(1)

    const blockedData = blockedSseCalls[0][1].data
    expect(blockedData.executionId).toBe("exec-42")
    expect(blockedData.nodeId).toBe("bash-test")
    expect(blockedData.reason).toBe("Blocked by harness: process conflict")
    expect(blockedData.pattern).toBe("process_conflict")
  })

  it("process_conflict + critical persists harness_blocked event", async () => {
    const engine = new StrategyEngine({
      strategies,
      dao: mockDao,
      sse: mockSse,
      workspaceId: "ws-1",
    })

    const report = makeReport({
      detector: "process_conflict",
      severity: "critical",
    })
    await engine.handleReport(report)

    const blockedInsertCalls = mockDao.insertEvent.mock.calls.filter(
      (call: any[]) => call[0].event_type === "blocked",
    )
    expect(blockedInsertCalls).toHaveLength(1)

    const blockedRow = blockedInsertCalls[0][0]
    expect(blockedRow.event_type).toBe("blocked")
    expect(blockedRow.detector).toBe("process_conflict")
    expect(blockedRow.severity).toBe("critical")
  })

  it("does NOT emit harness_blocked for non-process_conflict", async () => {
    const customStrategies: StrategyConfig[] = [
      {
        match: "custom_detector",
        actions: [{ type: "abort", reason: "Custom abort" }],
      },
    ]
    const engine = new StrategyEngine({
      strategies: customStrategies,
      dao: mockDao,
      sse: mockSse,
      workspaceId: "ws-1",
    })

    const report = makeReport({
      detector: "custom_detector",
      severity: "critical",
    })
    await engine.handleReport(report)

    const blockedSseCalls = mockSse.emit.mock.calls.filter(
      (call: any[]) => call[1].event === "harness_blocked",
    )
    expect(blockedSseCalls).toHaveLength(0)
  })

  it("process_conflict with non-critical severity → delegate without sync block", async () => {
    const engine = new StrategyEngine({
      strategies,
      dao: mockDao,
      sse: mockSse,
      workspaceId: "ws-1",
    })

    const report = makeReport({
      detector: "process_conflict",
      severity: "warning",
    })
    const result = await engine.handleReport(report)

    expect(result.delegate).toBe(true)
    expect(result.synchronousBlock).toBeUndefined()

    const blockedSseCalls = mockSse.emit.mock.calls.filter(
      (call: any[]) => call[1].event === "harness_blocked",
    )
    expect(blockedSseCalls).toHaveLength(0)
  })
})

// ─── ActionRegistry ─────────────────────────────────────────────────────────

describe("ActionRegistry", () => {
  let registry: ActionRegistry

  beforeEach(() => {
    registry = new ActionRegistry()
  })

  it("AC3: has only abort handler", () => {
    expect(registry.has("abort")).toBe(true)
  })

  it("AC3: does NOT have removed handlers", () => {
    expect(registry.has("inject_message")).toBe(false)
    expect(registry.has("modify_varpool")).toBe(false)
    expect(registry.has("modify_definition")).toBe(false)
    expect(registry.has("switch_model")).toBe(false)
    expect(registry.has("retry_with_hint")).toBe(false)
    expect(registry.has("pause")).toBe(false)
    expect(registry.has("pause_and_notify")).toBe(false)
  })

  it("returns handler for abort action type", () => {
    const handler = registry.get("abort")
    expect(handler).toBeDefined()
    expect(typeof handler).toBe("function")
  })

  it("returns undefined for unknown action type", () => {
    const handler = registry.get("nonexistent_action")
    expect(handler).toBeUndefined()
  })

  it("allows registering custom action handlers", () => {
    const customHandler = vi.fn().mockResolvedValue({
      success: true,
      action: "custom",
      message: "custom action executed",
    })

    registry.register("custom_action", customHandler)

    expect(registry.has("custom_action")).toBe(true)
    expect(registry.get("custom_action")).toBe(customHandler)
  })

  it("executes abort action successfully", async () => {
    const result = await registry.execute({
      report: makeReport(),
      strategyAction: { type: "abort", reason: "Test abort" },
      dao: { insertEvent: vi.fn() } as any,
      sse: { emit: vi.fn() } as any,
      workspaceId: "ws-1",
    })

    expect(result.success).toBe(true)
    expect(result.action).toBe("abort")
    expect(result.message).toBe("Test abort")
  })

  it("returns failure for unregistered action type", async () => {
    const result = await registry.execute({
      report: makeReport(),
      strategyAction: { type: "unknown_action" },
      dao: { insertEvent: vi.fn() } as any,
      sse: { emit: vi.fn() } as any,
      workspaceId: "ws-1",
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain("No handler registered")
  })
})
