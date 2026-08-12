// packages/server/src/services/harness/__tests__/detector-pipeline.test.ts
//
// Unit tests for DetectorPipeline decision callback interception
// (onBeforeRetry / onFailureDecision / onBeforeNode blocking) and
// pendingActions lifecycle.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { DetectorPipeline } from "../detector-pipeline"
import type { HarnessSystemConfigParsed, StrategyConfig, DiagnosisReport } from "@octopus/shared"
import type { EngineCallbacks } from "@octopus/engine"

// ─── Helpers ────────────────────────────────────────────────────────────────

const minimalConfig: HarnessSystemConfigParsed = {
  detectors: {},
  strategies: [],
  isolation: {
    process_group: false,
    port_protection: false,
    pid_protection: false,
    sandbox: "none",
    fs_whitelist: [],
  },
}

function makePipeline(overrides: Record<string, any> = {}): DetectorPipeline {
  return new DetectorPipeline({
    config: minimalConfig,
    executionId: "exec-test",
    workspaceId: "ws-test",
    dao: { insertEvent: vi.fn() } as any,
    sse: { emit: vi.fn() } as any,
    ...overrides,
  })
}

function makeMockStrategyEngine(strategies: StrategyConfig[] = []) {
  return {
    matchStrategy: vi.fn((report: DiagnosisReport) => {
      // Simple exact-match + wildcard matching (mirrors real StrategyEngine)
      for (const s of strategies) {
        if (s.match === report.detector) return s
      }
      for (const s of strategies) {
        if (s.match === "*") return s
      }
      return null
    }),
    handleReport: vi.fn().mockResolvedValue({
      delegate: false,
      matchedStrategy: null,
      actionResults: [],
    }),
  } as any
}

// ─── onBeforeRetry — pendingActions with harnessHint ─────────────────────────

describe("DetectorPipeline — onBeforeRetry proxy", () => {
  let pipeline: DetectorPipeline

  beforeEach(() => {
    pipeline = makePipeline()
  })

  it("returns stored harnessHint when pendingActions has an entry for the node", async () => {
    (pipeline as any).pendingActions.set("bash-build", {
      action: "retry",
      harnessHint: "Try installing deps first",
    })

    const wrapped = pipeline.wrapCallbacks({})

    const result = await wrapped.onBeforeRetry!("bash-build", 1, { error: "ENOENT" } as any)

    expect(result).toEqual({
      action: "retry",
      harnessHint: "Try installing deps first",
    })
  })

  it("returns stored modelOverride when pendingActions has an entry for the node", async () => {
    (pipeline as any).pendingActions.set("agent-node", {
      action: "retry",
      modelOverride: "vision-model",
    })

    const wrapped = pipeline.wrapCallbacks({})

    const result = await wrapped.onBeforeRetry!("agent-node", 2, { error: "bad output" } as any)

    expect(result).toEqual({
      action: "retry",
      modelOverride: "vision-model",
    })
  })

  it("consumes the pending action (one-shot) so second call falls through", async () => {
    (pipeline as any).pendingActions.set("bash-build", {
      action: "retry",
      harnessHint: "one-shot hint",
    })

    const wrapped = pipeline.wrapCallbacks({})

    const first = await wrapped.onBeforeRetry!("bash-build", 1, {} as any)
    expect(first.harnessHint).toBe("one-shot hint")

    // Second call: pending action consumed, no original callback → default
    const second = await wrapped.onBeforeRetry!("bash-build", 2, {} as any)
    expect(second).toEqual({ action: "retry" })
  })

  it("returns default { action: 'retry' } when pendingActions is empty and no original callback", async () => {
    const wrapped = pipeline.wrapCallbacks({})

    const result = await wrapped.onBeforeRetry!("unknown-node", 1, {} as any)

    expect(result).toEqual({ action: "retry" })
  })

  it("falls back to the original onBeforeRetry callback when pendingActions is empty", async () => {
    const originalOnBeforeRetry = vi.fn().mockResolvedValue({ action: "abort" })
    const wrapped = pipeline.wrapCallbacks({ onBeforeRetry: originalOnBeforeRetry })

    const result = await wrapped.onBeforeRetry!("bash-build", 3, { error: "fatal" } as any)

    expect(originalOnBeforeRetry).toHaveBeenCalledWith("bash-build", 3, { error: "fatal" }, undefined)
    expect(result).toEqual({ action: "abort" })
  })
})

// ─── onFailureDecision — pendingFailureActions ───────────────────────────────

describe("DetectorPipeline — onFailureDecision proxy", () => {
  let pipeline: DetectorPipeline

  beforeEach(() => {
    pipeline = makePipeline()
  })

  it("returns stored decision when pendingFailureActions has an entry", async () => {
    (pipeline as any).pendingFailureActions.set("bash-build", { action: "delegate" })

    const wrapped = pipeline.wrapCallbacks({})

    const result = await wrapped.onFailureDecision!("bash-build", "fatal error", "retry")

    expect(result).toEqual({ action: "delegate" })
  })

  it("consumes the pending failure decision (one-shot)", async () => {
    (pipeline as any).pendingFailureActions.set("bash-build", { action: "abort" })

    const wrapped = pipeline.wrapCallbacks({})

    const first = await wrapped.onFailureDecision!("bash-build", "err", "retry")
    expect(first).toEqual({ action: "abort" })

    const second = await wrapped.onFailureDecision!("bash-build", "err", "retry")
    expect(second).toEqual({ action: "continue" })
  })

  it("returns default { action: 'continue' } when empty and no original callback", async () => {
    const wrapped = pipeline.wrapCallbacks({})

    const result = await wrapped.onFailureDecision!("node-x", "some error", "skip")

    expect(result).toEqual({ action: "continue" })
  })

  it("falls back to the original onFailureDecision when pendingFailureActions is empty", async () => {
    const originalCb = vi.fn().mockResolvedValue({ action: "abort" })
    const wrapped = pipeline.wrapCallbacks({ onFailureDecision: originalCb })

    const result = await wrapped.onFailureDecision!("node-x", "err", "retry")

    expect(originalCb).toHaveBeenCalledWith("node-x", "err", "retry")
    expect(result).toEqual({ action: "abort" })
  })
})

// ─── onNodeEnd cleanup (BP-10) ──────────────────────────────────────────────

describe("DetectorPipeline — onNodeEnd cleanup (BP-10)", () => {
  it("deletes pendingActions, pendingFailureActions, and pendingBlockActions for the ended node", () => {
    let pl = makePipeline()

    // Seed all three maps
    ;(pl as any).pendingActions.set("bash-build", {
      action: "retry",
      harnessHint: "hint",
    })
    ;(pl as any).pendingFailureActions.set("bash-build", {
      action: "delegate",
    })
    ;(pl as any).pendingBlockActions.set("bash-build", {
      action: "skip",
      overrideResult: { status: "failed", error: "Blocked" },
    })
    // Seed a different node to ensure only the target node is cleaned
    ;(pl as any).pendingActions.set("other-node", {
      action: "retry",
      modelOverride: "model-x",
    })

    const wrapped = pl.wrapCallbacks({ onNodeEnd: vi.fn() })

    // Trigger onNodeEnd for bash-build
    wrapped.onNodeEnd!("bash-build", "failed", 1000, undefined, "bash")

    // bash-build entries should all be gone
    expect((pl as any).pendingActions.has("bash-build")).toBe(false)
    expect((pl as any).pendingFailureActions.has("bash-build")).toBe(false)
    expect((pl as any).pendingBlockActions.has("bash-build")).toBe(false)

    // other-node entry should still exist
    expect((pl as any).pendingActions.has("other-node")).toBe(true)
  })

  it("calls the original onNodeEnd callback after cleanup", () => {
    let pl = makePipeline()
    const originalOnNodeEnd = vi.fn()
    const wrapped = pl.wrapCallbacks({ onNodeEnd: originalOnNodeEnd })

    wrapped.onNodeEnd!("node-a", "success", 500, { output: "ok" }, "bash")

    expect(originalOnNodeEnd).toHaveBeenCalledWith(
      "node-a",
      "success",
      500,
      { output: "ok" },
      "bash",
    )
  })
})

// ─── BP-2: Synchronous pending action population in onNodeRetry ──────────────

describe("DetectorPipeline — BP-2 synchronous pending action population", () => {
  it("does NOT store pendingActions for non-process_conflict reports (stupid_retry)", () => {
    const strategies: StrategyConfig[] = [
      {
        match: "stupid_retry",
        actions: [{ type: "retry_with_hint", message: "Stop retrying blindly" }],
      },
    ]
    const mockSE = makeMockStrategyEngine(strategies)
    const pipeline = makePipeline({ strategyEngine: mockSE })

    const report: DiagnosisReport = {
      id: "r1",
      timestamp: Date.now(),
      detector: "stupid_retry",
      severity: "warning",
      executionId: "exec-test",
      nodeId: "bash-build",
      nodeType: "bash",
      pattern: "stupid_retry",
      evidence: [],
      context: { retryCount: 3, nodeDurationMs: 5000, workflowProgress: 0.5 },
    }

    pipeline.synchronouslyStorePendingAction(report)

    // BP-2 removed: non-process_conflict reports are routed to Harness Agent (async)
    expect((pipeline as any).pendingActions.get("bash-build")).toBeUndefined()
  })

  it("does NOT store pendingActions for model_mismatch reports", () => {
    const strategies: StrategyConfig[] = [
      {
        match: "model_mismatch",
        actions: [{ type: "switch_model", prefer: "vision_capable" }],
      },
    ]
    const mockSE = makeMockStrategyEngine(strategies)
    const pipeline = makePipeline({ strategyEngine: mockSE })

    const report: DiagnosisReport = {
      id: "r2",
      timestamp: Date.now(),
      detector: "model_mismatch",
      severity: "warning",
      executionId: "exec-test",
      nodeId: "agent-node",
      nodeType: "agent",
      pattern: "model_mismatch",
      evidence: [],
      context: { retryCount: 0, nodeDurationMs: 3000, workflowProgress: 0.3 },
    }

    pipeline.synchronouslyStorePendingAction(report)

    // BP-2 removed: non-process_conflict reports are routed to Harness Agent (async)
    expect((pipeline as any).pendingActions.get("agent-node")).toBeUndefined()
  })

  it("does nothing when no strategyEngine is set", () => {
    const pipeline = makePipeline() // no strategyEngine

    const report: DiagnosisReport = {
      id: "r4",
      timestamp: Date.now(),
      detector: "stupid_retry",
      severity: "warning",
      executionId: "exec-test",
      nodeId: "bash-build",
      nodeType: "bash",
      pattern: "stupid_retry",
      evidence: [],
      context: { retryCount: 3, nodeDurationMs: 5000, workflowProgress: 0.5 },
    }

    pipeline.synchronouslyStorePendingAction(report)

    expect((pipeline as any).pendingActions.size).toBe(0)
  })

  it("does nothing when no strategy matches", () => {
    const mockSE = makeMockStrategyEngine([]) // no strategies
    const pipeline = makePipeline({ strategyEngine: mockSE })

    const report: DiagnosisReport = {
      id: "r5",
      timestamp: Date.now(),
      detector: "unknown_detector",
      severity: "warning",
      executionId: "exec-test",
      nodeId: "node-x",
      nodeType: "bash",
      pattern: "unknown",
      evidence: [],
      context: { retryCount: 0, nodeDurationMs: 1000, workflowProgress: 0 },
    }

    pipeline.synchronouslyStorePendingAction(report)

    expect((pipeline as any).pendingActions.size).toBe(0)
  })
})

// ─── BP-5: onBeforeNode blocking for CRITICAL process_conflict ───────────────

describe("DetectorPipeline — BP-5 onBeforeNode blocking", () => {
  it("stores pendingBlockAction when CRITICAL report matches abort strategy", () => {
    const strategies: StrategyConfig[] = [
      {
        match: "process_conflict",
        severity: "critical",
        actions: [{ type: "abort", reason: "Process conflict detected" }],
      },
    ]
    const mockSE = makeMockStrategyEngine(strategies)
    const pipeline = makePipeline({ strategyEngine: mockSE })

    const report: DiagnosisReport = {
      id: "r6",
      timestamp: Date.now(),
      detector: "process_conflict",
      severity: "critical",
      executionId: "exec-test",
      nodeId: "bash-danger",
      nodeType: "bash",
      pattern: "process_conflict:pid_conflict",
      evidence: [{ errorMessage: "kill targeting host PID 12345" }],
      context: { retryCount: 0, nodeDurationMs: 0, workflowProgress: 0 },
    }

    pipeline.synchronouslyStorePendingAction(report)

    const blockAction = (pipeline as any).pendingBlockActions.get("bash-danger")
    expect(blockAction).toBeDefined()
    expect(blockAction.action).toBe("skip")
    expect(blockAction.overrideResult.status).toBe("failed")
    expect(blockAction.overrideResult.error).toContain("Blocked by harness")
  })

  it("does NOT store block action for non-critical reports", () => {
    const strategies: StrategyConfig[] = [
      {
        match: "stupid_retry",
        actions: [{ type: "abort", reason: "Too many retries" }],
      },
    ]
    const mockSE = makeMockStrategyEngine(strategies)
    const pipeline = makePipeline({ strategyEngine: mockSE })

    const report: DiagnosisReport = {
      id: "r7",
      timestamp: Date.now(),
      detector: "stupid_retry",
      severity: "warning", // not critical
      executionId: "exec-test",
      nodeId: "bash-build",
      nodeType: "bash",
      pattern: "stupid_retry",
      evidence: [],
      context: { retryCount: 5, nodeDurationMs: 10000, workflowProgress: 0.5 },
    }

    pipeline.synchronouslyStorePendingAction(report)

    expect((pipeline as any).pendingBlockActions.size).toBe(0)
  })

  it("does NOT store block action when strategy has no abort action", () => {
    const strategies: StrategyConfig[] = [
      {
        match: "process_conflict",
        actions: [{ type: "pause", notify: true }], // no abort
      },
    ]
    const mockSE = makeMockStrategyEngine(strategies)
    const pipeline = makePipeline({ strategyEngine: mockSE })

    const report: DiagnosisReport = {
      id: "r8",
      timestamp: Date.now(),
      detector: "process_conflict",
      severity: "critical",
      executionId: "exec-test",
      nodeId: "bash-danger",
      nodeType: "bash",
      pattern: "process_conflict:pid_conflict",
      evidence: [],
      context: { retryCount: 0, nodeDurationMs: 0, workflowProgress: 0 },
    }

    pipeline.synchronouslyStorePendingAction(report)

    expect((pipeline as any).pendingBlockActions.size).toBe(0)
  })
})

// ─── synchronouslyStorePendingAction: delegate_to_agent ──────────────────────

describe("DetectorPipeline — delegate_to_agent synchronous storage", () => {
  it("does NOT store delegate in pendingFailureActions for non-process_conflict reports", () => {
    const strategies: StrategyConfig[] = [
      {
        match: "*",
        actions: [{ type: "pause_and_notify" }],
        delegate_to_agent: true,
      },
    ]
    const mockSE = makeMockStrategyEngine(strategies)
    const pipeline = makePipeline({ strategyEngine: mockSE })

    const report: DiagnosisReport = {
      id: "r9",
      timestamp: Date.now(),
      detector: "timeout_cascade",
      severity: "warning",
      executionId: "exec-test",
      nodeId: "node-y",
      nodeType: "bash",
      pattern: "timeout_cascade",
      evidence: [],
      context: { retryCount: 0, nodeDurationMs: 5000, workflowProgress: 0.2 },
    }

    pipeline.synchronouslyStorePendingAction(report)

    // Non-process_conflict reports are routed to Harness Agent (async), not stored synchronously
    expect((pipeline as any).pendingFailureActions.get("node-y")).toBeUndefined()
  })
})

// ─── AC1-AC3: Decision-based pendingActions storage ───────────────────────────

describe("DetectorPipeline — decision execution (AC1-AC8)", () => {
  function makeMockDb() {
    const stmtMock = { run: vi.fn(), get: vi.fn(), all: vi.fn() }
    return {
      prepare: vi.fn(() => stmtMock),
      _stmtMock: stmtMock,
    }
  }

  function makePipelineWithDb(overrides: Record<string, any> = {}) {
    const mockDb = makeMockDb()
    const dao = {
      insertEvent: vi.fn(),
      getDb: vi.fn(() => mockDb),
      insertHarnessTokenUsage: vi.fn(),
    }
    return {
      pipeline: new DetectorPipeline({
        config: minimalConfig,
        executionId: "exec-test",
        workspaceId: "ws-test",
        dao: dao as any,
        sse: { emit: vi.fn() } as any,
        ...overrides,
      }),
      dao,
      mockDb,
    }
  }

  function makeReport(overrides: Partial<DiagnosisReport> = {}): DiagnosisReport {
    return {
      id: "r-decision",
      timestamp: Date.now(),
      detector: "stupid_retry",
      severity: "warning",
      executionId: "exec-test",
      nodeId: "bash-build",
      nodeType: "bash",
      pattern: "stupid_retry",
      evidence: [],
      context: { retryCount: 3, nodeDurationMs: 5000, workflowProgress: 0.5 },
      ...overrides,
    }
  }

  // AC1: fix_and_retry → varPoolPatches + harnessHint stored in pendingActions
  it("AC1: fix_and_retry stores varPoolPatches + harnessHint in pendingActions", async () => {
    const { pipeline } = makePipelineWithDb()
    const report = makeReport()

    pipeline.processDecision(report, {
      success: true,
      decision: "fix_and_retry",
      varPoolPatches: { PRE_INSTALL: "apt-get install -y jq" },
      harnessHint: "Install jq first",
      reasoning: "Missing jq tool",
    })

    const pending = (pipeline as any).pendingActions.get("bash-build")
    expect(pending).toBeDefined()
    expect(pending.action).toBe("retry")
    expect(pending.varPoolPatches).toEqual({ PRE_INSTALL: "apt-get install -y jq" })
    expect(pending.harnessHint).toBe("Install jq first")
  })

  // AC2: guide_and_retry → harnessHint stored in pendingActions
  it("AC2: guide_and_retry stores harnessHint in pendingActions", async () => {
    const { pipeline } = makePipelineWithDb()
    const report = makeReport()

    pipeline.processDecision(report, {
      success: true,
      decision: "guide_and_retry",
      harnessHint: "Use smaller batches to avoid timeout",
      reasoning: "Batch size too large",
    })

    const pending = (pipeline as any).pendingActions.get("bash-build")
    expect(pending).toBeDefined()
    expect(pending.action).toBe("retry")
    expect(pending.harnessHint).toBe("Use smaller batches to avoid timeout")
    expect(pending.varPoolPatches).toBeUndefined()
  })

  // AC3: reconfigure_and_retry → modelOverride stored in pendingActions
  it("AC3: reconfigure_and_retry stores modelOverride in pendingActions", async () => {
    const { pipeline } = makePipelineWithDb()
    const report = makeReport({ nodeType: "agent", nodeId: "agent-analyze" })

    pipeline.processDecision(report, {
      success: true,
      decision: "reconfigure_and_retry",
      modelOverride: "claude-sonnet-4-20250514",
      reasoning: "Current model lacks vision capability",
    })

    const pending = (pipeline as any).pendingActions.get("agent-analyze")
    expect(pending).toBeDefined()
    expect(pending.action).toBe("retry")
    expect(pending.modelOverride).toBe("claude-sonnet-4-20250514")
  })

  // AC4: agent_takeover → pendingActions + pendingFailureActions with override result
  it("AC4: agent_takeover stores override action in pendingActions and pendingFailureActions", async () => {
    const { pipeline, mockDb } = makePipelineWithDb()
    const report = makeReport()

    pipeline.processDecision(report, {
      success: true,
      decision: "agent_takeover",
      takeoverOutput: "Report generated successfully",
      takeoverExitCode: 0,
      reasoning: "Script too complex to fix, taking over",
    })

    // pendingActions should be set with "override" (for onBeforeRetry)
    const pending = (pipeline as any).pendingActions.get("bash-build")
    expect(pending).toBeDefined()
    expect(pending.action).toBe("override")
    expect(pending.overrideResult.status).toBe("completed")
    expect(pending.overrideResult.outputs.result).toBe("Report generated successfully")

    // pendingFailureActions should also be set with "override" (for onFailureDecision)
    const pendingFailure = (pipeline as any).pendingFailureActions.get("bash-build")
    expect(pendingFailure).toBeDefined()
    expect(pendingFailure.action).toBe("override")
  })

  // AC5: block_node → pendingBlockAction with correct data
  it("AC5: block_node stores pendingBlockAction with block reason", async () => {
    const { pipeline } = makePipelineWithDb()
    const report = makeReport({
      detector: "process_conflict",
      severity: "critical",
    })

    pipeline.processDecision(report, {
      success: true,
      decision: "block_node",
      blockReason: "kill targeting host PID",
      continueSubsequent: false,
      reasoning: "Dangerous process kill",
    })

    const blockAction = (pipeline as any).pendingBlockActions.get("bash-build")
    expect(blockAction).toBeDefined()
    expect(blockAction.action).toBe("skip")
    expect(blockAction.overrideResult.error).toContain("kill targeting host PID")
  })

  // AC6: node_executions.harness_status updated correctly per decision type
  it("AC6: fix_and_retry sets node harness_status to harness_modified", async () => {
    const { pipeline, mockDb } = makePipelineWithDb()
    const report = makeReport()

    pipeline.processDecision(report, {
      success: true,
      decision: "fix_and_retry",
      varPoolPatches: { X: "1" },
      reasoning: "fix it",
    })

    // Check that UPDATE node_executions SET harness_status = 'harness_modified' was called
    const statusUpdates = mockDb.prepare.mock.calls.filter(
      (c: any[]) => typeof c[0] === "string" && c[0].includes("harness_status") && c[0].includes("node_executions")
    )
    expect(statusUpdates.length).toBeGreaterThan(0)
    // The run call should have 'harness_modified' as the first parameter
    const runCalls = mockDb._stmtMock.run.mock.calls
    const harnessModifiedCall = runCalls.find((c: any[]) => c[0] === "harness_modified")
    expect(harnessModifiedCall).toBeDefined()
  })

  it("AC6: agent_takeover sets node harness_status to harness_executed", async () => {
    const { pipeline, mockDb } = makePipelineWithDb()
    const report = makeReport()

    pipeline.processDecision(report, {
      success: true,
      decision: "agent_takeover",
      takeoverOutput: "done",
      takeoverExitCode: 0,
      reasoning: "take over",
    })

    const runCalls = mockDb._stmtMock.run.mock.calls
    const harnessExecutedCall = runCalls.find((c: any[]) => c[0] === "harness_executed")
    expect(harnessExecutedCall).toBeDefined()
  })

  it("AC6: block_node sets node harness_status to harness_blocked", async () => {
    const { pipeline, mockDb } = makePipelineWithDb()
    const report = makeReport()

    pipeline.processDecision(report, {
      success: true,
      decision: "block_node",
      blockReason: "dangerous",
      reasoning: "block it",
    })

    const runCalls = mockDb._stmtMock.run.mock.calls
    const harnessBlockedCall = runCalls.find((c: any[]) => c[0] === "harness_blocked")
    expect(harnessBlockedCall).toBeDefined()
  })

  // AC7: executions.harness_status updated correctly per decision type
  it("AC7: fix_and_retry sets execution harness_status to intervened", async () => {
    const { pipeline, mockDb } = makePipelineWithDb()
    const report = makeReport()

    pipeline.processDecision(report, {
      success: true,
      decision: "fix_and_retry",
      varPoolPatches: { X: "1" },
      reasoning: "fix it",
    })

    // Check UPDATE executions SET harness_status
    const execUpdates = mockDb.prepare.mock.calls.filter(
      (c: any[]) => typeof c[0] === "string" && c[0].includes("UPDATE executions") && c[0].includes("harness_status")
    )
    expect(execUpdates.length).toBeGreaterThan(0)
    const runCalls = mockDb._stmtMock.run.mock.calls
    const intervenedCall = runCalls.find((c: any[]) => c[0] === "intervened")
    expect(intervenedCall).toBeDefined()
  })

  it("AC7: block_node sets execution harness_status to blocked", async () => {
    const { pipeline, mockDb } = makePipelineWithDb()
    const report = makeReport()

    pipeline.processDecision(report, {
      success: true,
      decision: "block_node",
      blockReason: "dangerous",
      reasoning: "block",
    })

    const runCalls = mockDb._stmtMock.run.mock.calls
    const blockedCall = runCalls.find((c: any[]) => c[0] === "blocked")
    expect(blockedCall).toBeDefined()
  })

  it("AC7: agent_takeover sets execution harness_status to delegated", async () => {
    const { pipeline, mockDb } = makePipelineWithDb()
    const report = makeReport()

    pipeline.processDecision(report, {
      success: true,
      decision: "agent_takeover",
      takeoverOutput: "done",
      takeoverExitCode: 0,
      reasoning: "take over",
    })

    const runCalls = mockDb._stmtMock.run.mock.calls
    const delegatedCall = runCalls.find((c: any[]) => c[0] === "delegated")
    expect(delegatedCall).toBeDefined()
  })

  // AC8: agent_events include decision field
  it("AC8: agent_events record includes decision field for log rendering", async () => {
    const { pipeline, mockDb } = makePipelineWithDb()
    const report = makeReport()

    pipeline.processDecision(report, {
      success: true,
      decision: "fix_and_retry",
      varPoolPatches: { X: "1" },
      harnessHint: "install jq",
      reasoning: "missing jq",
    })

    // Check that INSERT INTO agent_events was called
    const insertCalls = mockDb.prepare.mock.calls.filter(
      (c: any[]) => typeof c[0] === "string" && c[0].includes("INSERT INTO agent_events")
    )
    expect(insertCalls.length).toBeGreaterThan(0)

    // Check that some run call has content containing the decision field.
    // The INSERT run params are: (neId, eventOrder, eventType, timestamp, content, contentLength)
    // content is at index 4.
    const runCalls = mockDb._stmtMock.run.mock.calls
    const contentCall = runCalls.find((c: any[]) => {
      // Check all string params for JSON with decision field
      for (const param of c) {
        if (typeof param === "string" && param.includes('"decision"')) {
          try {
            const parsed = JSON.parse(param)
            if (parsed.decision === "fix_and_retry") return true
          } catch {
            // not JSON, continue
          }
        }
      }
      return false
    })
    expect(contentCall).toBeDefined()
  })

  // AC9: bash/python nodes use async/pause domain (no special routing needed in pipeline)
  it("AC9: bash nodes store pendingActions in async domain (pendingActions map)", async () => {
    const { pipeline } = makePipelineWithDb()
    const report = makeReport({ nodeType: "bash" })

    pipeline.processDecision(report, {
      success: true,
      decision: "fix_and_retry",
      varPoolPatches: { X: "1" },
      reasoning: "fix",
    })

    // bash node should use pendingActions (async domain)
    expect((pipeline as any).pendingActions.has("bash-build")).toBe(true)
  })

  it("AC9: python nodes store pendingActions in async domain", async () => {
    const { pipeline } = makePipelineWithDb()
    const report = makeReport({ nodeType: "python", nodeId: "py-script" })

    pipeline.processDecision(report, {
      success: true,
      decision: "guide_and_retry",
      harnessHint: "fix imports",
      reasoning: "import error",
    })

    expect((pipeline as any).pendingActions.has("py-script")).toBe(true)
  })

  // AC10: agent nodes — for non-takeover decisions, still store in pendingActions
  // (Tool Interceptor path is separate, tested in tool-interceptor.test.ts)
  it("AC10: agent nodes with guide_and_retry store in pendingActions", async () => {
    const { pipeline } = makePipelineWithDb()
    const report = makeReport({ nodeType: "agent", nodeId: "agent-test" })

    pipeline.processDecision(report, {
      success: true,
      decision: "guide_and_retry",
      harnessHint: "Use --isolated flag",
      reasoning: "port conflict",
    })

    expect((pipeline as any).pendingActions.has("agent-test")).toBe(true)
    const pending = (pipeline as any).pendingActions.get("agent-test")
    expect(pending.harnessHint).toBe("Use --isolated flag")
  })

  // Failed delegation falls back to block_node
  it("failed delegation stores no pendingActions and updates harness_status to harness_blocked", async () => {
    const { pipeline, mockDb } = makePipelineWithDb()
    const report = makeReport()

    pipeline.processDecision(report, {
      success: false,
      decision: "block_node",
      reasoning: "Agent delegation failed: timeout",
    })

    // No pending retry action should be stored
    expect((pipeline as any).pendingActions.has("bash-build")).toBe(false)

    // Should still update harness_status to harness_blocked (safe default)
    const runCalls = mockDb._stmtMock.run.mock.calls
    const harnessBlockedCall = runCalls.find((c: any[]) => c[0] === "harness_blocked")
    expect(harnessBlockedCall).toBeDefined()
  })
})
