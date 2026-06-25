import { describe, it, expect, vi, beforeEach } from "vitest"
import { DiscussionStrategy } from "../executors/swarm/discussion-strategy"
import type { SwarmServices, SwarmStrategyConfig, ExpertOutput } from "../executors/swarm/swarm-strategy"
import type { SwarmResult, ExpertResult, Message, HostOutput, BudgetStatus, SwarmSSEEvent } from "../executors/swarm/swarm-types"
import type { ExpertDef } from "@octopus/shared"
import { MessageBus } from "../executors/swarm/message-bus"
import { SharedMemory } from "../executors/swarm/shared-memory"
import { ContextTierResolver } from "../executors/swarm/context-tier-resolver"

function makeExpert(overrides: Partial<ExpertDef> = {}): ExpertDef {
  return {
    role: "expert-a",
    prompt: "default prompt",
    ...overrides,
  }
}

function makeConfig(overrides: Partial<SwarmStrategyConfig> = {}): SwarmStrategyConfig {
  return {
    mode: "review",
    topic: "test topic",
    rounds: 3,
    consensusThreshold: 0.7,
    nodeId: "node-1",
    failurePolicy: "continue_partial",
    contextTier: new ContextTierResolver(),
    ...overrides,
  }
}

function makeExpertOutput(role: string): ExpertOutput {
  return {
    output: `output from ${role}`,
    tokens: 100,
    files_changed: [],
    tools_used: [],
  }
}

function makeHostOutput(overrides: Partial<HostOutput> = {}): HostOutput {
  return {
    synthesis: "host synthesis",
    ...overrides,
  }
}

function makeHostOutputWithConsensus(score: number, shouldContinue: boolean): HostOutput {
  return {
    synthesis: "host synthesis",
    assessment: {
      consensus_score: score,
      key_agreements: ["agree"],
      key_disagreements: [],
      should_continue: shouldContinue,
      confidence: 0.8,
    },
  }
}

function createMockServices(
  expertHandler?: (expert: ExpertDef, prompt: string, round: number) => Promise<ExpertOutput>,
  hostHandler?: (inputs: any) => Promise<HostOutput>,
): SwarmServices {
  return {
    runExpert: expertHandler ?? vi.fn().mockImplementation(async (expert: ExpertDef) => makeExpertOutput(expert.role)),
    runHost: hostHandler ?? vi.fn().mockResolvedValue(makeHostOutput()),
    checkBudget: vi.fn().mockReturnValue({ status: "ok", consumed: 0, limit: null, percentage: 0 } as BudgetStatus),
    emit: vi.fn(),
    saveCheckpoint: vi.fn(),
    triggerHook: vi.fn(),
  }
}

describe("DiscussionStrategy", () => {
  let bus: MessageBus
  let memory: SharedMemory

  beforeEach(() => {
    bus = new MessageBus()
    memory = new SharedMemory()
  })

  describe("review mode", () => {
    it("runs all experts in exactly 1 round", async () => {
      const experts = [makeExpert({ role: "a" }), makeExpert({ role: "b" }), makeExpert({ role: "c" })]
      const services = createMockServices()
      const config = makeConfig({ mode: "review" })

      const strategy = new DiscussionStrategy(services, config)
      const result = await strategy.run(experts, bus, memory)

      expect(result.rounds_used).toBe(1)
      expect(result.expert_count).toBe(3)
      expect(result.experts).toHaveLength(3)
      expect(services.runExpert).toHaveBeenCalledTimes(3)
    })

    it("does not check consensus in review mode", async () => {
      const experts = [makeExpert({ role: "a" }), makeExpert({ role: "b" })]
      const services = createMockServices()
      const config = makeConfig({ mode: "review" })

      const strategy = new DiscussionStrategy(services, config)
      await strategy.run(experts, bus, memory)

      // runHost is only called once for final synthesis, not for consensus checks
      expect(services.runHost).toHaveBeenCalledTimes(1)
    })

    it("produces correct synthesis from host", async () => {
      const experts = [makeExpert({ role: "reviewer" })]
      const services = createMockServices(undefined, vi.fn().mockResolvedValue(makeHostOutput({ synthesis: "review synthesis" })))
      const config = makeConfig({ mode: "review" })

      const strategy = new DiscussionStrategy(services, config)
      const result = await strategy.run(experts, bus, memory)

      expect(result.synthesis).toBe("review synthesis")
      expect(result.status).toBe("completed")
    })

    it("handles expert failures gracefully", async () => {
      const experts = [makeExpert({ role: "good" }), makeExpert({ role: "bad" })]
      const services = createMockServices(
        vi.fn().mockImplementation(async (expert: ExpertDef) => {
          if (expert.role === "bad") throw new Error("expert failed")
          return makeExpertOutput(expert.role)
        }),
      )
      const config = makeConfig({ mode: "review" })

      const strategy = new DiscussionStrategy(services, config)
      const result = await strategy.run(experts, bus, memory)

      const goodResult = result.experts.find(e => e.role === "good")
      const badResult = result.experts.find(e => e.role === "bad")
      expect(goodResult?.status).toBe("completed")
      expect(badResult?.status).toBe("failed")
      expect(result.failed_experts).toContain("bad")
    })
  })

  describe("debate mode", () => {
    it("runs multiple rounds with consensus check", async () => {
      const experts = [makeExpert({ role: "a" }), makeExpert({ role: "b" })]
      const hostMock = vi.fn()
        .mockResolvedValueOnce(makeHostOutputWithConsensus(0.3, true))   // round 1 check
        .mockResolvedValueOnce(makeHostOutputWithConsensus(0.5, true))   // round 2 check
        .mockResolvedValueOnce(makeHostOutput({ synthesis: "final synthesis" }))  // final synthesis

      const services = createMockServices(undefined, hostMock)
      const config = makeConfig({ mode: "debate", rounds: 3 })

      const strategy = new DiscussionStrategy(services, config)
      const result = await strategy.run(experts, bus, memory)

      expect(result.rounds_used).toBe(3)
      expect(services.runExpert).toHaveBeenCalledTimes(6) // 2 experts x 3 rounds
    })

    it("terminates early when consensus >= threshold", async () => {
      const experts = [makeExpert({ role: "a" }), makeExpert({ role: "b" })]
      const hostMock = vi.fn()
        .mockResolvedValueOnce(makeHostOutputWithConsensus(0.85, false))  // round 1 check: high consensus
        .mockResolvedValueOnce(makeHostOutput({ synthesis: "final synthesis" }))  // final synthesis

      const services = createMockServices(undefined, hostMock)
      const config = makeConfig({ mode: "debate", rounds: 5, consensusThreshold: 0.7 })

      const strategy = new DiscussionStrategy(services, config)
      const result = await strategy.run(experts, bus, memory)

      expect(result.rounds_used).toBe(1)
      expect(result.consensus_score).toBe(0.85)
      expect(services.runExpert).toHaveBeenCalledTimes(2) // 2 experts x 1 round
    })

    it("continues when should_continue is false but consensus < threshold", async () => {
      const experts = [makeExpert({ role: "a" }), makeExpert({ role: "b" })]
      const hostMock = vi.fn()
        .mockResolvedValueOnce(makeHostOutputWithConsensus(0.4, false))  // round 1: host says stop, but below threshold
        .mockResolvedValueOnce(makeHostOutputWithConsensus(0.5, false))  // round 2: still below threshold
        .mockResolvedValueOnce(makeHostOutput({ synthesis: "final synthesis" }))  // final synthesis

      const services = createMockServices(undefined, hostMock)
      const config = makeConfig({ mode: "debate", rounds: 3, consensusThreshold: 0.7 })

      const strategy = new DiscussionStrategy(services, config)
      const result = await strategy.run(experts, bus, memory)

      // shouldContinue=false is ignored when consensus < threshold — debate continues
      expect(result.rounds_used).toBe(3)
      expect(result.consensus_score).toBe(0.5)
      expect(services.runExpert).toHaveBeenCalledTimes(6) // 2 experts x 3 rounds
    })

    it("max rounds forced termination", async () => {
      const experts = [makeExpert({ role: "a" }), makeExpert({ role: "b" })]
      // Consensus never reaches threshold
      const hostMock = vi.fn()
        .mockResolvedValueOnce(makeHostOutputWithConsensus(0.2, true))  // round 1
        .mockResolvedValueOnce(makeHostOutputWithConsensus(0.3, true))  // round 2
        .mockResolvedValueOnce(makeHostOutput({ synthesis: "max rounds synthesis" }))  // final synthesis

      const services = createMockServices(undefined, hostMock)
      const config = makeConfig({ mode: "debate", rounds: 3, consensusThreshold: 0.9 })

      const strategy = new DiscussionStrategy(services, config)
      const result = await strategy.run(experts, bus, memory)

      expect(result.rounds_used).toBe(3)
      expect(result.synthesis).toBe("max rounds synthesis")
    })
  })

  describe("budget exhaustion", () => {
    it("stops when budget is exhausted before a round", async () => {
      const experts = [makeExpert({ role: "a" })]
      const budgetMock = vi.fn()
        .mockReturnValueOnce({ status: "ok", consumed: 50, limit: 100, percentage: 50 })
        .mockReturnValue({ status: "exhausted", consumed: 100, limit: 100, percentage: 100 })

      const services = createMockServices()
      ;(services.checkBudget as any) = budgetMock

      const config = makeConfig({ mode: "debate", rounds: 5 })
      const strategy = new DiscussionStrategy(services, config)
      const result = await strategy.run(experts, bus, memory)

      expect(result.rounds_used).toBe(2)
      expect(result.budget_exhausted).toBe(true)
      expect(result.status).toBe("budget_exhausted")
    })
  })

  describe("SSE events", () => {
    it("emits expert_message and swarm_round_end events", async () => {
      const experts = [makeExpert({ role: "a" })]
      const services = createMockServices()
      const config = makeConfig({ mode: "review" })

      const strategy = new DiscussionStrategy(services, config)
      await strategy.run(experts, bus, memory)

      const emitCalls = (services.emit as any).mock.calls.map((c: any) => c[0].type)
      expect(emitCalls).toContain("expert_message")
      expect(emitCalls).toContain("swarm_round_end")
    })
  })

  describe("checkpoint", () => {
    it("saves checkpoint after each round in debate mode", async () => {
      const experts = [makeExpert({ role: "a" })]
      const hostMock = vi.fn()
        .mockResolvedValueOnce(makeHostOutputWithConsensus(0.3, true))
        .mockResolvedValueOnce(makeHostOutput({ synthesis: "done" }))

      const services = createMockServices(undefined, hostMock)
      const config = makeConfig({ mode: "debate", rounds: 2 })

      const strategy = new DiscussionStrategy(services, config)
      await strategy.run(experts, bus, memory)

      // saveCheckpoint called once per round (2 rounds)
      expect(services.saveCheckpoint).toHaveBeenCalledTimes(2)
    })
  })

  describe("hook triggers", () => {
    it("triggers lifecycle hooks in review mode", async () => {
      const experts = [makeExpert({ role: "a" }), makeExpert({ role: "b" })]
      const services = createMockServices()
      const config = makeConfig({ mode: "review" })
      const strategy = new DiscussionStrategy(services, config)
      await strategy.run(experts, bus, memory)

      const hookCalls = (services.triggerHook as ReturnType<typeof vi.fn>).mock.calls
      const hookEvents = hookCalls.map((c: any[]) => c[0])

      expect(hookEvents).toContain("on_swarm_start")
      expect(hookEvents).toContain("on_expert_spawn")
      expect(hookEvents).toContain("on_expert_complete")
      expect(hookEvents).toContain("on_swarm_complete")
      // review mode: no round_end or consensus hooks
      expect(hookEvents.filter((e: string) => e === "on_expert_spawn")).toHaveLength(2)
      expect(hookEvents.filter((e: string) => e === "on_expert_complete")).toHaveLength(2)
    })

    it("triggers round_end and consensus hooks in debate mode", async () => {
      const experts = [makeExpert({ role: "a" })]
      const hostMock = vi.fn()
        .mockResolvedValueOnce(makeHostOutputWithConsensus(0.3, true))
        .mockResolvedValueOnce(makeHostOutput({ synthesis: "final" }))

      const services = createMockServices(undefined, hostMock)
      const config = makeConfig({ mode: "debate", rounds: 2 })
      const strategy = new DiscussionStrategy(services, config)
      await strategy.run(experts, bus, memory)

      const hookCalls = (services.triggerHook as ReturnType<typeof vi.fn>).mock.calls
      const hookEvents = hookCalls.map((c: any[]) => c[0])

      expect(hookEvents).toContain("on_swarm_round_end")
      expect(hookEvents).toContain("on_swarm_consensus")
    })

    it("triggers expert_complete with failed status on expert error", async () => {
      const experts = [makeExpert({ role: "a" })]
      const services = createMockServices(
        vi.fn().mockRejectedValue(new Error("LLM timeout")),
      )
      const config = makeConfig({ mode: "review" })
      const strategy = new DiscussionStrategy(services, config)
      await strategy.run(experts, bus, memory)

      const hookCalls = (services.triggerHook as ReturnType<typeof vi.fn>).mock.calls
      const completeHooks = hookCalls.filter((c: any[]) => c[0] === "on_expert_complete")
      expect(completeHooks.length).toBeGreaterThan(0)
      expect(completeHooks[0][1].status).toBe("failed")
    })
  })
})
