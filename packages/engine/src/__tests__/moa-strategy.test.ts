import { describe, it, expect, vi } from "vitest"
import { MoaStrategy } from "../executors/swarm/moa-strategy"
import type { MoaStrategyConfig } from "../executors/swarm/moa-strategy"
import type { SwarmServices, ExpertOutput } from "../executors/swarm/swarm-strategy"
import type { ExpertResult, HostOutput, BudgetStatus } from "../executors/swarm/swarm-types"
import type { ExpertDef } from "@octopus/shared"
import { MessageBus } from "../executors/swarm/message-bus"
import { SharedMemory } from "../executors/swarm/shared-memory"
import { ContextTierResolver } from "../executors/swarm/context-tier-resolver"

function makeExpert(overrides: Partial<ExpertDef> = {}): ExpertDef {
  return { role: "expert-a", ...overrides }
}

function makeConfig(overrides: Partial<MoaStrategyConfig> = {}): MoaStrategyConfig {
  return {
    mode: "review", // MoaStrategy doesn't use mode internally beyond config
    topic: "test topic",
    rounds: 1,
    consensusThreshold: 0.7,
    nodeId: "moa-node-1",
    failurePolicy: "continue_partial",
    contextTier: new ContextTierResolver(),
    ...overrides,
  }
}

function createMockServices(overrides: Partial<SwarmServices> = {}): SwarmServices {
  return {
    runExpert: vi.fn().mockImplementation(async (expert: ExpertDef) => ({
      output: `Output from ${expert.role}`,
      tokens: 100,
      inputTokens: 50,
      outputTokens: 50,
      files_changed: [],
      tools_used: [],
    })),
    runHost: vi.fn().mockImplementation(async () => ({
      synthesis: "Aggregated synthesis",
      assessment: undefined,
    })),
    checkBudget: vi.fn().mockReturnValue({
      status: "ok",
      consumed: 0,
      limit: null,
      percentage: 0,
    } as BudgetStatus),
    emit: vi.fn(),
    saveCheckpoint: vi.fn(),
    triggerHook: vi.fn(),
    llmCall: vi.fn().mockResolvedValue("llm response"),
    checkpointState: { currentRound: 0, consensusScore: null, expertResults: [] },
    ...overrides,
  }
}

describe("MoaStrategy", () => {
  // TC-011: 3 experts run in parallel — total time < sum of individual delays
  it("runs 3 experts in parallel", async () => {
    const services = createMockServices({
      runExpert: vi.fn().mockImplementation(
        async (expert: ExpertDef): Promise<ExpertOutput> => {
          await new Promise((r) => setTimeout(r, 100))
          return {
            output: `Output from ${expert.role}`,
            tokens: 100,
            inputTokens: 50,
            outputTokens: 50,
            files_changed: [],
            tools_used: [],
          }
        },
      ),
    })

    const strategy = new MoaStrategy(services, makeConfig({ rounds: 0 }))
    const experts = [
      makeExpert({ role: "e1" }),
      makeExpert({ role: "e2" }),
      makeExpert({ role: "e3" }),
    ]

    const start = Date.now()
    const result = await strategy.run(experts, new MessageBus(), new SharedMemory())
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(500)
    expect(result.experts).toHaveLength(3)
    expect(result.experts.every((e) => e.status === "completed")).toBe(true)
  })

  // TC-013: Aggregator receives all expert outputs
  it("passes all expert results to aggregator", async () => {
    const services = createMockServices()
    const strategy = new MoaStrategy(services, makeConfig({ rounds: 1 }))
    const experts = [
      makeExpert({ role: "e1" }),
      makeExpert({ role: "e2" }),
      makeExpert({ role: "e3" }),
    ]

    await strategy.run(experts, new MessageBus(), new SharedMemory())

    expect(services.runHost).toHaveBeenCalledOnce()
    const hostInputs = (services.runHost as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(hostInputs.expertOutputs).toHaveLength(3)
    expect(hostInputs.expertOutputs.map((e: ExpertResult) => e.role)).toEqual(["e1", "e2", "e3"])
    expect(hostInputs.host).toBeUndefined()
  })

  // TC-014: 1 expert fails, aggregator uses remaining 2
  it("continues with successful experts when one fails", async () => {
    const services = createMockServices({
      runExpert: vi.fn().mockImplementation(async (expert: ExpertDef) => {
        if (expert.role === "e2") throw new Error("e2 exploded")
        return {
          output: `Output from ${expert.role}`,
          tokens: 100,
          inputTokens: 50,
          outputTokens: 50,
          files_changed: [],
          tools_used: [],
        }
      }),
    })

    const strategy = new MoaStrategy(services, makeConfig({ rounds: 1 }))
    const experts = [
      makeExpert({ role: "e1" }),
      makeExpert({ role: "e2" }),
      makeExpert({ role: "e3" }),
    ]

    const result = await strategy.run(experts, new MessageBus(), new SharedMemory())

    expect(result.status).toBe("completed")
    expect(result.failed_experts).toEqual(["e2"])

    const hostInputs = (services.runHost as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(hostInputs.expertOutputs).toHaveLength(2)
    expect(hostInputs.expertOutputs.map((e: ExpertResult) => e.role)).toEqual(["e1", "e3"])
  })

  // TC-015: All experts fail → status=failed, runHost NOT called
  it("returns failed when all experts fail", async () => {
    const services = createMockServices({
      runExpert: vi.fn().mockRejectedValue(new Error("boom")),
    })

    const strategy = new MoaStrategy(services, makeConfig({ rounds: 1 }))
    const experts = [makeExpert({ role: "e1" }), makeExpert({ role: "e2" })]

    const result = await strategy.run(experts, new MessageBus(), new SharedMemory())

    expect(result.status).toBe("failed")
    expect(result.synthesis).toBe("All experts failed")
    expect(services.runHost).not.toHaveBeenCalled()
  })

  // TC-005: rounds=0 → skip aggregation, runHost NOT called
  it("skips aggregation when rounds=0", async () => {
    const services = createMockServices()
    const strategy = new MoaStrategy(services, makeConfig({ rounds: 0 }))
    const experts = [makeExpert({ role: "e1" }), makeExpert({ role: "e2" })]

    const result = await strategy.run(experts, new MessageBus(), new SharedMemory())

    expect(services.runHost).not.toHaveBeenCalled()
    expect(result.rounds_used).toBe(0)
    expect(result.synthesis).toContain("## e1")
    expect(result.synthesis).toContain("Output from e1")
    expect(result.synthesis).toContain("## e2")
    expect(result.synthesis).toContain("Output from e2")
  })

  // TC-004: rounds=1 → aggregator called exactly once
  it("calls aggregator exactly once when rounds=1", async () => {
    const services = createMockServices()
    const strategy = new MoaStrategy(services, makeConfig({ rounds: 1 }))
    const experts = [makeExpert({ role: "e1" }), makeExpert({ role: "e2" })]

    const result = await strategy.run(experts, new MessageBus(), new SharedMemory())

    expect(services.runHost).toHaveBeenCalledOnce()
    expect(result.rounds_used).toBe(1)
    expect(result.synthesis).toBe("Aggregated synthesis")
  })

  // C-1: rounds=2 → second round aggregator input includes first round synthesis
  it("feeds first round synthesis back as __moa_synthesis expert in round 2", async () => {
    const services = createMockServices({
      runHost: vi.fn()
        .mockImplementationOnce(async () => ({
          synthesis: "Round 1 synthesis",
          assessment: undefined,
        }))
        .mockImplementationOnce(async () => ({
          synthesis: "Round 2 final synthesis",
          assessment: undefined,
        })),
    })

    const strategy = new MoaStrategy(services, makeConfig({ rounds: 2 }))
    const experts = [makeExpert({ role: "e1" }), makeExpert({ role: "e2" })]

    const result = await strategy.run(experts, new MessageBus(), new SharedMemory())

    expect(services.runHost).toHaveBeenCalledTimes(2)
    expect(result.rounds_used).toBe(2)
    expect(result.synthesis).toBe("Round 2 final synthesis")

    // Second call should have __moa_synthesis expert with round 1's output
    const secondCallInputs = (services.runHost as ReturnType<typeof vi.fn>).mock.calls[1][0]
    expect(secondCallInputs.expertOutputs).toHaveLength(1)
    expect(secondCallInputs.expertOutputs[0].role).toBe("__moa_synthesis")
    expect(secondCallInputs.expertOutputs[0].output).toBe("Round 1 synthesis")
  })

  // Aggregator expert is passed as host to runHost
  it("passes aggregator as host to runHost", async () => {
    const aggExpert = makeExpert({ role: "moa-agg" })
    const services = createMockServices()
    const strategy = new MoaStrategy(services, makeConfig({ rounds: 1, aggregator: aggExpert }))
    const experts = [makeExpert({ role: "e1" })]

    await strategy.run(experts, new MessageBus(), new SharedMemory())

    const hostInputs = (services.runHost as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(hostInputs.host).toBe(aggExpert)
  })

  // Timeout: expert exceeding timeout is marked failed
  // ponytail: timeout is in seconds (consistent with BudgetTracker), so 0.05 = 50ms
  it("marks expert as failed on timeout", async () => {
    const services = createMockServices({
      runExpert: vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({
          output: "late",
          tokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          files_changed: [],
          tools_used: [],
        }), 500)),
      ),
    })

    const strategy = new MoaStrategy(services, makeConfig({ rounds: 0, timeout: 0.05 }))
    const experts = [makeExpert({ role: "slow" })]

    const result = await strategy.run(experts, new MessageBus(), new SharedMemory())

    expect(result.experts[0].status).toBe("failed")
    expect(result.experts[0].error).toContain("timeout")
  })

  // Token truncation: large outputs get truncated before aggregator
  it("truncates expert outputs exceeding MAX_AGG_INPUT_CHARS", async () => {
    const hugeOutput = "x".repeat(120_000)
    const services = createMockServices({
      runExpert: vi.fn().mockResolvedValue({
        output: hugeOutput,
        tokens: 30_000,
        inputTokens: 15_000,
        outputTokens: 15_000,
        files_changed: [],
        tools_used: [],
      }),
    })

    const strategy = new MoaStrategy(services, makeConfig({ rounds: 1 }))
    const experts = [makeExpert({ role: "e1" }), makeExpert({ role: "e2" })]

    await strategy.run(experts, new MessageBus(), new SharedMemory())

    const hostInputs = (services.runHost as ReturnType<typeof vi.fn>).mock.calls[0][0]
    for (const eo of hostInputs.expertOutputs) {
      expect(eo.output.length).toBeLessThan(120_000)
      expect(eo.output).toContain("输出已截断")
    }
  })

  // SSE events: expert_spawn/complete emitted by coordinator, not strategy.
  // Strategy emits lifecycle hooks + swarm_complete.
  it("emits swarm_complete SSE and lifecycle hooks for experts", async () => {
    const services = createMockServices()
    const strategy = new MoaStrategy(services, makeConfig({ rounds: 1 }))
    const experts = [makeExpert({ role: "e1" }), makeExpert({ role: "e2" })]

    await strategy.run(experts, new MessageBus(), new SharedMemory())

    // SSE: strategy only emits swarm_complete (expert_spawn/complete come from coordinator)
    const emitCalls = (services.emit as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    const eventTypes = emitCalls.map((e: { type: string }) => e.type)

    expect(eventTypes).not.toContain("expert_spawn")
    expect(eventTypes).not.toContain("expert_complete")
    expect(eventTypes).toContain("swarm_complete")
    expect(emitCalls.filter((e: { type: string }) => e.type === "swarm_complete")).toHaveLength(1)

    // Lifecycle hooks: strategy fires on_expert_spawn and on_expert_complete
    const hookCalls = (services.triggerHook as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(hookCalls.filter((h: string) => h === "on_expert_spawn")).toHaveLength(2)
    expect(hookCalls.filter((h: string) => h === "on_expert_complete")).toHaveLength(2)
    expect(hookCalls).toContain("on_swarm_start")
    expect(hookCalls).toContain("on_swarm_complete")
  })

  // TC-027: 10+ experts parallel without rate limit
  it("runs 10+ experts in parallel without rate limit", async () => {
    const services = createMockServices({
      runExpert: vi.fn().mockImplementation(
        async (expert: ExpertDef): Promise<ExpertOutput> => {
          await new Promise((r) => setTimeout(r, 100))
          return {
            output: `Output from ${expert.role}`,
            tokens: 100,
            inputTokens: 50,
            outputTokens: 50,
            files_changed: [],
            tools_used: [],
          }
        },
      ),
    })

    const strategy = new MoaStrategy(services, makeConfig({ rounds: 0 }))
    const experts = Array.from({ length: 12 }, (_, i) => makeExpert({ role: `e${i}` }))

    const start = Date.now()
    const result = await strategy.run(experts, new MessageBus(), new SharedMemory())
    const elapsed = Date.now() - start

    // 12 experts × 100ms serial = 1200ms, parallel should be < 250ms
    expect(elapsed).toBeLessThan(250)
    expect(result.experts).toHaveLength(12)
    expect(result.experts.every((e) => e.status === "completed")).toBe(true)
  })
})

  // H1 fix: timer leak — clearTimeout when expert completes before timeout
  it("clears timeout timer when expert completes before timeout", async () => {
    vi.useFakeTimers()
    try {
      const services = createMockServices({
        runExpert: vi.fn().mockImplementation(async (expert: ExpertDef) => ({
          output: `Output from ${expert.role}`,
          tokens: 100,
          inputTokens: 50,
          outputTokens: 50,
          files_changed: [],
          tools_used: [],
        })),
      })

      const clearTimeoutSpy = vi.spyOn(global, "clearTimeout")
      const strategy = new MoaStrategy(services, makeConfig({ rounds: 1, timeout: 120 }))
      const experts = [makeExpert({ role: "e1" })]

      const resultPromise = strategy.run(experts, new MessageBus(), new SharedMemory())
      // Let microtasks run (expert completes synchronously in mock)
      await vi.runAllTimersAsync()
      await resultPromise

      expect(clearTimeoutSpy).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  // H2 fix: budget exhaustion in aggregation loop stops early
  it("stops aggregation loop when budget exhausted between rounds", async () => {
    let budgetCalls = 0
    const services = createMockServices({
      checkBudget: vi.fn().mockImplementation(() => {
        budgetCalls++
        // Pre-fan-out: ok, round 1: ok, round 2: exhausted
        if (budgetCalls <= 2) {
          return { status: "ok", consumed: 0, limit: 100, percentage: 50 } as BudgetStatus
        }
        return { status: "exhausted", consumed: 100, limit: 100, percentage: 100 } as BudgetStatus
      }),
    })

    const strategy = new MoaStrategy(services, makeConfig({ rounds: 3 }))
    const experts = [makeExpert({ role: "e1" }), makeExpert({ role: "e2" })]

    const result = await strategy.run(experts, new MessageBus(), new SharedMemory())

    // runHost should only be called once (round 2 exits early)
    expect(services.runHost as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1)
    expect(result.rounds_used).toBe(1)
  })

  // M1 fix: aggregator failure returns partial synthesis
  it("returns partial synthesis when aggregator throws", async () => {
    const services = createMockServices({
      runHost: vi.fn().mockRejectedValue(new Error("LLM rate limit exceeded")),
    })

    const strategy = new MoaStrategy(services, makeConfig({ rounds: 1 }))
    const experts = [makeExpert({ role: "e1" }), makeExpert({ role: "e2" })]

    const result = await strategy.run(experts, new MessageBus(), new SharedMemory())

    // Should not be "failed" — graceful degradation
    expect(result.status).not.toBe("failed")
    expect(result.synthesis).toContain("Aggregation failed")
    expect(result.synthesis).toContain("Raw expert outputs")
    expect(result.synthesis).toContain("e1")
    expect(result.synthesis).toContain("e2")
  })

  // Budget pre-fan-out exhaustion
  it("returns budget_exhausted before launching experts when budget already consumed", async () => {
    const services = createMockServices({
      checkBudget: vi.fn().mockReturnValue({
        status: "exhausted",
        consumed: 100,
        limit: 100,
        percentage: 100,
      } as BudgetStatus),
    })

    const strategy = new MoaStrategy(services, makeConfig({ rounds: 1 }))
    const experts = [makeExpert({ role: "e1" }), makeExpert({ role: "e2" })]

    const result = await strategy.run(experts, new MessageBus(), new SharedMemory())

    expect(result.status).toBe("budget_exhausted")
    expect(result.budget_exhausted).toBe(true)
    expect(result.rounds_used).toBe(0)
    expect(result.experts).toHaveLength(0) // No experts launched
    expect(services.runExpert).not.toHaveBeenCalled()
  })

  // Aggregator rounds:0 with partial failures
  it("returns raw expert outputs when rounds=0 and some experts fail", async () => {
    const services = createMockServices({
      runExpert: vi.fn().mockImplementation(async (expert: ExpertDef) => {
        if (expert.role === "failing-expert") {
          throw new Error("Simulated failure")
        }
        return {
          output: `Output from ${expert.role}`,
          tokens: 100,
          inputTokens: 50,
          outputTokens: 50,
          files_changed: [],
          tools_used: [],
        }
      }),
    })

    const strategy = new MoaStrategy(services, makeConfig({ rounds: 0 }))
    const experts = [
      makeExpert({ role: "working" }),
      makeExpert({ role: "failing-expert" }),
    ]

    const result = await strategy.run(experts, new MessageBus(), new SharedMemory())

    expect(result.status).toBe("completed")
    expect(result.rounds_used).toBe(0)
    expect(result.synthesis).toContain("working")
    expect(result.synthesis).not.toContain("failing-expert")
    expect(result.failed_experts).toContain("failing-expert")
  })
