import { describe, it, expect } from "vitest"
import { generateSummary, formatDuration } from "../services/execution-summary"
import type { NodeExecutionResult } from "@octopus/engine"

function makeResult(overrides: Partial<NodeExecutionResult> = {}): NodeExecutionResult {
  return {
    outputs: {},
    status: "completed",
    durationMs: 100,
    logLines: [],
    ...overrides,
  }
}

describe("formatDuration", () => {
  it("formats milliseconds", () => {
    expect(formatDuration(500)).toBe("500ms")
  })

  it("formats seconds", () => {
    expect(formatDuration(5000)).toBe("5s")
  })

  it("formats minutes", () => {
    expect(formatDuration(120000)).toBe("2m")
    expect(formatDuration(150000)).toBe("2m 30s")
  })

  it("formats hours", () => {
    expect(formatDuration(3600000)).toBe("1h")
    expect(formatDuration(5400000)).toBe("1h 30m")
  })
})

describe("generateSummary", () => {
  it("generates summary for successful execution", () => {
    const nodeResults: Record<string, NodeExecutionResult> = {
      build: makeResult({ status: "completed", durationMs: 5000 }),
      test: makeResult({ status: "completed", durationMs: 3000 }),
      deploy: makeResult({ status: "completed", durationMs: 2000 }),
    }
    const summary = generateSummary("my-workflow", "completed", nodeResults, 10000)
    expect(summary).toContain("my-workflow completed successfully")
    expect(summary).toContain("3/3 nodes completed, 0 failed, 0 skipped")
    expect(summary).toContain("Duration: 10s")
  })

  it("generates summary for failed execution with failed node details", () => {
    const nodeResults: Record<string, NodeExecutionResult> = {
      build: makeResult({ status: "completed", durationMs: 5000 }),
      test: makeResult({
        status: "failed",
        durationMs: 3000,
        logLines: ["Error: assertion failed", "at line 42"],
      }),
    }
    const summary = generateSummary("my-workflow", "failed", nodeResults, 8000)
    expect(summary).toContain("ended with status: failed")
    expect(summary).toContain("1/2 nodes completed, 1 failed, 0 skipped")
    expect(summary).toContain("Failed nodes:")
    expect(summary).toContain("test:")
  })

  it("includes skipped node count", () => {
    const nodeResults: Record<string, NodeExecutionResult> = {
      build: makeResult({ status: "completed", durationMs: 1000 }),
      test: makeResult({ status: "skipped", durationMs: 0 }),
      deploy: makeResult({ status: "skipped", durationMs: 0 }),
    }
    const summary = generateSummary("wf", "completed_with_failures", nodeResults, 1000)
    expect(summary).toContain("1/3 nodes completed, 0 failed, 2 skipped")
  })

  it("includes token usage when available", () => {
    const nodeResults: Record<string, NodeExecutionResult> = {
      agent: makeResult({
        status: "completed",
        durationMs: 10000,
        tokens: { input: 1500, output: 500 },
      }),
    }
    const summary = generateSummary("wf", "completed", nodeResults, 10000)
    expect(summary).toContain("Total tokens used: 2,000")
  })

  it("detects unusually slow nodes", () => {
    const nodeResults: Record<string, NodeExecutionResult> = {
      fast1: makeResult({ status: "completed", durationMs: 100 }),
      fast2: makeResult({ status: "completed", durationMs: 100 }),
      fast3: makeResult({ status: "completed", durationMs: 100 }),
      fast4: makeResult({ status: "completed", durationMs: 100 }),
      fast5: makeResult({ status: "completed", durationMs: 100 }),
      slow: makeResult({ status: "completed", durationMs: 10000 }),
    }
    const summary = generateSummary("wf", "completed", nodeResults, 10500)
    expect(summary).toContain("Unusually slow nodes")
    expect(summary).toContain("slow")
  })

  it("omits token line when no tokens used", () => {
    const nodeResults: Record<string, NodeExecutionResult> = {
      bash: makeResult({ status: "completed", durationMs: 100 }),
    }
    const summary = generateSummary("wf", "completed", nodeResults, 100)
    expect(summary).not.toContain("Total tokens")
  })

  it("handles empty node results", () => {
    const summary = generateSummary("empty-wf", "completed", {}, 0)
    expect(summary).toContain("empty-wf completed successfully")
    expect(summary).toContain("0/0 nodes completed")
  })
})
