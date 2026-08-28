import { describe, it, expect } from "vitest"
import { AgentNodeRunner } from "../executors/agent-runner"
import { mergeAgentEvents } from "../logger"
import type { IAgentProvider, MessageChunk } from "@octopus/providers"
import type { AgentEvent } from "../executors/agent-types"

function makeMockProvider(chunks: MessageChunk[]): IAgentProvider {
  return {
    getType: () => "claude",
    sendQuery: async function* () {
      for (const c of chunks) yield c
    },
  }
}

describe("AgentNodeRunner — goal-task-dev (terminal + active_goal passthrough)", () => {
  it("error chunk WITH terminalReason does NOT throw — returns terminalReason + terminalMeta", async () => {
    const provider = makeMockProvider([
      { type: "text_delta", content: "counting: 3", messageId: "m1" },
      {
        type: "error",
        code: "error_max_turns",
        message: "max turns reached",
        terminalReason: "max_turns",
        numTurns: 4,
        costUsd: 0.12,
        sessionId: "sess-fuse",
      },
    ])

    const runner = new AgentNodeRunner(provider, "/tmp/test")
    const result = await runner.run({ prompt: "/goal 说出7", context: "new" })

    expect(result.terminalReason).toBe("max_turns")
    expect(result.terminalMeta).toEqual({ numTurns: 4, costUsd: 0.12 })
    expect(result.finalText).toBe("counting: 3")
    expect(result.sessionId).toBe("sess-fuse")
    // error event still recorded for observability
    expect(result.events.some((e) => e.type === "error")).toBe(true)
  })

  it("max_budget_usd terminal likewise returns, not throws", async () => {
    const provider = makeMockProvider([
      { type: "error", code: "error_max_budget_usd", message: "budget", terminalReason: "max_budget_usd", numTurns: 9, costUsd: 2.5 },
    ])
    const runner = new AgentNodeRunner(provider, "/tmp/test")
    const result = await runner.run({ prompt: "p", context: "new" })
    expect(result.terminalReason).toBe("max_budget_usd")
    expect(result.terminalMeta).toEqual({ numTurns: 9, costUsd: 2.5 })
  })

  it("error chunk WITHOUT terminalReason still throws (regression, AC3)", async () => {
    const provider = makeMockProvider([
      { type: "error", code: "rate_limit", message: "too many requests" },
    ])
    const runner = new AgentNodeRunner(provider, "/tmp/test")
    await expect(runner.run({ prompt: "p", context: "new" })).rejects.toThrow("too many requests")
  })

  it("active_goal chunks pass through into events (in order, fields preserved)", async () => {
    const provider = makeMockProvider([
      { type: "active_goal", condition: "说出 7", iterations: 1, last_reason: "said 5", set_at: 111 },
      { type: "active_goal", condition: "说出 7", iterations: 2, last_reason: "said 6", set_at: 222 },
      { type: "active_goal", condition: null, iterations: 0 }, // goal cleared (met)
      { type: "result", sessionId: "s1" },
    ])

    const events: AgentEvent[] = []
    const runner = new AgentNodeRunner(provider, "/tmp/test", (e) => events.push(e))
    const result = await runner.run({ prompt: "/goal 说出 7", context: "new" })

    const goals = result.events.filter((e) => e.type === "active_goal")
    expect(goals).toHaveLength(3)
    expect(goals[0]).toMatchObject({ condition: "说出 7", iterations: 1, last_reason: "said 5", set_at: 111 })
    // cleared signal stays null — no fabricated empty string
    expect(goals[2]).toMatchObject({ condition: null, iterations: 0 })
    expect(events).toHaveLength(3) // onEvent callback fired for each active_goal (result emits nothing)
  })

  it("forwards maxTurns/maxBudgetUsd/tools to provider sendQuery options (AC2 wire)", async () => {
    const calls: any[] = []
    const provider: IAgentProvider = {
      getType: () => "claude",
      sendQuery: async function* (_p, _c, _s, options) {
        calls.push(options)
        yield { type: "result", sessionId: "s" } as MessageChunk
      },
    }
    const runner = new AgentNodeRunner(provider, "/tmp/test")
    await runner.run({
      prompt: "p",
      context: "new",
      maxTurns: 7,
      maxBudgetUsd: 1.25,
      tools: ["Read", "Grep"],
      disallowedTools: ["Write"],
    })

    expect(calls[0].maxTurns).toBe(7)
    expect(calls[0].maxBudgetUsd).toBe(1.25)
    expect(calls[0].tools).toEqual(["Read", "Grep"])
    // interaction-blocking defaults preserved
    expect(calls[0].disallowedTools).toEqual(
      expect.arrayContaining(["AskUserQuestion", "complete_interaction", "Write"]),
    )
  })

  it("JSONL compaction (mergeAgentEvents) passes active_goal entries through — evidence chain lands intact", () => {
    const entries = [
      { timestamp: "t0", nodeId: "develop", event: "start" },
      { timestamp: "t1", nodeId: "develop", event: "agent_event", event_data: { type: "active_goal", condition: "说出 7", iterations: 2, last_reason: "reached 2" } },
      { timestamp: "t2", nodeId: "develop", event: "agent_event", event_data: { type: "text_delta", content: "3" } },
      { timestamp: "t3", nodeId: "develop", event: "agent_event", event_data: { type: "active_goal", condition: null, iterations: 0 } },
      { timestamp: "t4", nodeId: "develop", event: "end", status: "completed" },
    ]
    const merged = mergeAgentEvents(entries)
    const goals = merged.filter((e: any) => e.event === "agent_event" && e.event_data?.type === "active_goal")
    expect(goals).toHaveLength(2)
    expect(goals[0].event_data).toMatchObject({ condition: "说出 7", iterations: 2, last_reason: "reached 2" })
    expect(goals[1].event_data).toMatchObject({ condition: null, iterations: 0 })
  })
})
