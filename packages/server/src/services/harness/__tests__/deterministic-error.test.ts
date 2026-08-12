// packages/server/src/services/harness/__tests__/deterministic-error.test.ts
//
// Unit tests for DeterministicErrorDetector and DetectorPipeline integration.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { DeterministicErrorDetector } from "../detectors/deterministic-error"
import { DetectorPipeline } from "../detector-pipeline"
import type { HarnessCallbackEvent } from "../base-detector"
import type { HarnessSystemConfigParsed } from "@octopus/shared"

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeNodeStart(nodeId: string, nodeType: string): HarnessCallbackEvent {
  return { type: "nodeStart", nodeId, nodeType }
}

function makeNodeRetry(
  nodeId: string,
  attempt: number,
  result: { error?: string; logLines?: string[]; outputs?: { exitCode?: number } },
): HarnessCallbackEvent {
  return {
    type: "nodeRetry",
    nodeId,
    attempt,
    maxAttempts: 3,
    delayMs: 1000,
    result,
  }
}

function makeBeforeNode(
  nodeId: string,
  nodeType: string,
  nodeConfig: Record<string, any>,
): HarnessCallbackEvent {
  return { type: "beforeNode", nodeId, nodeType, nodeConfig }
}

// ─── DeterministicErrorDetector ─────────────────────────────────────────────

describe("DeterministicErrorDetector", () => {
  let detector: DeterministicErrorDetector

  beforeEach(() => {
    detector = new DeterministicErrorDetector()
  })

  // ── nodeType tracking ──────────────────────────────────────────────────

  describe("nodeType tracking", () => {
    it("returns null for nodeStart events (tracking only)", () => {
      const report = detector.observe(makeNodeStart("bash-build", "bash"))
      expect(report).toBeNull()
    })

    it("returns null for nodeRetry when nodeType is unknown", () => {
      const report = detector.observe(
        makeNodeRetry("unknown-node", 1, {
          error: "SyntaxError: invalid syntax",
          outputs: { exitCode: 1 },
        }),
      )
      expect(report).toBeNull()
    })

    it("uses tracked nodeType from prior nodeStart event", () => {
      detector.observe(makeNodeStart("bash-build", "bash"))

      const report = detector.observe(
        makeNodeRetry("bash-build", 1, {
          error: "bash: syntax error near unexpected token `}'",
          outputs: { exitCode: 2 },
        }),
      )

      expect(report).not.toBeNull()
      expect(report!.nodeType).toBe("bash")
    })
  })

  // ── Bash deterministic errors ──────────────────────────────────────────

  describe("fires for bash deterministic errors (attempt 1)", () => {
    beforeEach(() => {
      detector.observe(makeNodeStart("bash-build", "bash"))
    })

    it("command not found → critical, command_not_found", () => {
      const report = detector.observe(
        makeNodeRetry("bash-build", 1, {
          error: "exit code 127",
          logLines: ["jq: command not found"],
          outputs: { exitCode: 127 },
        }),
      )

      expect(report).not.toBeNull()
      expect(report!.detector).toBe("deterministic_error")
      expect(report!.severity).toBe("critical")
      expect(report!.pattern).toBe("deterministic_error:command_not_found")
      expect(report!.evidence[0].errorPattern).toBe("command_not_found")
    })

    it("syntax error near unexpected token → critical, syntax_error", () => {
      const report = detector.observe(
        makeNodeRetry("bash-build", 1, {
          error: "exit code 2",
          logLines: ["bash: syntax error near unexpected token `}'"],
          outputs: { exitCode: 2 },
        }),
      )

      expect(report).not.toBeNull()
      expect(report!.severity).toBe("critical")
      expect(report!.pattern).toBe("deterministic_error:syntax_error")
    })

    it("unexpected EOF → critical, syntax_error", () => {
      const report = detector.observe(
        makeNodeRetry("bash-build", 1, {
          error: "exit code 2",
          logLines: ["bash: unexpected EOF while looking for matching `\"'"],
          outputs: { exitCode: 2 },
        }),
      )

      expect(report).not.toBeNull()
      expect(report!.severity).toBe("critical")
      expect(report!.pattern).toBe("deterministic_error:syntax_error")
    })

    it("Permission denied → warning, permission_denied", () => {
      const report = detector.observe(
        makeNodeRetry("bash-build", 1, {
          error: "exit code 126",
          logLines: ["bash: ./deploy.sh: Permission denied"],
          outputs: { exitCode: 126 },
        }),
      )

      expect(report).not.toBeNull()
      expect(report!.severity).toBe("warning")
      expect(report!.pattern).toBe("deterministic_error:permission_denied")
    })

    it("No such file or directory → warning, file_not_found", () => {
      const report = detector.observe(
        makeNodeRetry("bash-build", 1, {
          error: "exit code 1",
          logLines: ["cat: /etc/config.json: No such file or directory"],
          outputs: { exitCode: 1 },
        }),
      )

      expect(report).not.toBeNull()
      expect(report!.severity).toBe("warning")
      expect(report!.pattern).toBe("deterministic_error:file_not_found")
    })

    it("Unable to locate package → critical, missing_package", () => {
      const report = detector.observe(
        makeNodeRetry("bash-build", 1, {
          error: "exit code 100",
          logLines: ["E: Unable to locate package foobar"],
          outputs: { exitCode: 100 },
        }),
      )

      expect(report).not.toBeNull()
      expect(report!.severity).toBe("critical")
      expect(report!.pattern).toBe("deterministic_error:missing_package")
    })
  })

  // ── Python deterministic errors ─────────────────────────────────────────

  describe("fires for python deterministic errors (attempt 1)", () => {
    beforeEach(() => {
      detector.observe(makeNodeStart("py-script", "python"))
    })

    it("ModuleNotFoundError → critical, missing_module", () => {
      const report = detector.observe(
        makeNodeRetry("py-script", 1, {
          error: "exit code 1",
          logLines: [
            "Traceback (most recent call last):",
            "  File \"analyze.py\", line 3, in <module>",
            "    import pandas",
            "ModuleNotFoundError: No module named 'pandas'",
          ],
          outputs: { exitCode: 1 },
        }),
      )

      expect(report).not.toBeNull()
      expect(report!.detector).toBe("deterministic_error")
      expect(report!.severity).toBe("critical")
      expect(report!.pattern).toBe("deterministic_error:missing_module")
    })

    it("SyntaxError → critical, syntax_error", () => {
      const report = detector.observe(
        makeNodeRetry("py-script", 1, {
          error: "exit code 1",
          logLines: [
            "  File \"script.py\", line 5",
            "    def foo(",
            "           ^",
            "SyntaxError: unexpected EOF while parsing",
          ],
          outputs: { exitCode: 1 },
        }),
      )

      expect(report).not.toBeNull()
      expect(report!.severity).toBe("critical")
      expect(report!.pattern).toBe("deterministic_error:syntax_error")
    })

    it("IndentationError → critical, syntax_error", () => {
      const report = detector.observe(
        makeNodeRetry("py-script", 1, {
          error: "exit code 1",
          logLines: [
            "  File \"script.py\", line 10",
            "    print('hello')",
            "    ^",
            "IndentationError: expected an indented block",
          ],
          outputs: { exitCode: 1 },
        }),
      )

      expect(report).not.toBeNull()
      expect(report!.severity).toBe("critical")
      expect(report!.pattern).toBe("deterministic_error:syntax_error")
    })

    it("ImportError → warning, import_error", () => {
      const report = detector.observe(
        makeNodeRetry("py-script", 1, {
          error: "exit code 1",
          logLines: ["ImportError: cannot import name 'Foo' from 'bar'"],
          outputs: { exitCode: 1 },
        }),
      )

      expect(report).not.toBeNull()
      expect(report!.severity).toBe("warning")
      expect(report!.pattern).toBe("deterministic_error:import_error")
    })

    it("NameError: name 'x' is not defined → warning, undefined_reference", () => {
      const report = detector.observe(
        makeNodeRetry("py-script", 1, {
          error: "exit code 1",
          logLines: ["NameError: name 'x' is not defined"],
          outputs: { exitCode: 1 },
        }),
      )

      expect(report).not.toBeNull()
      expect(report!.severity).toBe("warning")
      expect(report!.pattern).toBe("deterministic_error:undefined_reference")
    })

    it("FileNotFoundError → warning, file_not_found", () => {
      const report = detector.observe(
        makeNodeRetry("py-script", 1, {
          error: "exit code 1",
          logLines: ["FileNotFoundError: [Errno 2] No such file or directory: 'data.csv'"],
          outputs: { exitCode: 1 },
        }),
      )

      expect(report).not.toBeNull()
      expect(report!.severity).toBe("warning")
      expect(report!.pattern).toBe("deterministic_error:file_not_found")
    })
  })

  // ── Cross-language matching ─────────────────────────────────────────────

  describe("cross-language matching", () => {
    it("python node with bash-style 'command not found' in logLines → fires", () => {
      detector.observe(makeNodeStart("py-script", "python"))

      const report = detector.observe(
        makeNodeRetry("py-script", 1, {
          error: "exit code 1",
          logLines: ["sh: jq: command not found"],
          outputs: { exitCode: 1 },
        }),
      )

      expect(report).not.toBeNull()
      expect(report!.pattern).toContain("command_not_found")
    })

    it("bash node with python ModuleNotFoundError in logLines → fires", () => {
      detector.observe(makeNodeStart("bash-build", "bash"))

      const report = detector.observe(
        makeNodeRetry("bash-build", 1, {
          error: "exit code 1",
          logLines: [
            "Traceback (most recent call last):",
            "ModuleNotFoundError: No module named 'requests'",
          ],
          outputs: { exitCode: 1 },
        }),
      )

      expect(report).not.toBeNull()
      expect(report!.pattern).toContain("missing_module")
    })
  })

  // ── Transient error override ────────────────────────────────────────────

  describe("does NOT fire for transient errors (override via result.error)", () => {
    beforeEach(() => {
      detector.observe(makeNodeStart("bash-curl", "bash"))
    })

    it("result.error contains ECONNREFUSED → null", () => {
      const report = detector.observe(
        makeNodeRetry("bash-curl", 1, {
          error: "connect ECONNREFUSED 127.0.0.1:3000",
          logLines: ["curl: (7) Failed to connect"],
          outputs: { exitCode: 7 },
        }),
      )
      expect(report).toBeNull()
    })

    it("result.error contains timeout → null", () => {
      const report = detector.observe(
        makeNodeRetry("bash-curl", 1, {
          error: "Operation timed out",
          logLines: ["curl: (28) Connection timed out"],
          outputs: { exitCode: 28 },
        }),
      )
      expect(report).toBeNull()
    })

    it("result.error contains Connection reset → null", () => {
      const report = detector.observe(
        makeNodeRetry("bash-curl", 1, {
          error: "Connection reset by peer",
          logLines: ["curl: (56) recv failure"],
          outputs: { exitCode: 56 },
        }),
      )
      expect(report).toBeNull()
    })

    it("transient in result.error, deterministic in logLines → null (override wins)", () => {
      const report = detector.observe(
        makeNodeRetry("bash-curl", 1, {
          error: "503 Service Unavailable",
          logLines: [
            "curl: (22) The requested URL returned error: 503",
            "SyntaxError: invalid syntax",
          ],
          outputs: { exitCode: 22 },
        }),
      )
      // result.error has "Service Unavailable" → transient override wins
      expect(report).toBeNull()
    })

    it("non-transient result.error with deterministic logLines → fires", () => {
      const report = detector.observe(
        makeNodeRetry("bash-curl", 1, {
          error: "exit code 1",
          logLines: [
            "curl: (22) The requested URL returned error: 503",
            "SyntaxError: invalid syntax",
          ],
          outputs: { exitCode: 1 },
        }),
      )
      // result.error = "exit code 1" → no transient match → checks logLines → SyntaxError fires
      expect(report).not.toBeNull()
      expect(report!.pattern).toContain("syntax_error")
    })
  })

  // ── Agent nodes excluded ───────────────────────────────────────────────

  describe("does NOT fire for agent nodes", () => {
    it("agent nodeType → null even with SyntaxError in error", () => {
      detector.observe(makeNodeStart("agent-write", "agent"))

      const report = detector.observe(
        makeNodeRetry("agent-write", 1, {
          error: "SyntaxError: unexpected token",
          logLines: ["SyntaxError: unexpected token"],
          outputs: { exitCode: 1 },
        }),
      )
      expect(report).toBeNull()
    })
  })

  // ── Attempt filtering ──────────────────────────────────────────────────

  describe("attempt filtering", () => {
    beforeEach(() => {
      detector.observe(makeNodeStart("bash-build", "bash"))
    })

    it("fires at attempt 1 for deterministic error", () => {
      const report = detector.observe(
        makeNodeRetry("bash-build", 1, {
          error: "exit code 1",
          logLines: ["jq: command not found"],
          outputs: { exitCode: 127 },
        }),
      )
      expect(report).not.toBeNull()
    })

    it("does NOT fire at attempt 2 (StupidRetry handles)", () => {
      const report = detector.observe(
        makeNodeRetry("bash-build", 2, {
          error: "exit code 1",
          logLines: ["jq: command not found"],
          outputs: { exitCode: 127 },
        }),
      )
      expect(report).toBeNull()
    })

    it("does NOT fire at attempt 3+", () => {
      const report = detector.observe(
        makeNodeRetry("bash-build", 3, {
          error: "exit code 1",
          logLines: ["jq: command not found"],
          outputs: { exitCode: 127 },
        }),
      )
      expect(report).toBeNull()
    })
  })

  // ── Script snippet tracking ─────────────────────────────────────────────

  describe("script snippet tracking", () => {
    it("captures script from beforeNode event and includes in evidence", () => {
      detector.observe(makeNodeStart("bash-build", "bash"))
      detector.observe(
        makeBeforeNode("bash-build", "bash", {
          bash: "npm install && npm run build",
        }),
      )

      const report = detector.observe(
        makeNodeRetry("bash-build", 1, {
          error: "exit code 1",
          logLines: ["bash: syntax error near unexpected token"],
          outputs: { exitCode: 2 },
        }),
      )

      expect(report).not.toBeNull()
      expect(report!.evidence[0].scriptSnippet).toBe("npm install && npm run build")
    })

    it("works without beforeNode event (no script snippet in evidence)", () => {
      detector.observe(makeNodeStart("bash-build", "bash"))

      const report = detector.observe(
        makeNodeRetry("bash-build", 1, {
          error: "exit code 1",
          logLines: ["bash: syntax error near unexpected token"],
          outputs: { exitCode: 2 },
        }),
      )

      expect(report).not.toBeNull()
      expect(report!.evidence[0].scriptSnippet).toBeUndefined()
    })

    it("truncates script to 500 chars", () => {
      detector.observe(makeNodeStart("bash-build", "bash"))
      detector.observe(
        makeBeforeNode("bash-build", "bash", {
          bash: "x".repeat(1000),
        }),
      )

      const report = detector.observe(
        makeNodeRetry("bash-build", 1, {
          error: "exit code 1",
          logLines: ["syntax error"],
          outputs: { exitCode: 2 },
        }),
      )

      expect(report).not.toBeNull()
      expect(report!.evidence[0].scriptSnippet).toHaveLength(500)
    })
  })

  // ── reset() ────────────────────────────────────────────────────────────

  describe("reset()", () => {
    it("clears nodeType map and script map", () => {
      detector.observe(makeNodeStart("bash-build", "bash"))
      detector.observe(
        makeBeforeNode("bash-build", "bash", { bash: "echo hello" }),
      )

      detector.reset()

      // After reset, nodeType is unknown → null
      const report = detector.observe(
        makeNodeRetry("bash-build", 1, {
          error: "exit code 1",
          logLines: ["syntax error"],
          outputs: { exitCode: 2 },
        }),
      )
      expect(report).toBeNull()
    })
  })

  // ── Edge cases ─────────────────────────────────────────────────────────

  describe("edge cases", () => {
    beforeEach(() => {
      detector.observe(makeNodeStart("bash-build", "bash"))
    })

    it("empty result (no error, no logLines) → null", () => {
      const report = detector.observe(
        makeNodeRetry("bash-build", 1, { outputs: { exitCode: 1 } }),
      )
      expect(report).toBeNull()
    })

    it("result with only logLines (no error field) → still matches", () => {
      const report = detector.observe(
        makeNodeRetry("bash-build", 1, {
          logLines: ["bash: syntax error near unexpected token"],
          outputs: { exitCode: 2 },
        }),
      )
      expect(report).not.toBeNull()
    })

    it("ignores non-nodeRetry events (nodeEnd, agentEvent, etc.)", () => {
      expect(
        detector.observe({
          type: "nodeEnd",
          nodeId: "bash-build",
          status: "failed",
          durationMs: 1000,
          result: { error: "syntax error" },
          nodeType: "bash",
        }),
      ).toBeNull()

      expect(
        detector.observe({
          type: "agentEvent",
          nodeId: "bash-build",
          event: { type: "error", message: "syntax error" },
        }),
      ).toBeNull()
    })

    it("evidence contains last 10 error lines", () => {
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)
      lines.push("syntax error here")

      const report = detector.observe(
        makeNodeRetry("bash-build", 1, {
          error: "exit code 2",
          logLines: lines,
          outputs: { exitCode: 2 },
        }),
      )

      expect(report).not.toBeNull()
      // Last 10 non-empty lines
      const firstEvidence = report!.evidence[0] as Record<string, any>
      const evidenceLines = firstEvidence.errorMessage.split("\n")
      expect(evidenceLines.length).toBe(10)
      expect(evidenceLines[evidenceLines.length - 1]).toContain("syntax error")
    })

    it("no deterministic pattern → null (non-matching error)", () => {
      const report = detector.observe(
        makeNodeRetry("bash-build", 1, {
          error: "exit code 1",
          logLines: ["something went wrong but not deterministically"],
          outputs: { exitCode: 1 },
        }),
      )
      expect(report).toBeNull()
    })
  })
})

// ─── DetectorPipeline integration ───────────────────────────────────────────

describe("DeterministicErrorDetector — DetectorPipeline integration", () => {
  let mockDao: { insertEvent: ReturnType<typeof vi.fn> }
  let mockSse: { emit: ReturnType<typeof vi.fn> }

  const configWithDeterministicError: HarnessSystemConfigParsed = {
    detectors: {
      stupid_retry: { enabled: true, threshold: 2 },
      model_mismatch: { enabled: true },
      process_conflict: { enabled: true },
      timeout_cascade: { enabled: true, threshold: 3 },
      deterministic_error: { enabled: true },
    },
    strategies: [],
    isolation: {
      process_group: true,
      port_protection: true,
      pid_protection: true,
      sandbox: "auto",
      fs_whitelist: [".", "/tmp"],
    },
  }

  beforeEach(() => {
    mockDao = { insertEvent: vi.fn() }
    mockSse = { emit: vi.fn() }
  })

  it("creates detector when enabled in config", () => {
    const pipeline = new DetectorPipeline({
      config: configWithDeterministicError,
      executionId: "exec-1",
      workspaceId: "ws-1",
      dao: mockDao as any,
      sse: mockSse as any,
    })
    expect(pipeline.detectorCount).toBe(5)
  })

  it("skips detector when disabled", () => {
    const disabledConfig: HarnessSystemConfigParsed = {
      ...configWithDeterministicError,
      detectors: {
        ...configWithDeterministicError.detectors,
        deterministic_error: { enabled: false },
      },
    }

    const pipeline = new DetectorPipeline({
      config: disabledConfig,
      executionId: "exec-2",
      workspaceId: "ws-1",
      dao: mockDao as any,
      sse: mockSse as any,
    })
    expect(pipeline.detectorCount).toBe(4)
  })

  it("routes nodeStart events for nodeType tracking then fires on syntax error", () => {
    const pipeline = new DetectorPipeline({
      config: configWithDeterministicError,
      executionId: "exec-1",
      workspaceId: "ws-1",
      dao: mockDao as any,
      sse: mockSse as any,
    })

    // First: nodeStart registers nodeType
    pipeline.routeEvent({
      type: "nodeStart",
      nodeId: "bash-build",
      nodeType: "bash",
    })

    // Then: nodeRetry at attempt 1 with deterministic error
    pipeline.routeEvent({
      type: "nodeRetry",
      nodeId: "bash-build",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1000,
      result: {
        error: "exit code 2",
        logLines: ["bash: syntax error near unexpected token `}'"],
        outputs: { exitCode: 2 },
      },
    })

    // Should persist + emit
    expect(mockDao.insertEvent).toHaveBeenCalledTimes(1)
    expect(mockSse.emit).toHaveBeenCalledTimes(1)

    const sseCall = mockSse.emit.mock.calls[0]
    expect(sseCall[1].event).toBe("harness_diagnosis")
    expect(sseCall[1].data.report.detector).toBe("deterministic_error")
    expect(sseCall[1].data.report.severity).toBe("critical")
  })

  it("coexistence: deterministic_error at attempt 1, stupid_retry fires at attempt 2 as fallback", () => {
    const pipeline = new DetectorPipeline({
      config: configWithDeterministicError,
      executionId: "exec-1",
      workspaceId: "ws-1",
      dao: mockDao as any,
      sse: mockSse as any,
    })

    const result = {
      error: "exit code 1",
      logLines: ["jq: command not found"],
      outputs: { exitCode: 127 },
    }

    // Register nodeType
    pipeline.routeEvent({
      type: "nodeStart",
      nodeId: "bash-build",
      nodeType: "bash",
    })

    // Attempt 1: deterministic_error fires (attempt===1)
    // stupid_retry tracks state (retryCount=1) but doesn't fire yet
    pipeline.routeEvent({
      type: "nodeRetry",
      nodeId: "bash-build",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1000,
      result,
    })

    // Only deterministic_error should have fired
    expect(mockDao.insertEvent).toHaveBeenCalledTimes(1)
    const firstReport = JSON.parse(mockDao.insertEvent.mock.calls[0][0].report_json)
    expect(firstReport.detector).toBe("deterministic_error")

    // Attempt 2: deterministic_error ignores (attempt≠1),
    // stupid_retry fires (threshold=2, same error) — acts as fallback
    // when the deterministic_error fix didn't resolve the issue
    pipeline.routeEvent({
      type: "nodeRetry",
      nodeId: "bash-build",
      attempt: 2,
      maxAttempts: 3,
      delayMs: 1000,
      result,
    })

    // stupid_retry fires as fallback
    expect(mockDao.insertEvent).toHaveBeenCalledTimes(2)
    const secondReport = JSON.parse(mockDao.insertEvent.mock.calls[1][0].report_json)
    expect(secondReport.detector).toBe("stupid_retry")
  })

  it("stupid_retry still fires for agent nodes (not handled by deterministic_error)", () => {
    const pipeline = new DetectorPipeline({
      config: configWithDeterministicError,
      executionId: "exec-1",
      workspaceId: "ws-1",
      dao: mockDao as any,
      sse: mockSse as any,
    })

    const result = {
      error: "stream fracture",
      outputs: { exitCode: 1 },
    }

    pipeline.routeEvent({
      type: "nodeStart",
      nodeId: "agent-node",
      nodeType: "agent",
    })

    // Attempt 1: deterministic_error skips (agent node)
    pipeline.routeEvent({
      type: "nodeRetry",
      nodeId: "agent-node",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1000,
      result,
    })
    expect(mockDao.insertEvent).toHaveBeenCalledTimes(0)

    // Attempt 2: stupid_retry fires (threshold=2, no suppression)
    pipeline.routeEvent({
      type: "nodeRetry",
      nodeId: "agent-node",
      attempt: 2,
      maxAttempts: 3,
      delayMs: 1000,
      result,
    })
    expect(mockDao.insertEvent).toHaveBeenCalledTimes(1)
    const report = JSON.parse(mockDao.insertEvent.mock.calls[0][0].report_json)
    expect(report.detector).toBe("stupid_retry")
  })

  it("stupid_retry fires for bash nodes with non-deterministic errors (not suppressed)", () => {
    const pipeline = new DetectorPipeline({
      config: configWithDeterministicError,
      executionId: "exec-1",
      workspaceId: "ws-1",
      dao: mockDao as any,
      sse: mockSse as any,
    })

    const result = {
      error: "exit code 1",
      logLines: ["something went wrong but not deterministically"],
      outputs: { exitCode: 1 },
    }

    pipeline.routeEvent({
      type: "nodeStart",
      nodeId: "bash-flaky",
      nodeType: "bash",
    })

    // Attempt 1: deterministic_error does NOT match (non-deterministic pattern)
    pipeline.routeEvent({
      type: "nodeRetry",
      nodeId: "bash-flaky",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1000,
      result,
    })
    expect(mockDao.insertEvent).toHaveBeenCalledTimes(0)

    // Attempt 2: stupid_retry fires (threshold=2, no suppression since det_error never fired)
    pipeline.routeEvent({
      type: "nodeRetry",
      nodeId: "bash-flaky",
      attempt: 2,
      maxAttempts: 3,
      delayMs: 1000,
      result,
    })
    expect(mockDao.insertEvent).toHaveBeenCalledTimes(1)
    const report = JSON.parse(mockDao.insertEvent.mock.calls[0][0].report_json)
    expect(report.detector).toBe("stupid_retry")
  })
})
