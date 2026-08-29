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

describe("AgentExecutor — Goal Mode (/goal adapter)", () => {
  beforeEach(() => {
    mockRun.mockClear()
  })

  it("first line is `/goal <interpolated goal full text>`", async () => {
    const node = makeAgentNode({
      goal: "Analyze issue #$vars.issue_id root cause",
      constraints: ["Cannot modify files", "Must complete in 5 turns"],
    })
    const pool = new VarPool({ issue_id: "42" })
    const executor = new AgentExecutor(node, pool, { runner: mockRunner })
    await executor.execute()

    const prompt: string = mockRun.mock.calls[0][0].prompt
    const firstLine = prompt.split("\n")[0]
    // condition = goal 全文插值后,前置 /goal
    expect(firstLine).toBe("/goal Analyze issue #42 root cause")
    // constraints section stays
    expect(prompt).toContain("## Constraints")
    expect(prompt).toContain("- Cannot modify files")
    expect(prompt).toContain("- Must complete in 5 turns")
    // autonomy instructions stay
    expect(prompt).toContain("## Instructions")
    expect(prompt).toContain("autonomous agent")
  })

  it("no Allowed/Disallowed Tools prompt sections (SDK enforces, prompt doesn't fake it)", async () => {
    const node = makeAgentNode({
      goal: "Fix the bug",
      tools: ["Read", "Grep"],
      disallowed_tools: ["Write"],
    })
    const pool = new VarPool({})
    const executor = new AgentExecutor(node, pool, { runner: mockRunner })
    await executor.execute()

    const prompt: string = mockRun.mock.calls[0][0].prompt
    expect(prompt).not.toContain("## Allowed Tools")
    expect(prompt).not.toContain("## Disallowed Tools")
    expect(prompt).not.toContain("Verify your result")
  })

  it("builds standard prompt when node.prompt is set (no goal)", async () => {
    const node = makeAgentNode({ prompt: "Do this exactly" })
    const pool = new VarPool({})
    const executor = new AgentExecutor(node, pool, { runner: mockRunner })
    await executor.execute()

    const prompt = mockRun.mock.calls[0][0].prompt
    expect(prompt).toContain("Do this exactly")
    expect(prompt).not.toContain("/goal")
    expect(prompt).not.toContain("## Constraints")
  })

  it("injects previous node results FULL-LENGTH — >200-char output appears verbatim (no truncation)", async () => {
    const node = makeAgentNode({ goal: "Analyze results" })
    const longOutput = "X".repeat(150) + "MIDDLE_MARKER" + "Y".repeat(150) // 315 chars
    const pool = new VarPool({})
    const ctx = makeEngineContext({
      "build": { status: "completed", durationMs: 5000, lastOutput: "Build succeeded" },
      "test": { status: "failed", durationMs: 3000, lastOutput: longOutput },
    })
    const executor = new AgentExecutor(node, pool, { runner: mockRunner, engineContext: ctx })
    await executor.execute()

    const prompt: string = mockRun.mock.calls[0][0].prompt
    expect(prompt).toContain("## Previous Node Results")
    expect(prompt).toContain("- build: completed (5000ms)")
    expect(prompt).toContain("- test: failed (3000ms)")
    expect(prompt).toContain("Build succeeded")
    // full injection, no 200-char腰斩: tail beyond char 200 must be present verbatim
    expect(prompt).toContain(longOutput)
    expect(prompt).not.toContain("Y".repeat(150) + "...")
  })

  it("VarPool snapshot is FULL — >20 keys and >100-char values injected verbatim", async () => {
    const node = makeAgentNode({ goal: "Use variables" })
    const vars: Record<string, string> = {}
    for (let i = 0; i < 25; i++) vars[`key_${i}`] = `value_${i}`
    vars.long_value = "Z".repeat(200)
    const pool = new VarPool(vars)
    const executor = new AgentExecutor(node, pool, { runner: mockRunner })
    await executor.execute()

    const prompt: string = mockRun.mock.calls[0][0].prompt
    expect(prompt).toContain("## Available Variables")
    // 21st+ key (beyond old 20-key cap) present
    expect(prompt).toContain("$vars.key_24")
    expect(prompt).toContain("value_24")
    // value beyond old 100-char cap present verbatim (JSON.stringify → quoted)
    expect(prompt).toContain('"'.concat("Z".repeat(200)).concat('"'))
  })

  it("goal mode with no constraints omits constraints section", async () => {
    const node = makeAgentNode({ goal: "Simple task" })
    const pool = new VarPool({})
    const executor = new AgentExecutor(node, pool, { runner: mockRunner })
    await executor.execute()

    const prompt: string = mockRun.mock.calls[0][0].prompt
    expect(prompt).toContain("## Instructions")
    expect(prompt).not.toContain("## Constraints")
  })

  it("injects execution history from pool (_execution_history)", async () => {
    const node = makeAgentNode({ goal: "Learn from past runs" })
    const pool = new VarPool({})
    pool.set("_execution_history", "### Run 1 (2024-01-01, completed)\nAll good.")
    const executor = new AgentExecutor(node, pool, { runner: mockRunner })
    await executor.execute()

    const prompt: string = mockRun.mock.calls[0][0].prompt
    expect(prompt).toContain("## Previous Execution History")
    expect(prompt).toContain("### Run 1")
    expect(prompt).toContain("All good.")
  })

  it("adds agent role suffix in goal mode", async () => {
    const node = makeAgentNode({ goal: "Do task", agent: "architect" })
    const pool = new VarPool({})
    const executor = new AgentExecutor(node, pool, { runner: mockRunner })
    await executor.execute()

    const prompt: string = mockRun.mock.calls[0][0].prompt
    expect(prompt).toContain("architect")
  })
})

describe("AgentExecutor — node field resolution (AC2/AC4)", () => {
  beforeEach(() => {
    mockRun.mockClear()
  })

  it("passes maxTurns/maxBudgetUsd resolved from number literals", async () => {
    const node = makeAgentNode({ goal: "g", max_turns: 5, max_budget_usd: 1.5 })
    const pool = new VarPool({})
    const executor = new AgentExecutor(node, pool, { runner: mockRunner })
    await executor.execute()

    const opts = mockRun.mock.calls[0][0]
    expect(opts.maxTurns).toBe(5)
    expect(opts.maxBudgetUsd).toBe(1.5)
  })

  it("resolves string fields via variable substitution ($inputs.max_turns)", async () => {
    const node = makeAgentNode({ goal: "g", max_turns: "$inputs.max_turns", max_budget_usd: "$vars.cap" })
    const pool = new VarPool({ max_turns: "12", cap: "3" })
    const executor = new AgentExecutor(node, pool, { runner: mockRunner })
    await executor.execute()

    const opts = mockRun.mock.calls[0][0]
    expect(opts.maxTurns).toBe(12)
    expect(opts.maxBudgetUsd).toBe(3)
  })

  it("invalid string → undefined (unset) — warn, not crash", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const node = makeAgentNode({ goal: "g", max_turns: "not-a-number" })
    const pool = new VarPool({})
    const executor = new AgentExecutor(node, pool, { runner: mockRunner })
    await executor.execute()

    const opts = mockRun.mock.calls[0][0]
    expect(opts.maxTurns).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    warnSpy.mockRestore()
  })

  it("empty/unset string → undefined without warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const node = makeAgentNode({ goal: "g", max_turns: "" })
    const pool = new VarPool({})
    const executor = new AgentExecutor(node, pool, { runner: mockRunner })
    await executor.execute()

    const opts = mockRun.mock.calls[0][0]
    expect(opts.maxTurns).toBeUndefined()
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("passes tools/disallowedTools straight through", async () => {
    const node = makeAgentNode({ goal: "g", tools: ["Read", "Grep"], disallowed_tools: ["Write"] })
    const pool = new VarPool({})
    const executor = new AgentExecutor(node, pool, { runner: mockRunner })
    await executor.execute()

    const opts = mockRun.mock.calls[0][0]
    expect(opts.tools).toEqual(["Read", "Grep"])
    expect(opts.disallowedTools).toEqual(["Write"])
  })
})

describe("AgentExecutor — terminal mapping (AC4)", () => {
  it("terminalReason max_turns → status failed + goal_not_met + evidence from last active_goal + terminalMeta", async () => {
    const runnerWithTerminal = {
      run: vi.fn().mockResolvedValue({
        finalText: "partial work",
        durationMs: 900,
        sessionId: "sess-t",
        events: [
          { type: "active_goal", condition: "说出 7", iterations: 2, last_reason: "not yet", timestamp: 1 },
          { type: "active_goal", condition: "说出 7", iterations: 4, last_reason: "still counting", timestamp: 2 },
        ],
        terminalReason: "max_turns",
        terminalMeta: { numTurns: 5, costUsd: 0.42 },
      }),
      getCwd: () => "/tmp/test",
      getLastActivityAt: () => Date.now(),
    } as any
    const node = makeAgentNode({ goal: "说出 7", max_turns: 3 })
    const pool = new VarPool({})
    const executor = new AgentExecutor(node, pool, { runner: runnerWithTerminal })
    const result = await executor.execute()

    expect(result.status).toBe("failed")
    expect(result.error).toContain("goal_not_met")
    expect(result.error).toContain("max_turns")
    expect(result.outputs.last_output).toBe("partial work")
    expect(result.outputs.goal_evidence).toEqual({
      iterations: 4,
      last_reason: "still counting",
      numTurns: 5,
      costUsd: 0.42,
    })
    // events still flow through for observability
    expect(result.events).toHaveLength(2)
  })

  it("terminalReason without active_goal events → evidence only has terminalMeta", async () => {
    const runnerWithTerminal = {
      run: vi.fn().mockResolvedValue({
        finalText: "",
        durationMs: 100,
        events: [],
        terminalReason: "max_budget_usd",
        terminalMeta: { numTurns: 7, costUsd: 2.0 },
      }),
      getCwd: () => "/tmp/test",
      getLastActivityAt: () => Date.now(),
    } as any
    const node = makeAgentNode({ goal: "g", max_budget_usd: 2 })
    const executor = new AgentExecutor(node, new VarPool({}), { runner: runnerWithTerminal })
    const result = await executor.execute()

    expect(result.status).toBe("failed")
    expect(result.error).toBe("goal_not_met (max_budget_usd)")
    expect(result.outputs.goal_evidence).toEqual({ numTurns: 7, costUsd: 2.0 })
  })

  it("no terminalReason → completed as before (prompt mode unchanged path)", async () => {
    const node = makeAgentNode({ prompt: "say hi" })
    const pool = new VarPool({})
    const executor = new AgentExecutor(node, pool, { runner: mockRunner })
    const result = await executor.execute()

    expect(result.status).toBe("completed")
    expect(result.outputs.goal_evidence).toBeUndefined()
  })
})
