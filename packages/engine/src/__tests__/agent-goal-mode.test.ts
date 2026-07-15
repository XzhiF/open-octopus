import { describe, it, expect, vi, beforeEach } from "vitest"
import { AgentExecutor } from "../executors/agent"
import type { EngineContext } from "../executors/agent"
import { VarPool } from "@octopus/shared"
import type { NodeDef } from "@octopus/shared"
import type { NodeExecutionResult } from "../executors/types"

// Mock the AgentNodeRunner
const mockRun = vi.fn().mockResolvedValue({
  finalText: "Agent output",
  durationMs: 100,
  sessionId: "session-1",
  tokens: { inputTokens: 10, outputTokens: 20 },
  modelUsages: [],
  events: [],
})

const mockRunner = {
  run: mockRun,
  getCwd: () => "/tmp/test",
  getLastActivityAt: () => Date.now(),
} as any

function makeAgentNode(overrides: Partial<NodeDef> = {}): NodeDef {
  return {
    id: "test-agent",
    type: "agent",
    ...overrides,
  }
}

function makeEngineContext(results: Record<string, Partial<NodeExecutionResult>> = {}): EngineContext {
  const nodeResults: Record<string, NodeExecutionResult> = {}
  for (const [id, r] of Object.entries(results)) {
    nodeResults[id] = {
      outputs: r.outputs ?? {},
      status: r.status ?? "completed",
      durationMs: r.durationMs ?? 100,
      logLines: r.logLines ?? [],
      lastOutput: r.lastOutput,
    }
  }
  return { nodeResults }
}

describe("AgentExecutor — Goal Mode", () => {
  beforeEach(() => {
    mockRun.mockClear()
  })

  it("builds goal-mode prompt when node.goal is set", async () => {
    const node = makeAgentNode({
      goal: "Analyze issue #42 root cause",
      constraints: ["Cannot modify files", "Must complete in 5 turns"],
    })
    const pool = new VarPool({})
    const executor = new AgentExecutor(node, pool, { runner: mockRunner })
    await executor.execute()

    const prompt = mockRun.mock.calls[0][0].prompt
    expect(prompt).toContain("## Goal")
    expect(prompt).toContain("Analyze issue #42 root cause")
    expect(prompt).toContain("## Constraints")
    expect(prompt).toContain("- Cannot modify files")
    expect(prompt).toContain("- Must complete in 5 turns")
    expect(prompt).toContain("## Instructions")
    expect(prompt).toContain("autonomous agent")
  })

  it("builds standard prompt when node.prompt is set (no goal)", async () => {
    const node = makeAgentNode({ prompt: "Do this exactly" })
    const pool = new VarPool({})
    const executor = new AgentExecutor(node, pool, { runner: mockRunner })
    await executor.execute()

    const prompt = mockRun.mock.calls[0][0].prompt
    expect(prompt).toContain("Do this exactly")
    expect(prompt).not.toContain("## Goal")
    expect(prompt).not.toContain("## Constraints")
  })

  it("injects planning tools into goal-mode prompt", async () => {
    const node = makeAgentNode({
      goal: "Fix the bug",
      planning: {
        tools: ["read", "grep", "glob"],
        disallowed_tools: ["write"],
        verify: true,
      },
    })
    const pool = new VarPool({})
    const executor = new AgentExecutor(node, pool, { runner: mockRunner })
    await executor.execute()

    const prompt = mockRun.mock.calls[0][0].prompt
    expect(prompt).toContain("## Allowed Tools")
    expect(prompt).toContain("- read")
    expect(prompt).toContain("- grep")
    expect(prompt).toContain("## Disallowed Tools")
    expect(prompt).toContain("- write")
    expect(prompt).toContain("4. Verify your result before finishing")
  })

  it("omits verify instruction when planning.verify is false", async () => {
    const node = makeAgentNode({
      goal: "Fix the bug",
      planning: { verify: false },
    })
    const pool = new VarPool({})
    const executor = new AgentExecutor(node, pool, { runner: mockRunner })
    await executor.execute()

    const prompt = mockRun.mock.calls[0][0].prompt
    expect(prompt).not.toContain("Verify your result")
  })

  it("injects previous node results via engineContext", async () => {
    const node = makeAgentNode({ goal: "Analyze results" })
    const pool = new VarPool({})
    const ctx = makeEngineContext({
      "build": { status: "completed", durationMs: 5000, lastOutput: "Build succeeded" },
      "test": { status: "failed", durationMs: 3000, lastOutput: "Test failed: assertion error" },
    })
    const executor = new AgentExecutor(node, pool, { runner: mockRunner, engineContext: ctx })
    await executor.execute()

    const prompt = mockRun.mock.calls[0][0].prompt
    expect(prompt).toContain("## Previous Node Results")
    expect(prompt).toContain("- build: completed (5000ms)")
    expect(prompt).toContain("- test: failed (3000ms)")
    expect(prompt).toContain("Build succeeded")
  })

  it("injects VarPool snapshot into goal context", async () => {
    const node = makeAgentNode({ goal: "Use variables" })
    const pool = new VarPool({ issue_id: "42", branch: "main" })
    const executor = new AgentExecutor(node, pool, { runner: mockRunner })
    await executor.execute()

    const prompt = mockRun.mock.calls[0][0].prompt
    expect(prompt).toContain("## Available Variables")
    expect(prompt).toContain("$vars.issue_id")
    expect(prompt).toContain("$vars.branch")
  })

  it("substitutes variables in goal text", async () => {
    const node = makeAgentNode({ goal: "Analyze issue #$vars.issue_id" })
    const pool = new VarPool({ issue_id: "42" })
    const executor = new AgentExecutor(node, pool, { runner: mockRunner })
    await executor.execute()

    const prompt = mockRun.mock.calls[0][0].prompt
    expect(prompt).toContain("Analyze issue #42")
  })

  it("injects execution history from pool (_execution_history)", async () => {
    const node = makeAgentNode({ goal: "Learn from past runs" })
    const pool = new VarPool({})
    pool.set("_execution_history", "### Run 1 (2024-01-01, completed)\nAll good.")
    const executor = new AgentExecutor(node, pool, { runner: mockRunner })
    await executor.execute()

    const prompt = mockRun.mock.calls[0][0].prompt
    expect(prompt).toContain("## Previous Execution History")
    expect(prompt).toContain("### Run 1")
    expect(prompt).toContain("All good.")
  })

  it("adds agent role suffix in goal mode", async () => {
    const node = makeAgentNode({ goal: "Do task", agent: "architect" })
    const pool = new VarPool({})
    const executor = new AgentExecutor(node, pool, { runner: mockRunner })
    await executor.execute()

    const prompt = mockRun.mock.calls[0][0].prompt
    expect(prompt).toContain("architect")
  })

  it("goal mode with no constraints omits constraints section", async () => {
    const node = makeAgentNode({ goal: "Simple task" })
    const pool = new VarPool({})
    const executor = new AgentExecutor(node, pool, { runner: mockRunner })
    await executor.execute()

    const prompt = mockRun.mock.calls[0][0].prompt
    expect(prompt).toContain("## Goal")
    expect(prompt).not.toContain("## Constraints")
  })
})
