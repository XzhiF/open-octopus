import { describe, it, expect } from "vitest"
import { runAssertions } from "../../simulator/assertions"
import type { NodeExecutionResult } from "../../executors/types"
import type { NodeExecutionEntry } from "../../simulator/types"

function makeResult(overrides: Partial<NodeExecutionResult> = {}): NodeExecutionResult {
  return {
    outputs: {},
    status: "completed",
    durationMs: 0,
    logLines: [],
    ...overrides,
  }
}

function makeTrace(entries: Array<{ nodeId: string; status?: string }>): NodeExecutionEntry[] {
  return entries.map((e) => ({
    nodeId: e.nodeId,
    nodeType: "agent",
    status: e.status ?? "completed",
    durationMs: 1,
    mocked: true,
    logLines: [],
  }))
}

describe("runAssertions", () => {
  // ── Status ─────────────────────────────────────────────────

  describe("status assertions", () => {
    it("passes when status matches", () => {
      const report = runAssertions(
        { status: "completed" },
        "completed",
        {},
        {},
        [],
      )
      expect(report.passed).toBe(true)
      expect(report.results[0].name).toBe("status")
    })

    it("fails when status does not match", () => {
      const report = runAssertions(
        { status: "completed" },
        "failed",
        {},
        {},
        [],
      )
      expect(report.passed).toBe(false)
      expect(report.results[0].message).toContain("failed")
    })
  })

  // ── Vars ───────────────────────────────────────────────────

  describe("vars assertions", () => {
    it("passes when vars match", () => {
      const report = runAssertions(
        { vars: { a: 1 } },
        "completed",
        { a: 1 },
        {},
        [],
      )
      expect(report.passed).toBe(true)
    })

    it("fails when var is missing", () => {
      const report = runAssertions(
        { vars: { a: 1 } },
        "completed",
        {},
        {},
        [],
      )
      expect(report.passed).toBe(false)
      expect(report.results[0].message).toContain("missing")
    })

    it("fails when var value is wrong", () => {
      const report = runAssertions(
        { vars: { a: 1 } },
        "completed",
        { a: 2 },
        {},
        [],
      )
      expect(report.passed).toBe(false)
      expect(report.results[0].message).toContain("expected")
    })
  })

  // ── Node Trace ─────────────────────────────────────────────

  describe("node_trace assertions", () => {
    it("passes when all executed nodes are found", () => {
      const trace = makeTrace([
        { nodeId: "a" },
        { nodeId: "b" },
        { nodeId: "c" },
      ])
      const report = runAssertions(
        { node_trace: { executed: ["a", "b"] } },
        "completed",
        {},
        {},
        trace,
      )
      expect(report.passed).toBe(true)
    })

    it("fails when expected executed node is missing", () => {
      const trace = makeTrace([
        { nodeId: "a" },
        { nodeId: "c" },
      ])
      const report = runAssertions(
        { node_trace: { executed: ["a", "b"] } },
        "completed",
        {},
        {},
        trace,
      )
      expect(report.passed).toBe(false)
      expect(report.results.find((r) => !r.passed)?.message).toContain('"b"')
    })

    it("passes when skipped nodes match", () => {
      const trace = makeTrace([
        { nodeId: "a" },
        { nodeId: "b", status: "skipped" },
      ])
      const report = runAssertions(
        { node_trace: { skipped: ["b"] } },
        "completed",
        {},
        {},
        trace,
      )
      expect(report.passed).toBe(true)
    })

    it("passes when execution order matches", () => {
      const trace = makeTrace([
        { nodeId: "a" },
        { nodeId: "b" },
        { nodeId: "c" },
      ])
      const report = runAssertions(
        { node_trace: { order: ["a", "b", "c"] } },
        "completed",
        {},
        {},
        trace,
      )
      expect(report.passed).toBe(true)
    })

    it("fails when execution order is wrong", () => {
      const trace = makeTrace([
        { nodeId: "a" },
        { nodeId: "c" },
        { nodeId: "b" },
      ])
      const report = runAssertions(
        { node_trace: { order: ["a", "b", "c"] } },
        "completed",
        {},
        {},
        trace,
      )
      expect(report.passed).toBe(false)
    })
  })

  // ── Node Outputs ───────────────────────────────────────────

  describe("node_outputs assertions", () => {
    it("passes when lastOutput matches", () => {
      const nodeResults = { "node-a": makeResult({ lastOutput: "hi" }) }
      const report = runAssertions(
        { node_outputs: { "node-a": { output: "hi" } } },
        "completed",
        {},
        nodeResults,
        [],
      )
      expect(report.passed).toBe(true)
    })

    it("passes when named outputs match", () => {
      const nodeResults = { "node-a": makeResult({ outputs: { x: 1 } }) }
      const report = runAssertions(
        { node_outputs: { "node-a": { outputs: { x: 1 } } } },
        "completed",
        {},
        nodeResults,
        [],
      )
      expect(report.passed).toBe(true)
    })

    it("fails when node was not executed", () => {
      const report = runAssertions(
        { node_outputs: { z: { output: "x" } } },
        "completed",
        {},
        {},
        [],
      )
      expect(report.passed).toBe(false)
      expect(report.results[0].message).toContain("not executed")
    })

    it("checks node status", () => {
      const nodeResults = { "agent-risky": makeResult({ status: "failed" }) }
      const report = runAssertions(
        { node_outputs: { "agent-risky": { status: "failed" } } },
        "failed",
        {},
        nodeResults,
        [],
      )
      expect(report.passed).toBe(true)
    })
  })

  // ── Logs ───────────────────────────────────────────────────

  describe("logs assertions", () => {
    it("passes when log contains pattern", () => {
      const nodeResults = { "node-a": makeResult({ logLines: ["hello world"] }) }
      const report = runAssertions(
        { logs: { "node-a": { contains: ["hello"] } } },
        "completed",
        {},
        nodeResults,
        [],
      )
      expect(report.passed).toBe(true)
    })

    it("fails when log does not contain pattern", () => {
      const nodeResults = { "node-a": makeResult({ logLines: ["hello"] }) }
      const report = runAssertions(
        { logs: { "node-a": { contains: ["bye"] } } },
        "completed",
        {},
        nodeResults,
        [],
      )
      expect(report.passed).toBe(false)
    })

    it("passes when log does not contain not_contains pattern", () => {
      const nodeResults = { "node-a": makeResult({ logLines: ["hello"] }) }
      const report = runAssertions(
        { logs: { "node-a": { not_contains: ["error"] } } },
        "completed",
        {},
        nodeResults,
        [],
      )
      expect(report.passed).toBe(true)
    })

    it("fails when log contains not_contains pattern", () => {
      const nodeResults = { "node-a": makeResult({ logLines: ["error occurred"] }) }
      const report = runAssertions(
        { logs: { "node-a": { not_contains: ["error"] } } },
        "completed",
        {},
        nodeResults,
        [],
      )
      expect(report.passed).toBe(false)
    })
  })

  // ── Combined ───────────────────────────────────────────────

  describe("combined assertions", () => {
    it("passes when all assertions pass", () => {
      const nodeResults = {
        "a": makeResult({ lastOutput: "hello" }),
        "b": makeResult(),
      }
      const trace = makeTrace([{ nodeId: "a" }, { nodeId: "b" }])
      const report = runAssertions(
        {
          status: "completed",
          vars: { x: 1 },
          node_trace: { executed: ["a", "b"] },
          node_outputs: { "a": { output: "hello" } },
        },
        "completed",
        { x: 1 },
        nodeResults,
        trace,
      )
      expect(report.passed).toBe(true)
    })

    it("empty assertions pass", () => {
      const report = runAssertions({}, "completed", {}, {}, [])
      expect(report.passed).toBe(true)
      expect(report.results).toHaveLength(0)
    })
  })
})
