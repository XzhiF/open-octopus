import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { JsonlLogger, isMergedEvent, MERGED_EVENT_TYPES } from "../logger"
import type { MergedEventType } from "../logger"
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

const BASE = new Date("2026-01-01T00:00:00.000Z").getTime()

function ts(offsetMs: number): string {
  return new Date(BASE + offsetMs).toISOString()
}

function makeEntry(event: string, data: Record<string, any> = {}): any {
  return { timestamp: ts(0), nodeId: "n1", event, ...data }
}

function agentEntry(subType: string, eventData: Record<string, any> = {}): any {
  return makeEntry("agent_event", { event_data: { type: subType, ...eventData } })
}

/** Expose mergeEvents for direct unit testing (private method). */
function invokeMerge(logger: JsonlLogger, entries: any[]): any[] {
  return (logger as any).mergeEvents(entries)
}

describe("JSONL log compaction", () => {
  let tmpDir: string
  let logger: JsonlLogger

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "log-compact-"))
    logger = new JsonlLogger(tmpDir, "test-exec")
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── P1.1: thinking merge ──────────────────────────────────

  it("merges thinking fragments into thinking_block", () => {
    const t0 = ts(0), t1 = ts(1), t2 = ts(2), t3 = ts(3)
    const entries = [
      { ...agentEntry("thinking_start"), timestamp: t0 },
      { ...agentEntry("thinking", { content: "step 1 " }), timestamp: t1 },
      { ...agentEntry("thinking", { content: "step 2" }), timestamp: t2 },
      { ...agentEntry("thinking_done"), timestamp: t3 },
    ]

    const result = invokeMerge(logger, entries)

    expect(result).toHaveLength(1)
    expect(result[0].event).toBe("thinking_block")
    expect(result[0].content).toBe("step 1 step 2")
    expect(result[0].startedAt).toBe(t0)
    expect(result[0].completedAt).toBe(t3)
  })

  // ── P1.1: text_delta merge ────────────────────────────────

  it("merges consecutive text_delta into text_block", () => {
    const entries = [
      { ...agentEntry("text_delta", { content: "Hello " }), timestamp: ts(0) },
      { ...agentEntry("text_delta", { content: "world" }), timestamp: ts(1) },
    ]

    const result = invokeMerge(logger, entries)

    expect(result).toHaveLength(1)
    expect(result[0].event).toBe("text_block")
    expect(result[0].content).toBe("Hello world")
  })

  // ── P1.1: tool merge ──────────────────────────────────────

  it("merges tool fragments into tool_call", () => {
    const t0 = ts(0), t1 = ts(1), t2 = ts(2)
    const entries = [
      { ...agentEntry("tool_start", { tool_use_id: "tc-1", tool: "Read" }), timestamp: t0 },
      { ...agentEntry("tool_input", { input: '{"path":"/foo"}' }), timestamp: t1 },
      { ...agentEntry("tool_result", { content: "file contents", is_error: false }), timestamp: t2 },
    ]

    const result = invokeMerge(logger, entries)

    expect(result).toHaveLength(1)
    expect(result[0].event).toBe("tool_call")
    expect(result[0].toolCallId).toBe("tc-1")
    expect(result[0].toolName).toBe("Read")
    expect(result[0].input).toBe('{"path":"/foo"}')
    expect(result[0].result).toBe("file contents")
    expect(result[0].isError).toBe(false)
    expect(result[0].startedAt).toBe(t0)
    expect(result[0].completedAt).toBe(t2)
  })

  // ── P1.1: start/end pass through ──────────────────────────

  it("passes start and end lines through unchanged", () => {
    const start = makeEntry("start", { type: "bash" })
    const end = makeEntry("end", { status: "completed", durationMs: 100 })
    const entries = [start, end]

    const result = invokeMerge(logger, entries)

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual(start)
    expect(result[1]).toEqual(end)
  })

  // ── P1.1: startedAt / completedAt ────────────────────────

  it("merged events include startedAt and completedAt", () => {
    const t10 = ts(10), t20 = ts(20)
    const entries = [
      { ...agentEntry("text_delta", { content: "a" }), timestamp: t10 },
      { ...agentEntry("text_delta", { content: "b" }), timestamp: t20 },
    ]

    const result = invokeMerge(logger, entries)

    expect(result[0].startedAt).toBe(t10)
    expect(result[0].completedAt).toBe(t20)
  })

  // ── P1.3: bash_log merge ──────────────────────────────────

  it("merges consecutive bash_log into bash_output", () => {
    const t0 = ts(0), t1 = ts(1), t2 = ts(2)
    const entries = [
      { ...makeEntry("bash_log", { line: "line1\n" }), timestamp: t0 },
      { ...makeEntry("bash_log", { line: "line2\n" }), timestamp: t1 },
      { ...makeEntry("bash_log", { line: "line3\n" }), timestamp: t2 },
    ]

    const result = invokeMerge(logger, entries)

    expect(result).toHaveLength(1)
    expect(result[0].event).toBe("bash_output")
    expect(result[0].lines).toEqual(["line1\n", "line2\n", "line3\n"])
    expect(result[0].startedAt).toBe(t0)
    expect(result[0].completedAt).toBe(t2)
  })

  // ── P1.3: bash_stderr merge ───────────────────────────────

  it("merges consecutive bash_stderr into bash_stderr event", () => {
    const entries = [
      { ...makeEntry("bash_stderr", { line: "err1" }), timestamp: ts(0) },
      { ...makeEntry("bash_stderr", { line: "err2" }), timestamp: ts(1) },
    ]

    const result = invokeMerge(logger, entries)

    expect(result).toHaveLength(1)
    expect(result[0].event).toBe("bash_stderr")
    expect(result[0].content).toBe("err1err2")
  })

  // ── P1.3: python merge ────────────────────────────────────

  it("merges python_log into python_output and python_stderr into python_stderr", () => {
    const entries = [
      { ...makeEntry("python_log", { line: "out1" }), timestamp: ts(0) },
      { ...makeEntry("python_log", { line: "out2" }), timestamp: ts(1) },
      { ...makeEntry("python_stderr", { line: "pyerr1" }), timestamp: ts(2) },
      { ...makeEntry("python_stderr", { line: "pyerr2" }), timestamp: ts(3) },
    ]

    const result = invokeMerge(logger, entries)

    expect(result).toHaveLength(2)
    expect(result[0].event).toBe("python_output")
    expect(result[0].lines).toEqual(["out1", "out2"])
    expect(result[1].event).toBe("python_stderr")
    expect(result[1].content).toBe("pyerr1pyerr2")
  })

  // ── P1.2: compactFile reduces line count ──────────────────

  it("compactFile reduces line count", () => {
    const nodeId = "compact-test"
    // Write 10 bash_log lines
    for (let i = 0; i < 10; i++) {
      logger.log(nodeId, "bash_log", { line: `line${i}\n` })
    }

    const logFile = join(logger.getLogDir(), `${nodeId}.jsonl`)
    const before = readFileSync(logFile, "utf8").split("\n").filter(Boolean).length
    expect(before).toBe(10)

    logger.compactFile(nodeId)

    const after = readFileSync(logFile, "utf8").split("\n").filter(Boolean).length
    expect(after).toBeLessThan(before)
    // Should be 1 merged bash_output
    const parsed = JSON.parse(readFileSync(logFile, "utf8").split("\n")[0])
    expect(parsed.event).toBe("bash_output")
    expect(parsed.lines).toHaveLength(10)
  })

  // ── P1.1/P1.2: idempotent ────────────────────────────────

  it("compact is idempotent: second compact produces same result", () => {
    const nodeId = "idempotent-test"
    // Write agent events
    logger.log(nodeId, "agent_event", { event_data: { type: "text_delta", content: "Hello " } })
    logger.log(nodeId, "agent_event", { event_data: { type: "text_delta", content: "world" } })
    logger.log(nodeId, "agent_event", { event_data: { type: "text_delta", content: "!" } })

    logger.compactFile(nodeId)
    const first = readFileSync(join(logger.getLogDir(), `${nodeId}.jsonl`), "utf8")

    logger.compactFile(nodeId)
    const second = readFileSync(join(logger.getLogDir(), `${nodeId}.jsonl`), "utf8")

    expect(second).toBe(first)
  })

  // ── P1.5: branch_start/branch_end ────────────────────────

  it("branch_start and branch_end pass through merge unchanged", () => {
    const entries = [
      makeEntry("branch_start", { iteration: 1 }),
      makeEntry("bash_log", { line: "hello\n" }),
      makeEntry("branch_end", { iteration: 1, status: "completed" }),
    ]

    const result = invokeMerge(logger, entries)

    expect(result).toHaveLength(3)
    expect(result[0].event).toBe("branch_start")
    expect(result[1].event).toBe("bash_output")
    expect(result[2].event).toBe("branch_end")
  })

  // ── Exports ───────────────────────────────────────────────

  it("isMergedEvent and MERGED_EVENT_TYPES work correctly", () => {
    expect(isMergedEvent({ event: "thinking_block" })).toBe(true)
    expect(isMergedEvent({ event: "text_block" })).toBe(true)
    expect(isMergedEvent({ event: "tool_call" })).toBe(true)
    expect(isMergedEvent({ event: "bash_output" })).toBe(true)
    expect(isMergedEvent({ event: "start" })).toBe(false)
    expect(isMergedEvent({ event: "agent_event" })).toBe(false)
    expect(MERGED_EVENT_TYPES.size).toBe(7)
  })

  // ── Mixed sequence ────────────────────────────────────────

  it("handles mixed agent event sequence correctly", () => {
    const entries = [
      makeEntry("start", { type: "agent" }),
      { ...agentEntry("thinking_start"), timestamp: ts(0) },
      { ...agentEntry("thinking", { content: "hmm" }), timestamp: ts(1) },
      { ...agentEntry("thinking_done"), timestamp: ts(2) },
      { ...agentEntry("text_delta", { content: "Answer: " }), timestamp: ts(3) },
      { ...agentEntry("text_delta", { content: "42" }), timestamp: ts(4) },
      { ...agentEntry("tool_start", { tool_use_id: "t1", tool: "Bash" }), timestamp: ts(5) },
      { ...agentEntry("tool_input", { input: "echo hi" }), timestamp: ts(6) },
      { ...agentEntry("tool_result", { content: "hi", is_error: false }), timestamp: ts(7) },
      { ...agentEntry("text_delta", { content: "Done." }), timestamp: ts(8) },
      makeEntry("end", { status: "completed", durationMs: 100 }),
    ]

    const result = invokeMerge(logger, entries)

    // start, thinking_block, text_block("Answer: 42"), tool_call, text_block("Done."), end
    expect(result).toHaveLength(6)
    expect(result[0].event).toBe("start")
    expect(result[1].event).toBe("thinking_block")
    expect(result[1].content).toBe("hmm")
    expect(result[2].event).toBe("text_block")
    expect(result[2].content).toBe("Answer: 42")
    expect(result[3].event).toBe("tool_call")
    expect(result[3].toolName).toBe("Bash")
    expect(result[4].event).toBe("text_block")
    expect(result[4].content).toBe("Done.")
    expect(result[5].event).toBe("end")
  })

  it("nested loop context: save/restore preserves outer loop scoping", () => {
    // Outer loop sets context
    const outerPrev = logger.setLoopContext("outer-loop", 1)
    logger.log("node-a", "start", {})

    // Inner loop overwrites context, saving outer's
    const innerPrev = logger.setLoopContext("inner-loop", 1)
    logger.log("node-b", "start", {})

    // Inner loop restores outer's context
    logger.restoreLoopContext(innerPrev)
    logger.log("node-c", "start", {})

    // Outer loop restores to no context
    logger.restoreLoopContext(outerPrev)
    logger.log("node-d", "start", {})

    const logDir = join(tmpDir, "logs", "test-exec")
    const files = readdirSync(logDir)

    // node-a and node-c should be in outer loop's iteration file
    expect(files).toContain("outer-loop-iter-1__node-a.jsonl")
    expect(files).toContain("outer-loop-iter-1__node-c.jsonl")
    // node-b should be in inner loop's iteration file
    expect(files).toContain("inner-loop-iter-1__node-b.jsonl")
    // node-d should be in plain file (no loop context)
    expect(files).toContain("node-d.jsonl")
  })
})
