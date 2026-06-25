import { describe, it, expect } from "vitest"
import { FailureClassifier } from "../pipeline/failure-classifier"
import type { NodeExecutionResult } from "../executors/types"

function makeResult(overrides: Partial<NodeExecutionResult> = {}): NodeExecutionResult {
  return {
    outputs: {},
    status: "failed",
    durationMs: 100,
    logLines: [],
    ...overrides,
  }
}

describe("FailureClassifier", () => {
  const classifier = new FailureClassifier()

  describe("exit_code_nonzero", () => {
    it("classifies exit code 1 as exit_code_nonzero", () => {
      const result = makeResult({ exitCode: 1 })
      expect(classifier.classify(result)).toBe("exit_code_nonzero")
    })

    it("classifies exit code 2 as exit_code_nonzero", () => {
      const result = makeResult({ exitCode: 2 })
      expect(classifier.classify(result)).toBe("exit_code_nonzero")
    })

    it("classifies high exit codes as exit_code_nonzero", () => {
      const result = makeResult({ exitCode: 127 })
      expect(classifier.classify(result)).toBe("exit_code_nonzero")
    })

    it("does not classify exit code 0 as exit_code_nonzero", () => {
      const result = makeResult({ exitCode: 0 })
      expect(classifier.classify(result)).toBe("transient_error")
    })
  })

  describe("timeout", () => {
    it("classifies timeout property as timeout", () => {
      const result = makeResult({ timeout: 60 })
      expect(classifier.classify(result)).toBe("timeout")
    })

    it("classifies 'timed out' in error message as timeout", () => {
      const result = makeResult({ error: "Operation timed out after 60s" })
      expect(classifier.classify(result)).toBe("timeout")
    })

    it("classifies 'timeout' in error message as timeout", () => {
      const result = makeResult({ error: "Connection timeout exceeded" })
      expect(classifier.classify(result)).toBe("timeout")
    })

    it("classifies idle timeout in logLines as timeout", () => {
      const result = makeResult({
        logLines: ["Agent stream idle timeout (300s). Text length: 1234, events: 567."],
      })
      expect(classifier.classify(result)).toBe("timeout")
    })

    it("classifies 'idle' in error message as timeout", () => {
      const result = makeResult({ error: "Agent idle for too long" })
      expect(classifier.classify(result)).toBe("timeout")
    })
  })

  describe("user_cancelled", () => {
    it("classifies cancelled status as user_cancelled", () => {
      const result = makeResult({ status: "cancelled" })
      expect(classifier.classify(result)).toBe("user_cancelled")
    })

    it("classifies 'Cancelled by user' in logLines as user_cancelled", () => {
      const result = makeResult({
        logLines: ["Starting task...", "Cancelled by user"],
      })
      expect(classifier.classify(result)).toBe("user_cancelled")
    })
  })

  describe("approval_rejected", () => {
    it("classifies rejected status as approval_rejected", () => {
      const result = makeResult({ status: "rejected" })
      expect(classifier.classify(result)).toBe("approval_rejected")
    })
  })

  describe("agent_stream_error", () => {
    it("classifies ECONNRESET in error as agent_stream_error", () => {
      const result = makeResult({ error: "Connection failed: ECONNRESET" })
      expect(classifier.classify(result)).toBe("agent_stream_error")
    })

    it("classifies 'stream' in error as agent_stream_error", () => {
      const result = makeResult({ error: "Error reading stream response" })
      expect(classifier.classify(result)).toBe("agent_stream_error")
    })

    it("classifies 'Stream fracture' in logLines as agent_stream_error", () => {
      const result = makeResult({
        logLines: ["Processing...", "Stream fracture detected"],
      })
      expect(classifier.classify(result)).toBe("agent_stream_error")
    })

    it("classifies 'stream' in logLines as agent_stream_error", () => {
      const result = makeResult({
        logLines: ["Agent stream ended unexpectedly"],
      })
      expect(classifier.classify(result)).toBe("agent_stream_error")
    })
  })

  describe("config_error", () => {
    it("classifies 'Expression evaluation' in error as config_error", () => {
      const result = makeResult({ error: "Expression evaluation failed: undefined variable" })
      expect(classifier.classify(result)).toBe("config_error")
    })

    it("classifies 'unexpected token' in error as config_error", () => {
      const result = makeResult({ error: "Parse error: unexpected token at line 5" })
      expect(classifier.classify(result)).toBe("config_error")
    })

    it("classifies 'SyntaxError' in error as config_error", () => {
      const result = makeResult({ error: "SyntaxError: Invalid or unexpected token" })
      expect(classifier.classify(result)).toBe("config_error")
    })
  })

  describe("agent_partial_completion", () => {
    it("classifies presence of lastOutput as agent_partial_completion", () => {
      const result = makeResult({ lastOutput: "Partial result generated before failure" })
      expect(classifier.classify(result)).toBe("agent_partial_completion")
    })

    it("does not classify empty lastOutput as agent_partial_completion", () => {
      const result = makeResult({ lastOutput: "" })
      expect(classifier.classify(result)).toBe("transient_error")
    })
  })

  describe("transient_error (default catch-all)", () => {
    it("classifies unknown errors as transient_error", () => {
      const result = makeResult({ error: "Something went wrong" })
      expect(classifier.classify(result)).toBe("transient_error")
    })

    it("classifies failed status with no other indicators as transient_error", () => {
      const result = makeResult({})
      expect(classifier.classify(result)).toBe("transient_error")
    })

    it("classifies network errors not matching specific patterns as transient_error", () => {
      const result = makeResult({ error: "Network request failed" })
      expect(classifier.classify(result)).toBe("transient_error")
    })
  })

  describe("classification priority", () => {
    it("user_cancelled takes priority over timeout", () => {
      const result = makeResult({
        status: "cancelled",
        timeout: 60,
      })
      expect(classifier.classify(result)).toBe("user_cancelled")
    })

    it("timeout takes priority over exit_code_nonzero", () => {
      const result = makeResult({
        timeout: 60,
        exitCode: 1,
      })
      expect(classifier.classify(result)).toBe("timeout")
    })

    it("exit_code_nonzero takes priority over agent_stream_error", () => {
      const result = makeResult({
        exitCode: 1,
        error: "stream disconnected",
      })
      expect(classifier.classify(result)).toBe("exit_code_nonzero")
    })
  })

  describe("real-world idle_timeout scenario", () => {
    it("classifies agent idle timeout error correctly (from logLines)", () => {
      // Simulates the exact error from agent-runner.ts idle timeout
      const result = makeResult({
        status: "failed",
        logLines: [
          "Agent stream idle timeout (300s). Text length: 5432, events: 156. The agent session may be in a broken state — try pausing and resuming with intervention.",
        ],
      })
      // Should be classified as timeout (because of "timeout" and "idle" keywords)
      // This ensures it will be retried when retry_on includes "timeout"
      expect(classifier.classify(result)).toBe("timeout")
    })

    it("classifies agent idle timeout error correctly (from error field)", () => {
      // After fix: agent.ts now sets error field
      const result = makeResult({
        status: "failed",
        error: "Agent stream idle timeout (300s). Text length: 5432, events: 156.",
        logLines: [
          "Agent stream idle timeout (300s). Text length: 5432, events: 156.",
        ],
      })
      expect(classifier.classify(result)).toBe("timeout")
    })

    it("classifies stream error with partial output correctly", () => {
      // Agent produced some output before stream error - should retry
      const result = makeResult({
        status: "failed",
        error: "Agent stream ended without result event — possible stream fracture",
        lastOutput: "Partial work completed before failure...",
        logLines: ["Agent stream ended without result event — possible stream fracture. Text length: 500, events: 50, attempts: 2"],
      })
      // Should be agent_stream_error (has priority over agent_partial_completion)
      expect(classifier.classify(result)).toBe("agent_stream_error")
    })
  })
})
