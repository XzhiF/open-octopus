import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
  JsonlLogger,
  sanitizeId,
  parseLogFilename,
} from "@octopus/engine"

// ── parseLogFilename ─────────────────────────────────────

describe("parseLogFilename", () => {
  it("returns nodeId for plain filename", () => {
    expect(parseLogFilename("my-node.jsonl")).toEqual({ nodeId: "my-node" })
  })

  it("returns nodeId for filename without .jsonl", () => {
    expect(parseLogFilename("setup")).toEqual({ nodeId: "setup" })
  })

  it("parses iteration filename", () => {
    expect(parseLogFilename("loop1-iter-3__inner-bash.jsonl")).toEqual({
      loopId: "loop1",
      iteration: 3,
      nodeId: "inner-bash",
    })
  })

  it("parses iteration filename with iteration 1", () => {
    expect(parseLogFilename("my-loop-iter-1__agent-node.jsonl")).toEqual({
      loopId: "my-loop",
      iteration: 1,
      nodeId: "agent-node",
    })
  })

  it("handles __ in prefix without iter pattern", () => {
    // Has __ but no -iter-N → not a loop file, treat entire base as nodeId
    expect(parseLogFilename("foo__bar__baz.jsonl")).toEqual({
      nodeId: "foo__bar__baz",
    })
  })

  it("handles loopId containing hyphens", () => {
    expect(parseLogFilename("my-cool-loop-iter-5__task.jsonl")).toEqual({
      loopId: "my-cool-loop",
      iteration: 5,
      nodeId: "task",
    })
  })

  it("handles double-digit iterations", () => {
    expect(parseLogFilename("loop-iter-42__node.jsonl")).toEqual({
      loopId: "loop",
      iteration: 42,
      nodeId: "node",
    })
  })
})

// ── sanitizeId ───────────────────────────────────────────

describe("sanitizeId", () => {
  it("passes through valid IDs unchanged", () => {
    expect(sanitizeId("my-node_123")).toBe("my-node_123")
  })

  it("replaces dots with underscores", () => {
    expect(sanitizeId("node.sub.id")).toBe("node_sub_id")
  })

  it("replaces spaces with underscores", () => {
    expect(sanitizeId("my node")).toBe("my_node")
  })

  it("escapes -iter-N suffix to prevent collision", () => {
    expect(sanitizeId("foo-iter-3")).toBe("foo_escaped")
  })

  it("escapes -iter-N even with large numbers", () => {
    expect(sanitizeId("loop-iter-999")).toBe("loop_escaped")
  })

  it("does NOT escape -iter- in the middle of the ID", () => {
    expect(sanitizeId("my-iter-3-node")).toBe("my-iter-3-node")
  })

  it("replaces special chars and escapes suffix", () => {
    expect(sanitizeId("a.b-iter-5")).toBe("a_b_escaped")
  })
})

// ── JsonlLogger loop context ─────────────────────────────

describe("JsonlLogger loop context", () => {
  let tmpDir: string
  let logger: JsonlLogger

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "log-iter-"))
    logger = new JsonlLogger(tmpDir, "test-exec")
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("writes to plain nodeId file without loop context", () => {
    logger.log("node1", "start", {})
    const logDir = join(tmpDir, "logs", "test-exec")
    const files = readdirSync(logDir)
    expect(files).toContain("node1.jsonl")
  })

  it("writes to iteration-scoped file when loop context is set", () => {
    logger.setLoopContext("loop1", 2)
    logger.log("inner-bash", "bash_log", { line: "hello" })
    const logDir = join(tmpDir, "logs", "test-exec")
    const files = readdirSync(logDir)
    expect(files).toContain("loop1-iter-2__inner-bash.jsonl")
  })

  it("includes iteration field in JSONL entry when loop context is set", () => {
    logger.setLoopContext("loop1", 3)
    logger.log("task", "start", {})
    const logDir = join(tmpDir, "logs", "test-exec")
    const content = readFileSync(join(logDir, "loop1-iter-3__task.jsonl"), "utf-8")
    const entry = JSON.parse(content.trim())
    expect(entry.iteration).toBe(3)
    expect(entry.nodeId).toBe("task")
    expect(entry.event).toBe("start")
  })

  it("does NOT include iteration field without loop context", () => {
    logger.log("node1", "start", {})
    const logDir = join(tmpDir, "logs", "test-exec")
    const content = readFileSync(join(logDir, "node1.jsonl"), "utf-8")
    const entry = JSON.parse(content.trim())
    expect(entry.iteration).toBeUndefined()
  })

  it("restoreLoopContext reverts to plain file", () => {
    const prev = logger.setLoopContext("loop1", 1)
    logger.log("a", "start", {})
    logger.restoreLoopContext(prev)
    logger.log("b", "start", {})
    const logDir = join(tmpDir, "logs", "test-exec")
    const files = readdirSync(logDir)
    expect(files).toContain("loop1-iter-1__a.jsonl")
    expect(files).toContain("b.jsonl")
  })

  it("sanitizes node IDs with dots in filenames", () => {
    logger.setLoopContext("loop.v2", 1)
    logger.log("task.sub", "start", {})
    const logDir = join(tmpDir, "logs", "test-exec")
    const files = readdirSync(logDir)
    expect(files).toContain("loop_v2-iter-1__task_sub.jsonl")
  })
})
