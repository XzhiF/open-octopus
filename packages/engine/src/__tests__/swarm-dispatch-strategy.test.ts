import { describe, it, expect, vi, beforeEach } from "vitest"
import { DispatchStrategy } from "../executors/swarm/dispatch-strategy"
import type { SwarmServices, SwarmStrategyConfig, ExpertOutput } from "../executors/swarm/swarm-strategy"
import type { SwarmResult, ExpertResult, HostOutput, BudgetStatus } from "../executors/swarm/swarm-types"
import type { ExpertDef } from "@octopus/shared"
import { MessageBus } from "../executors/swarm/message-bus"
import { SharedMemory } from "../executors/swarm/shared-memory"
import { ContextTierResolver } from "../executors/swarm/context-tier-resolver"

// Mock buildDAG to control level structure
vi.mock("../executors/swarm/dag-builder", () => ({
  buildDAG: vi.fn(),
}))

import { buildDAG } from "../executors/swarm/dag-builder"

function makeExpert(overrides: Partial<ExpertDef> = {}): ExpertDef {
  return {
    role: "expert-a",
    prompt: "default prompt",
    ...overrides,
  }
}

function makeConfig(overrides: Partial<SwarmStrategyConfig> = {}): SwarmStrategyConfig {
  return {
    mode: "dispatch",
    topic: "test topic",
    rounds: 1,
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

function makeHostOutput(): HostOutput {
  return { synthesis: "dispatch synthesis" }
}

function createMockServices(
  expertHandler?: (expert: ExpertDef, prompt: string, round: number) => Promise<ExpertOutput>,
): SwarmServices {
  return {
    runExpert: expertHandler ?? vi.fn().mockImplementation(async (expert: ExpertDef) => makeExpertOutput(expert.role)),
    runHost: vi.fn().mockResolvedValue(makeHostOutput()),
    checkBudget: vi.fn().mockReturnValue({ status: "ok", consumed: 0, limit: null, percentage: 0 } as BudgetStatus),
    emit: vi.fn(),
    saveCheckpoint: vi.fn(),
    triggerHook: vi.fn(),
  }
}

describe("DispatchStrategy", () => {
  let bus: MessageBus
  let memory: SharedMemory

  beforeEach(() => {
    bus = new MessageBus()
    memory = new SharedMemory()
    vi.clearAllMocks()
  })

  describe("level-based execution", () => {
    it("executes experts level by level (L0 parallel -> L1 sequential)", async () => {
      // DAG: L0=[a, b], L1=[c] where c depends on a and b
      vi.mocked(buildDAG).mockReturnValue({ levels: [["a", "b"], ["c"]] })

      const experts = [
        makeExpert({ role: "a" }),
        makeExpert({ role: "b" }),
        makeExpert({ role: "c", depends_on: ["a", "b"] }),
      ]

      const callOrder: string[] = []
      const services = createMockServices(
        vi.fn().mockImplementation(async (expert: ExpertDef) => {
          callOrder.push(expert.role)
          return makeExpertOutput(expert.role)
        }),
      )

      const config = makeConfig()
      const strategy = new DispatchStrategy(services, config)
      const result = await strategy.run(experts, bus, memory)

      expect(result.expert_count).toBe(3)
      expect(result.experts).toHaveLength(3)
      // All 3 experts ran
      expect(services.runExpert).toHaveBeenCalledTimes(3)
      // L0 experts (a, b) should appear before L1 expert (c)
      const aIdx = callOrder.indexOf("a")
      const bIdx = callOrder.indexOf("b")
      const cIdx = callOrder.indexOf("c")
      expect(aIdx).toBeLessThan(cIdx)
      expect(bIdx).toBeLessThan(cIdx)
    })

    it("includes task_breakdown with DAG levels", async () => {
      vi.mocked(buildDAG).mockReturnValue({ levels: [["a"], ["b"]] })

      const experts = [
        makeExpert({ role: "a", task: "task a" }),
        makeExpert({ role: "b", task: "task b", depends_on: ["a"] }),
      ]

      const services = createMockServices()
      const config = makeConfig()
      const strategy = new DispatchStrategy(services, config)
      const result = await strategy.run(experts, bus, memory)

      expect(result.task_breakdown).toBeDefined()
      expect(result.task_breakdown!.dag?.levels).toEqual([["a"], ["b"]])
      expect(result.task_breakdown!.mode).toBe("dispatch")
    })

    it("passes upstream outputs to downstream experts", async () => {
      vi.mocked(buildDAG).mockReturnValue({ levels: [["a"], ["b"]] })

      const experts = [
        makeExpert({ role: "a" }),
        makeExpert({ role: "b", depends_on: ["a"] }),
      ]

      const services = createMockServices(
        vi.fn().mockImplementation(async (expert: ExpertDef) => ({
          output: `detailed output from ${expert.role}`,
          tokens: 100,
          files_changed: [],
          tools_used: [],
        })),
      )

      const config = makeConfig()
      const strategy = new DispatchStrategy(services, config)
      await strategy.run(experts, bus, memory)

      // Check that expert b received a prompt with upstream context
      const bCall = (services.runExpert as any).mock.calls.find((c: any) => c[0].role === "b")
      expect(bCall).toBeDefined()
      const bPrompt = bCall[1] as string
      expect(bPrompt).toContain("[a]:")
      expect(bPrompt).toContain("detailed output from a")
    })
  })

  describe("dependency skip", () => {
    it("skips downstream expert when upstream fails", async () => {
      vi.mocked(buildDAG).mockReturnValue({ levels: [["a"], ["b"]] })

      const experts = [
        makeExpert({ role: "a" }),
        makeExpert({ role: "b", depends_on: ["a"] }),
      ]

      const services = createMockServices(
        vi.fn().mockImplementation(async (expert: ExpertDef) => {
          if (expert.role === "a") throw new Error("expert a failed")
          return makeExpertOutput(expert.role)
        }),
      )

      const config = makeConfig({ failurePolicy: "continue_partial" })
      const strategy = new DispatchStrategy(services, config)
      const result = await strategy.run(experts, bus, memory)

      const aResult = result.experts.find(e => e.role === "a")
      const bResult = result.experts.find(e => e.role === "b")

      expect(aResult?.status).toBe("failed")
      expect(bResult?.status).toBe("skipped")
      expect(result.failed_experts).toContain("a")
      expect(result.skipped_experts).toContain("b")
    })

    it("skips when upstream is skipped (cascading skip)", async () => {
      vi.mocked(buildDAG).mockReturnValue({ levels: [["a"], ["b"], ["c"]] })

      const experts = [
        makeExpert({ role: "a" }),
        makeExpert({ role: "b", depends_on: ["a"] }),
        makeExpert({ role: "c", depends_on: ["b"] }),
      ]

      const services = createMockServices(
        vi.fn().mockImplementation(async (expert: ExpertDef) => {
          if (expert.role === "a") throw new Error("expert a failed")
          return makeExpertOutput(expert.role)
        }),
      )

      const config = makeConfig({ failurePolicy: "continue_partial" })
      const strategy = new DispatchStrategy(services, config)
      const result = await strategy.run(experts, bus, memory)

      const aResult = result.experts.find(e => e.role === "a")
      const bResult = result.experts.find(e => e.role === "b")
      const cResult = result.experts.find(e => e.role === "c")

      expect(aResult?.status).toBe("failed")
      expect(bResult?.status).toBe("skipped")
      expect(cResult?.status).toBe("skipped")
    })
  })

  describe("failure policy", () => {
    it("fail_fast returns failed status when an expert fails", async () => {
      vi.mocked(buildDAG).mockReturnValue({ levels: [["a", "b"]] })

      const experts = [
        makeExpert({ role: "a" }),
        makeExpert({ role: "b" }),
      ]

      const services = createMockServices(
        vi.fn().mockImplementation(async (expert: ExpertDef) => {
          if (expert.role === "a") throw new Error("expert a failed")
          return makeExpertOutput(expert.role)
        }),
      )

      const config = makeConfig({ failurePolicy: "fail_fast" })
      const strategy = new DispatchStrategy(services, config)
      const result = await strategy.run(experts, bus, memory)

      expect(result.failed_experts).toContain("a")
      expect(result.status).toBe("failed")
    })
  })

  describe("budget", () => {
    it("stops execution when budget is exhausted", async () => {
      vi.mocked(buildDAG).mockReturnValue({ levels: [["a"], ["b"]] })

      const experts = [
        makeExpert({ role: "a" }),
        makeExpert({ role: "b", depends_on: ["a"] }),
      ]

      const budgetMock = vi.fn()
        .mockReturnValueOnce({ status: "ok", consumed: 50, limit: 100, percentage: 50 })
        .mockReturnValue({ status: "exhausted", consumed: 100, limit: 100, percentage: 100 })

      const services = createMockServices()
      ;(services.checkBudget as any) = budgetMock

      const config = makeConfig()
      const strategy = new DispatchStrategy(services, config)
      const result = await strategy.run(experts, bus, memory)

      expect(result.budget_exhausted).toBe(true)
      expect(result.status).toBe("budget_exhausted")
      // Only level 0 expert ran
      expect(services.runExpert).toHaveBeenCalledTimes(1)
    })
  })

  describe("file conflict detection", () => {
    it("detects when multiple experts modify the same file", async () => {
      vi.mocked(buildDAG).mockReturnValue({ levels: [["a", "b"]] })

      const experts = [
        makeExpert({ role: "a" }),
        makeExpert({ role: "b" }),
      ]

      const services = createMockServices(
        vi.fn().mockImplementation(async (expert: ExpertDef) => ({
          output: `output from ${expert.role}`,
          tokens: 100,
          files_changed: ["src/shared.ts"],  // both modify same file
          tools_used: [],
        })),
      )

      const config = makeConfig()
      const strategy = new DispatchStrategy(services, config)
      const result = await strategy.run(experts, bus, memory)

      expect(result.file_conflicts).toHaveLength(1)
      expect(result.file_conflicts[0].file).toBe("src/shared.ts")
      expect(result.file_conflicts[0].experts).toEqual(expect.arrayContaining(["a", "b"]))
      expect(result.file_conflicts[0].resolution).toBe("manual")
    })

    it("no conflicts when experts modify different files", async () => {
      vi.mocked(buildDAG).mockReturnValue({ levels: [["a", "b"]] })

      const experts = [
        makeExpert({ role: "a" }),
        makeExpert({ role: "b" }),
      ]

      const services = createMockServices(
        vi.fn().mockImplementation(async (expert: ExpertDef) => ({
          output: `output from ${expert.role}`,
          tokens: 100,
          files_changed: [`src/${expert.role}.ts`],  // different files
          tools_used: [],
        })),
      )

      const config = makeConfig()
      const strategy = new DispatchStrategy(services, config)
      const result = await strategy.run(experts, bus, memory)

      expect(result.file_conflicts).toHaveLength(0)
    })
  })

  describe("hook triggers", () => {
    it("triggers swarm_start, expert_spawn, expert_complete, and swarm_complete hooks", async () => {
      vi.mocked(buildDAG).mockReturnValue({ levels: [["a"]] })

      const experts = [makeExpert({ role: "a" })]
      const services = createMockServices()
      const config = makeConfig()
      const strategy = new DispatchStrategy(services, config)
      await strategy.run(experts, bus, memory)

      const hookCalls = (services.triggerHook as ReturnType<typeof vi.fn>).mock.calls
      const hookEvents = hookCalls.map((c: any[]) => c[0])

      expect(hookEvents).toContain("on_swarm_start")
      expect(hookEvents).toContain("on_expert_spawn")
      expect(hookEvents).toContain("on_expert_complete")
      expect(hookEvents).toContain("on_swarm_complete")
    })
  })
})
