// packages/server/src/services/harness/__tests__/detectors.test.ts
//
// Unit tests for the 4 P0 harness detectors (now the signal layer of runtime
// supervision).

import { describe, it, expect, beforeEach, vi } from "vitest"
import { StupidRetryDetector } from "../detectors/stupid-retry"
import { DeterministicErrorDetector } from "../detectors/deterministic-error"
import { ModelMismatchDetector } from "../detectors/model-mismatch"
import { ProcessConflictDetector } from "../detectors/process-conflict"
import { TimeoutCascadeDetector } from "../detectors/timeout-cascade"
import type { HarnessCallbackEvent } from "../base-detector"
import { computeErrorHash } from "@octopus/shared"


// ─── StupidRetryDetector ────────────────────────────────────────────────────

describe("StupidRetryDetector", () => {
  let detector: StupidRetryDetector

  beforeEach(() => {
    detector = new StupidRetryDetector({ threshold: 2 })
  })

  it("returns null on first failed attempt", () => {
    const report = detector.observe({
      type: "nodeRetry",
      nodeId: "bash-build",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1000,
      result: {
        logLines: ["error: Cannot find module 'xyz'"],
        error: "exit code 1",
        outputs: { exitCode: 1 },
      },
    })
    expect(report).toBeNull()
  })

  it("returns DiagnosisReport when threshold reached with same errorHash", () => {
    const result = {
      logLines: ["error: Cannot find module 'xyz'"],
      error: "exit code 1",
      outputs: { exitCode: 1 },
    }

    // First attempt — no trigger
    detector.observe({
      type: "nodeRetry",
      nodeId: "bash-build",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1000,
      result,
    })

    // Second attempt — should trigger (threshold = 2)
    const report = detector.observe({
      type: "nodeRetry",
      nodeId: "bash-build",
      attempt: 2,
      maxAttempts: 3,
      delayMs: 1000,
      result,
    })

    expect(report).not.toBeNull()
    expect(report!.detector).toBe("stupid_retry")
    expect(report!.severity).toBe("warning")
    expect(report!.nodeId).toBe("bash-build")
    expect(report!.pattern).toBe("stupid_retry")
    expect(report!.evidence).toHaveLength(2)
    expect(report!.context.retryCount).toBe(2)
  })

  it("does NOT trigger when errorHash differs between attempts", () => {
    detector.observe({
      type: "nodeRetry",
      nodeId: "bash-build",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1000,
      result: {
        logLines: ["error: Cannot find module 'xyz'"],
        error: "exit code 1",
        outputs: { exitCode: 1 },
      },
    })

    // Different error on second attempt
    const report = detector.observe({
      type: "nodeRetry",
      nodeId: "bash-build",
      attempt: 2,
      maxAttempts: 3,
      delayMs: 1000,
      result: {
        logLines: ["error: Permission denied"],
        error: "exit code 13",
        outputs: { exitCode: 13 },
      },
    })

    expect(report).toBeNull()
  })

  it("tracks separate state per node", () => {
    const result = {
      logLines: ["error: Cannot find module"],
      error: "exit code 1",
      outputs: { exitCode: 1 },
    }

    // Node A attempt 1
    detector.observe({
      type: "nodeRetry",
      nodeId: "node-A",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1000,
      result,
    })

    // Node B attempt 1 — should not trigger (different node)
    const reportB = detector.observe({
      type: "nodeRetry",
      nodeId: "node-B",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1000,
      result,
    })
    expect(reportB).toBeNull()

    // Node A attempt 2 — should trigger
    const reportA = detector.observe({
      type: "nodeRetry",
      nodeId: "node-A",
      attempt: 2,
      maxAttempts: 3,
      delayMs: 1000,
      result,
    })
    expect(reportA).not.toBeNull()
    expect(reportA!.nodeId).toBe("node-A")
  })

  it("reset clears internal state", () => {
    const result = {
      logLines: ["error: fail"],
      error: "exit code 1",
      outputs: { exitCode: 1 },
    }

    detector.observe({
      type: "nodeRetry",
      nodeId: "bash-build",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1000,
      result,
    })

    detector.reset()

    // After reset, attempt 2 should not trigger (state cleared)
    const report = detector.observe({
      type: "nodeRetry",
      nodeId: "bash-build",
      attempt: 2,
      maxAttempts: 3,
      delayMs: 1000,
      result,
    })
    expect(report).toBeNull()
  })

  it("ignores non-nodeRetry events", () => {
    const report = detector.observe({
      type: "nodeStart",
      nodeId: "bash-build",
      nodeType: "bash",
    })
    expect(report).toBeNull()
  })
})

// ─── ModelMismatchDetector ──────────────────────────────────────────────────

describe("ModelMismatchDetector", () => {
  let detector: ModelMismatchDetector

  beforeEach(() => {
    detector = new ModelMismatchDetector()
  })

  it("detects vision-related 400 errors", () => {
    const report = detector.observe({
      type: "agentEvent",
      nodeId: "agent-read",
      event: {
        type: "error",
        code: "400",
        message: "This model does not support vision capabilities",
      },
    })

    expect(report).not.toBeNull()
    expect(report!.detector).toBe("model_mismatch")
    expect(report!.severity).toBe("warning")
    expect(report!.pattern).toContain("vision")
  })

  it("detects 'tool not supported' errors", () => {
    const report = detector.observe({
      type: "agentEvent",
      nodeId: "agent-tool",
      event: {
        type: "error",
        code: "400",
        message: "tool not supported by this model",
      },
    })

    expect(report).not.toBeNull()
    expect(report!.detector).toBe("model_mismatch")
    expect(report!.pattern).toContain("tool")
  })

  it("detects 'model does not support' errors", () => {
    const report = detector.observe({
      type: "agentEvent",
      nodeId: "agent-write",
      event: {
        type: "error",
        code: "400",
        message: "model does not support this feature",
      },
    })

    expect(report).not.toBeNull()
    expect(report!.detector).toBe("model_mismatch")
  })

  it("ignores non-400 errors", () => {
    const report = detector.observe({
      type: "agentEvent",
      nodeId: "agent-read",
      event: {
        type: "error",
        code: "500",
        message: "Internal server error with vision",
      },
    })

    expect(report).toBeNull()
  })

  it("ignores non-error events", () => {
    const report = detector.observe({
      type: "agentEvent",
      nodeId: "agent-read",
      event: {
        type: "text_delta",
        content: "Hello, I can help with vision tasks",
      },
    })

    expect(report).toBeNull()
  })

  it("ignores 400 errors without mismatch patterns", () => {
    const report = detector.observe({
      type: "agentEvent",
      nodeId: "agent-read",
      event: {
        type: "error",
        code: "400",
        message: "Invalid API key",
      },
    })

    expect(report).toBeNull()
  })
})

// ─── ProcessConflictDetector ────────────────────────────────────────────────

describe("ProcessConflictDetector", () => {
  let detector: ProcessConflictDetector

  beforeEach(() => {
    detector = new ProcessConflictDetector({
      hostPid: "12345",
      hostPorts: ["3001", "3000"],
    })
  })

  it("detects kill targeting host PID", () => {
    const report = detector.observe({
      type: "beforeNode",
      nodeId: "bash-test",
      nodeType: "bash",
      nodeConfig: {
        bash: "echo 'starting tests'\nkill 12345\necho 'done'",
      },
    })

    expect(report).not.toBeNull()
    expect(report!.detector).toBe("process_conflict")
    expect(report!.severity).toBe("critical")
    expect(report!.pattern).toContain("pid")
  })

  it("detects taskkill targeting host PID", () => {
    const report = detector.observe({
      type: "beforeNode",
      nodeId: "bash-test",
      nodeType: "bash",
      nodeConfig: {
        bash: "taskkill /PID 12345 /F",
      },
    })

    expect(report).not.toBeNull()
    expect(report!.detector).toBe("process_conflict")
  })

  it("detects pkill targeting host PID", () => {
    const report = detector.observe({
      type: "beforeNode",
      nodeId: "bash-test",
      nodeType: "bash",
      nodeConfig: {
        bash: "pkill -f 12345",
      },
    })

    expect(report).not.toBeNull()
    expect(report!.detector).toBe("process_conflict")
  })

  it("detects scripts binding to host ports", () => {
    const report = detector.observe({
      type: "beforeNode",
      nodeId: "bash-test",
      nodeType: "bash",
      nodeConfig: {
        bash: "python -m http.server 3001",
      },
    })

    expect(report).not.toBeNull()
    expect(report!.detector).toBe("process_conflict")
    expect(report!.pattern).toContain("port")
  })

  it("ignores safe scripts", () => {
    const report = detector.observe({
      type: "beforeNode",
      nodeId: "bash-build",
      nodeType: "bash",
      nodeConfig: {
        bash: "npm install && npm run build",
      },
    })

    expect(report).toBeNull()
  })

  it("ignores non-bash/python nodes", () => {
    const report = detector.observe({
      type: "beforeNode",
      nodeId: "agent-write",
      nodeType: "agent",
      nodeConfig: {
        agent: "Write something about process management",
      },
    })

    expect(report).toBeNull()
  })

  it("detects $OCTOPUS_HOST_PID variable references in kill commands", () => {
    const report = detector.observe({
      type: "beforeNode",
      nodeId: "bash-test",
      nodeType: "bash",
      nodeConfig: {
        bash: "kill $OCTOPUS_HOST_PID",
      },
    })

    expect(report).not.toBeNull()
    expect(report!.detector).toBe("process_conflict")
  })

  it("detects python script content with os.kill", () => {
    const report = detector.observe({
      type: "beforeNode",
      nodeId: "py-test",
      nodeType: "python",
      nodeConfig: {
        python: "import os\nos.kill(12345, 9)",
      },
    })

    expect(report).not.toBeNull()
    expect(report!.detector).toBe("process_conflict")
  })
})

// ─── TimeoutCascadeDetector ─────────────────────────────────────────────────

describe("TimeoutCascadeDetector", () => {
  let detector: TimeoutCascadeDetector

  beforeEach(() => {
    detector = new TimeoutCascadeDetector({ threshold: 3 })
  })

  it("returns null on first timeout", () => {
    const report = detector.observe({
      type: "nodeEnd",
      nodeId: "bash-a",
      status: "failed",
      durationMs: 60000,
      result: {
        error: "timeout",
        logLines: ["Process timed out"],
        outputs: { exitCode: undefined },
      },
      nodeType: "bash",
    })

    expect(report).toBeNull()
  })

  it("returns null on second consecutive timeout", () => {
    detector.observe({
      type: "nodeEnd",
      nodeId: "bash-a",
      status: "failed",
      durationMs: 60000,
      result: { error: "timeout" },
      nodeType: "bash",
    })

    const report = detector.observe({
      type: "nodeEnd",
      nodeId: "bash-b",
      status: "failed",
      durationMs: 60000,
      result: { error: "timeout" },
      nodeType: "bash",
    })

    expect(report).toBeNull()
  })

  it("triggers on third consecutive timeout (threshold=3)", () => {
    detector.observe({
      type: "nodeEnd",
      nodeId: "bash-a",
      status: "failed",
      durationMs: 60000,
      result: { error: "timeout" },
      nodeType: "bash",
    })

    detector.observe({
      type: "nodeEnd",
      nodeId: "bash-b",
      status: "failed",
      durationMs: 60000,
      result: { error: "timeout" },
      nodeType: "bash",
    })

    const report = detector.observe({
      type: "nodeEnd",
      nodeId: "bash-c",
      status: "failed",
      durationMs: 60000,
      result: { error: "timeout" },
      nodeType: "bash",
    })

    expect(report).not.toBeNull()
    expect(report!.detector).toBe("timeout_cascade")
    expect(report!.severity).toBe("critical")
    expect(report!.nodeId).toBe("bash-c")
    expect(report!.evidence.length).toBe(3)
    expect(report!.context.consecutiveCount).toBe(3)
  })

  it("resets consecutive count on successful node", () => {
    detector.observe({
      type: "nodeEnd",
      nodeId: "bash-a",
      status: "failed",
      durationMs: 60000,
      result: { error: "timeout" },
      nodeType: "bash",
    })

    detector.observe({
      type: "nodeEnd",
      nodeId: "bash-b",
      status: "failed",
      durationMs: 60000,
      result: { error: "timeout" },
      nodeType: "bash",
    })

    // Success breaks the chain
    detector.observe({
      type: "nodeEnd",
      nodeId: "bash-c",
      status: "completed",
      durationMs: 5000,
      nodeType: "bash",
    })

    // Need 3 more timeouts after the success
    detector.observe({
      type: "nodeEnd",
      nodeId: "bash-d",
      status: "failed",
      durationMs: 60000,
      result: { error: "timeout" },
      nodeType: "bash",
    })

    detector.observe({
      type: "nodeEnd",
      nodeId: "bash-e",
      status: "failed",
      durationMs: 60000,
      result: { error: "timeout" },
      nodeType: "bash",
    })

    const report = detector.observe({
      type: "nodeEnd",
      nodeId: "bash-f",
      status: "failed",
      durationMs: 60000,
      result: { error: "timeout" },
      nodeType: "bash",
    })

    expect(report).not.toBeNull()
    // Evidence should only contain the 3 nodes after the reset
    expect(report!.evidence.length).toBe(3)
  })

  it("does not count non-timeout failures", () => {
    // Non-timeout failure resets the chain
    detector.observe({
      type: "nodeEnd",
      nodeId: "bash-a",
      status: "failed",
      durationMs: 5000,
      result: { error: "exit code 1" },
      nodeType: "bash",
    })

    detector.observe({
      type: "nodeEnd",
      nodeId: "bash-b",
      status: "failed",
      durationMs: 60000,
      result: { error: "timeout" },
      nodeType: "bash",
    })

    const report = detector.observe({
      type: "nodeEnd",
      nodeId: "bash-c",
      status: "failed",
      durationMs: 60000,
      result: { error: "timeout" },
      nodeType: "bash",
    })

    // Only 2 consecutive timeouts (non-timeout failure reset the chain),
    // so threshold=3 is not reached
    expect(report).toBeNull()
  })

  it("reset clears state", () => {
    detector.observe({
      type: "nodeEnd",
      nodeId: "bash-a",
      status: "failed",
      durationMs: 60000,
      result: { error: "timeout" },
      nodeType: "bash",
    })

    detector.observe({
      type: "nodeEnd",
      nodeId: "bash-b",
      status: "failed",
      durationMs: 60000,
      result: { error: "timeout" },
      nodeType: "bash",
    })

    detector.reset()

    // After reset, need 3 new timeouts
    detector.observe({
      type: "nodeEnd",
      nodeId: "bash-c",
      status: "failed",
      durationMs: 60000,
      result: { error: "timeout" },
      nodeType: "bash",
    })

    detector.observe({
      type: "nodeEnd",
      nodeId: "bash-d",
      status: "failed",
      durationMs: 60000,
      result: { error: "timeout" },
      nodeType: "bash",
    })

    const report = detector.observe({
      type: "nodeEnd",
      nodeId: "bash-e",
      status: "failed",
      durationMs: 60000,
      result: { error: "timeout" },
      nodeType: "bash",
    })

    expect(report).not.toBeNull()
    expect(report!.evidence.length).toBe(3)
  })
})
