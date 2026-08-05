// packages/server/src/services/harness/__tests__/strategy-engine.test.ts
//
// Unit tests for the StrategyEngine, ActionRegistry, and 5 action implementations.

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

const defaultConfig: HarnessSystemConfigParsed = {
  detectors: {
    stupid_retry: { enabled: true, threshold: 2 },
    model_mismatch: { enabled: true },
    process_conflict: { enabled: true },
    timeout_cascade: { enabled: true, threshold: 3 },
  },
  strategies,
  isolation: {
    process_group: true,
    port_protection: true,
    pid_protection: true,
    sandbox: "auto",
    fs_whitelist: [".", "/tmp"],
  },
}

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
    // A strategy requiring 'warning' severity should match 'warning' and 'critical'
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

// ─── StrategyEngine.executeActions ──────────────────────────────────────────

describe("StrategyEngine — executeActions", () => {
  let engine: StrategyEngine
  let mockDao: any
  let mockSse: any
  let mockRepairService: any

  beforeEach(() => {
    mockDao = { insertEvent: vi.fn(), findEvents: vi.fn().mockReturnValue([]) }
    mockSse = { emit: vi.fn() }
    mockRepairService = {
      intervene: vi.fn().mockResolvedValue({ injected: true }),
      patchVarPool: vi.fn().mockReturnValue({ updated: 1, snapshot: {} }),
      reloadWorkflow: vi.fn().mockReturnValue({ reloaded: true, diff: ["~ node modified: bash-build"] }),
    }
    engine = new StrategyEngine({
      strategies,
      dao: mockDao,
      sse: mockSse,
      workspaceId: "ws-1",
      repairService: mockRepairService,
    })
  })

  it("executes inject_message action and persists result", async () => {
    const report = makeReport({ detector: "stupid_retry" })
    const strategy = engine.matchStrategy(report)!
    const results = await engine.executeActions(report, strategy)

    expect(results).toHaveLength(2) // inject_message + retry_with_hint
    expect(results[0].success).toBe(true)
    expect(results[0].action).toBe("inject_message")
    expect(mockRepairService.intervene).toHaveBeenCalledWith(
      "exec-1",
      "bash-build",
      "Try a different approach.",
    )
  })

  it("executes switch_model action and returns modelOverride", async () => {
    const report = makeReport({
      detector: "model_mismatch",
      nodeId: "agent-read",
      nodeType: "agent",
    })
    const strategy = engine.matchStrategy(report)!
    const results = await engine.executeActions(report, strategy)

    expect(results).toHaveLength(1)
    expect(results[0].success).toBe(true)
    expect(results[0].action).toBe("switch_model")
    expect(results[0].modelOverride).toBeTruthy()
  })

  it("executes abort action", async () => {
    const report = makeReport({
      detector: "process_conflict",
      severity: "critical",
    })
    const strategy = engine.matchStrategy(report)!
    const results = await engine.executeActions(report, strategy)

    expect(results).toHaveLength(1)
    expect(results[0].success).toBe(true)
    expect(results[0].action).toBe("abort")
  })

  it("executes pause action with notify", async () => {
    const report = makeReport({
      detector: "timeout_cascade",
      severity: "critical",
    })
    const strategy = engine.matchStrategy(report)!
    const results = await engine.executeActions(report, strategy)

    expect(results).toHaveLength(1)
    expect(results[0].success).toBe(true)
    expect(results[0].action).toBe("pause")
  })

  it("executes wildcard strategy pause_and_notify", async () => {
    const report = makeReport({ detector: "unknown_detector" })
    const strategy = engine.matchStrategy(report)!
    const results = await engine.executeActions(report, strategy)

    expect(results).toHaveLength(1)
    expect(results[0].success).toBe(true)
    expect(results[0].action).toBe("pause_and_notify")
  })

  it("persists intervention results to harness_events table", async () => {
    const report = makeReport({ detector: "stupid_retry" })
    const strategy = engine.matchStrategy(report)!
    await engine.executeActions(report, strategy)

    // Should persist at least one intervention event
    expect(mockDao.insertEvent).toHaveBeenCalled()
    const insertCall = mockDao.insertEvent.mock.calls[0][0]
    expect(insertCall.event_type).toBe("intervention")
    expect(insertCall.execution_id).toBe("exec-1")
  })

  it("emits SSE harness_intervention event", async () => {
    const report = makeReport({ detector: "stupid_retry" })
    const strategy = engine.matchStrategy(report)!
    await engine.executeActions(report, strategy)

    expect(mockSse.emit).toHaveBeenCalled()
    const sseCall = mockSse.emit.mock.calls[0]
    expect(sseCall[1].event).toBe("harness_intervention")
    expect(sseCall[1].data.executionId).toBe("exec-1")
  })
})

// ─── Delegation fallback ────────────────────────────────────────────────────

describe("StrategyEngine — delegation fallback", () => {
  let mockDao: any
  let mockSse: any

  beforeEach(() => {
    mockDao = { insertEvent: vi.fn(), findEvents: vi.fn().mockReturnValue([]) }
    mockSse = { emit: vi.fn() }
  })

  it("returns delegate: true when no strategy matches", async () => {
    const noStrategiesEngine = new StrategyEngine({
      strategies: [],
      dao: mockDao,
      sse: mockSse,
      workspaceId: "ws-1",
    })

    const report = makeReport({ detector: "unknown_detector" })
    const result = await noStrategiesEngine.handleReport(report)

    expect(result.delegate).toBe(true)
  })

  it("returns delegate: true when wildcard strategy has delegate_to_agent", async () => {
    const wildcardEngine = new StrategyEngine({
      strategies: [
        {
          match: "*",
          actions: [{ type: "pause_and_notify" }],
          delegate_to_agent: true,
        },
      ],
      dao: mockDao,
      sse: mockSse,
      workspaceId: "ws-1",
    })

    const report = makeReport({ detector: "unknown_detector" })
    const result = await wildcardEngine.handleReport(report)

    expect(result.delegate).toBe(true)
    expect(result.actionResults).toHaveLength(1)
  })

  it("does NOT delegate when strategy matched and no delegate_to_agent flag", async () => {
    const noDelegateEngine = new StrategyEngine({
      strategies: [
        {
          match: "stupid_retry",
          actions: [{ type: "inject_message", message: "Try again" }],
          // no delegate_to_agent
        },
      ],
      dao: mockDao,
      sse: mockSse,
      workspaceId: "ws-1",
      repairService: {
        intervene: vi.fn().mockResolvedValue({ injected: true }),
      },
    })

    const report = makeReport({ detector: "stupid_retry" })
    const result = await noDelegateEngine.handleReport(report)

    expect(result.delegate).toBe(false)
    expect(result.actionResults).toHaveLength(1)
  })
})

// ─── ActionRegistry ─────────────────────────────────────────────────────────

describe("ActionRegistry", () => {
  let registry: ActionRegistry

  beforeEach(() => {
    registry = new ActionRegistry()
  })

  it("has built-in handlers for default action types", () => {
    expect(registry.has("inject_message")).toBe(true)
    expect(registry.has("agent_takeover")).toBe(true)
    expect(registry.has("modify_varpool")).toBe(true)
    expect(registry.has("modify_definition")).toBe(true)
    expect(registry.has("switch_model")).toBe(true)
    expect(registry.has("retry_with_hint")).toBe(true)
    expect(registry.has("abort")).toBe(true)
    expect(registry.has("pause")).toBe(true)
    expect(registry.has("pause_and_notify")).toBe(true)
  })

  it("returns handler for known action type", () => {
    const handler = registry.get("inject_message")
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
})

// ─── Action implementations ─────────────────────────────────────────────────

describe("inject_message action", () => {
  it("calls RepairService.intervene with correct arguments", async () => {
    const { injectMessageHandler } = await import("../actions/inject-message")
    const mockRepairService = {
      intervene: vi.fn().mockResolvedValue({ injected: true }),
    }

    const result = await injectMessageHandler({
      report: makeReport({ executionId: "exec-1", nodeId: "bash-build" }),
      strategyAction: { type: "inject_message", message: "Try differently" },
      dao: { insertEvent: vi.fn() } as any,
      sse: { emit: vi.fn() } as any,
      repairService: mockRepairService as any,
      workspaceId: "ws-1",
    })

    expect(result.success).toBe(true)
    expect(result.action).toBe("inject_message")
    expect(mockRepairService.intervene).toHaveBeenCalledWith(
      "exec-1",
      "bash-build",
      "Try differently",
    )
  })

  it("returns failure when no repairService is available", async () => {
    const { injectMessageHandler } = await import("../actions/inject-message")

    const result = await injectMessageHandler({
      report: makeReport(),
      strategyAction: { type: "inject_message", message: "Try" },
      dao: { insertEvent: vi.fn() } as any,
      sse: { emit: vi.fn() } as any,
      workspaceId: "ws-1",
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain("RepairService")
  })

  it("returns failure when message is missing from action config", async () => {
    const { injectMessageHandler } = await import("../actions/inject-message")

    const result = await injectMessageHandler({
      report: makeReport(),
      strategyAction: { type: "inject_message" },
      dao: { insertEvent: vi.fn() } as any,
      sse: { emit: vi.fn() } as any,
      repairService: { intervene: vi.fn() } as any,
      workspaceId: "ws-1",
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain("message")
  })
})

describe("agent_takeover action", () => {
  it("returns stub result with success (ticket 09 will flesh out)", async () => {
    const { agentTakeoverHandler } = await import("../actions/agent-takeover")

    const result = await agentTakeoverHandler({
      report: makeReport(),
      strategyAction: { type: "agent_takeover" },
      dao: { insertEvent: vi.fn() } as any,
      sse: { emit: vi.fn() } as any,
      workspaceId: "ws-1",
    })

    expect(result.success).toBe(true)
    expect(result.action).toBe("agent_takeover")
    expect(result.message).toContain("stub")
  })
})

describe("modify_varpool action", () => {
  it("calls RepairService.patchVarPool with correct key-value", async () => {
    const { modifyVarpoolHandler } = await import("../actions/modify-varpool")
    const mockRepairService = {
      patchVarPool: vi.fn().mockReturnValue({ updated: 1, snapshot: { my_var: "new_value" } }),
    }

    const result = await modifyVarpoolHandler({
      report: makeReport({ executionId: "exec-1" }),
      strategyAction: { type: "modify_varpool", key: "my_var", value: "new_value" },
      dao: { insertEvent: vi.fn() } as any,
      sse: { emit: vi.fn() } as any,
      repairService: mockRepairService as any,
      workspaceId: "ws-1",
    })

    expect(result.success).toBe(true)
    expect(result.action).toBe("modify_varpool")
    expect(mockRepairService.patchVarPool).toHaveBeenCalledWith(
      "exec-1",
      { my_var: "new_value" },
    )
  })

  it("returns failure when no repairService is available", async () => {
    const { modifyVarpoolHandler } = await import("../actions/modify-varpool")

    const result = await modifyVarpoolHandler({
      report: makeReport(),
      strategyAction: { type: "modify_varpool", key: "var", value: "val" },
      dao: { insertEvent: vi.fn() } as any,
      sse: { emit: vi.fn() } as any,
      workspaceId: "ws-1",
    })

    expect(result.success).toBe(false)
  })
})

describe("modify_definition action", () => {
  it("calls RepairService.reloadWorkflow when available", async () => {
    const { modifyDefinitionHandler } = await import("../actions/modify-definition")
    const mockRepairService = {
      reloadWorkflow: vi.fn().mockReturnValue({ reloaded: true, diff: ["~ node modified"] }),
    }

    const result = await modifyDefinitionHandler({
      report: makeReport({ executionId: "exec-1" }),
      strategyAction: {
        type: "modify_definition",
        field: "retry.max_attempts",
        value: 5,
        content: "updated yaml content",
      },
      dao: { insertEvent: vi.fn() } as any,
      sse: { emit: vi.fn() } as any,
      repairService: mockRepairService as any,
      workspaceId: "ws-1",
    })

    expect(result.success).toBe(true)
    expect(result.action).toBe("modify_definition")
    expect(mockRepairService.reloadWorkflow).toHaveBeenCalledWith(
      "exec-1",
      "updated yaml content",
    )
  })

  it("returns failure when no repairService is available", async () => {
    const { modifyDefinitionHandler } = await import("../actions/modify-definition")

    const result = await modifyDefinitionHandler({
      report: makeReport(),
      strategyAction: { type: "modify_definition", field: "retry", value: 5 },
      dao: { insertEvent: vi.fn() } as any,
      sse: { emit: vi.fn() } as any,
      workspaceId: "ws-1",
    })

    expect(result.success).toBe(false)
  })
})

describe("switch_model action", () => {
  it("returns modelOverride for vision_capable preference", async () => {
    const { switchModelHandler } = await import("../actions/switch-model")

    const result = await switchModelHandler({
      report: makeReport(),
      strategyAction: { type: "switch_model", prefer: "vision_capable" },
      dao: { insertEvent: vi.fn() } as any,
      sse: { emit: vi.fn() } as any,
      workspaceId: "ws-1",
    })

    expect(result.success).toBe(true)
    expect(result.action).toBe("switch_model")
    expect(result.modelOverride).toBeTruthy()
    expect(typeof result.modelOverride).toBe("string")
  })

  it("returns modelOverride from explicit model field", async () => {
    const { switchModelHandler } = await import("../actions/switch-model")

    const result = await switchModelHandler({
      report: makeReport(),
      strategyAction: { type: "switch_model", model: "claude-opus-4-20250514" },
      dao: { insertEvent: vi.fn() } as any,
      sse: { emit: vi.fn() } as any,
      workspaceId: "ws-1",
    })

    expect(result.success).toBe(true)
    expect(result.modelOverride).toBe("claude-opus-4-20250514")
  })

  it("defaults to sonnet when no preference or model specified", async () => {
    const { switchModelHandler } = await import("../actions/switch-model")

    const result = await switchModelHandler({
      report: makeReport(),
      strategyAction: { type: "switch_model" },
      dao: { insertEvent: vi.fn() } as any,
      sse: { emit: vi.fn() } as any,
      workspaceId: "ws-1",
    })

    expect(result.success).toBe(true)
    expect(result.modelOverride).toContain("sonnet")
  })
})
