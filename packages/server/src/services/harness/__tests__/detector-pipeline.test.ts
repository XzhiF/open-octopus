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

    expect(originalOnBeforeRetry).toHaveBeenCalledWith("bash-build", 3, { error: "fatal" })
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
  it("onNodeRetry synchronously stores harnessHint from retry_with_hint strategy", () => {
    const strategies: StrategyConfig[] = [
      {
        match: "stupid_retry",
        actions: [{ type: "retry_with_hint", message: "Stop retrying blindly" }],
      },
    ]
    const mockSE = makeMockStrategyEngine(strategies)
    const pipeline = makePipeline({ strategyEngine: mockSE })

    // Seed the detector that will produce a report on nodeRetry
    // We directly test synchronouslyStorePendingAction since onNodeRetry needs
    // a detector to produce a report
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

    // Verify pendingActions was populated synchronously
    const pending = (pipeline as any).pendingActions.get("bash-build")
    expect(pending).toBeDefined()
    expect(pending.harnessHint).toBe("Stop retrying blindly")
    expect(pending.action).toBe("retry")
  })

  it("onNodeRetry synchronously stores modelOverride from switch_model strategy", () => {
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

    const pending = (pipeline as any).pendingActions.get("agent-node")
    expect(pending).toBeDefined()
    expect(pending.modelOverride).toBe("claude-sonnet-4-20250514")
  })

  it("onNodeRetry synchronously stores modelOverride with explicit model", () => {
    const strategies: StrategyConfig[] = [
      {
        match: "model_mismatch",
        actions: [{ type: "switch_model", model: "gpt-4o" }],
      },
    ]
    const mockSE = makeMockStrategyEngine(strategies)
    const pipeline = makePipeline({ strategyEngine: mockSE })

    const report: DiagnosisReport = {
      id: "r3",
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

    const pending = (pipeline as any).pendingActions.get("agent-node")
    expect(pending.modelOverride).toBe("gpt-4o")
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
  it("stores delegate in pendingFailureActions when strategy has delegate_to_agent", () => {
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

    const pending = (pipeline as any).pendingFailureActions.get("node-y")
    expect(pending).toBeDefined()
    expect(pending.action).toBe("delegate")
  })
})
