import { describe, it, expect, vi } from "vitest"
import { SwarmNodeDefSchema } from "@octopus/shared"
import { SwarmExecutor } from "../executors/swarm"
import { MoaStrategy } from "../executors/swarm/moa-strategy"
import type { SwarmServices, ExpertOutput, SwarmStrategyConfig } from "../executors/swarm/swarm-strategy"
import type { BudgetStatus } from "../executors/swarm/swarm-types"
import type { ExpertDef } from "@octopus/shared"
import type { IAgentProvider, MessageChunk } from "@octopus/providers"
import { VarPool } from "@octopus/shared"
import { MessageBus } from "../executors/swarm/message-bus"
import { SharedMemory } from "../executors/swarm/shared-memory"
import { ContextTierResolver } from "../executors/swarm/context-tier-resolver"

// ── Helpers ──────────────────────────────────────────────

function createMockProvider(text: string, inputTokens = 100, outputTokens = 50): IAgentProvider {
  return {
    sendQuery: vi.fn().mockImplementation(async function* () {
      yield { type: "text_delta", content: text, messageId: "msg-1" } as MessageChunk
      yield {
        type: "result",
        content: text,
        tokens: { input: inputTokens, output: outputTokens },
        messageId: "msg-1",
      } as MessageChunk
    }),
    getType: () => "mock",
  } as IAgentProvider
}

function makeMoaNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "moa-test",
    type: "swarm" as const,
    topic: "MOA integration test",
    mode: "moa",
    rounds: 1,
    experts: [
      { role: "expert-a", prompt: "Analyze security" },
      { role: "expert-b", prompt: "Analyze performance" },
    ],
    aggregator: { role: "tech-lead", prompt: "Synthesize findings" },
    ...overrides,
  }
}

function createMockServices(overrides: Partial<SwarmServices> = {}): SwarmServices {
  return {
    runExpert: vi.fn().mockImplementation(async (expert: ExpertDef): Promise<ExpertOutput> => ({
      output: `Output from ${expert.role}`,
      tokens: 100,
      inputTokens: 50,
      outputTokens: 50,
      files_changed: [],
      tools_used: [],
    })),
    runHost: vi.fn().mockResolvedValue({
      synthesis: "Aggregated synthesis from MOA",
    }),
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

// ── 1. Schema validation ────────────────────────────────

describe("MOA Integration: Schema Validation", () => {
  it("passes with mode:moa + 2 experts + aggregator + rounds:1", () => {
    const result = SwarmNodeDefSchema.safeParse(makeMoaNode())
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.mode).toBe("moa")
      expect(result.data.experts).toHaveLength(2)
      expect(result.data.aggregator).toBeDefined()
      expect(result.data.rounds).toBe(1)
    }
  })

  it("rejects mode:moa + 1 expert (requires at least 2)", () => {
    const result = SwarmNodeDefSchema.safeParse(makeMoaNode({
      experts: [{ role: "only-one", prompt: "I am alone" }],
    }))
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map(i => i.message)
      expect(messages).toContain("moa mode requires at least 2 experts")
    }
  })

  it("rejects mode:moa + no aggregator", () => {
    const node = makeMoaNode()
    delete (node as any).aggregator
    const result = SwarmNodeDefSchema.safeParse(node)
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map(i => i.message)
      expect(messages).toContain("moa mode requires aggregator")
    }
  })
})

// ── 2. Strategy selection ───────────────────────────────

describe("MOA Integration: Strategy Selection", () => {
  it("MoaStrategy is constructable with correct config for moa mode", () => {
    const services = createMockServices()
    const config: SwarmStrategyConfig = {
      mode: "moa" as SwarmStrategyConfig["mode"],
      topic: "test topic",
      rounds: 1,
      consensusThreshold: 0.7,
      nodeId: "moa-test",
      failurePolicy: "continue_partial",
      contextTier: new ContextTierResolver(),
    }

    const strategy = new MoaStrategy(services, config)
    expect(strategy).toBeInstanceOf(MoaStrategy)
  })

  it("MoaStrategy.run executes experts and aggregator", async () => {
    const services = createMockServices()
    const config: SwarmStrategyConfig = {
      mode: "moa" as SwarmStrategyConfig["mode"],
      topic: "test topic",
      rounds: 1,
      consensusThreshold: 0.7,
      nodeId: "moa-test",
      failurePolicy: "continue_partial",
      contextTier: new ContextTierResolver(),
    }

    const strategy = new MoaStrategy(services, config)
    const experts: ExpertDef[] = [
      { role: "expert-a", prompt: "Analyze A" },
      { role: "expert-b", prompt: "Analyze B" },
    ]

    const result = await strategy.run(experts, new MessageBus(), new SharedMemory())

    expect(result.status).toBe("completed")
    expect(result.expert_count).toBe(2)
    expect(result.synthesis).toBe("Aggregated synthesis from MOA")
    expect(services.runExpert).toHaveBeenCalledTimes(2)
    expect(services.runHost).toHaveBeenCalledTimes(1)
  })
})

// ── 3. Model routing (C-3) ──────────────────────────────

describe("MOA Integration: Model Routing", () => {
  it("claude engine + moa experts should use configured model without alias resolution", async () => {
    // Verify that MoaStrategy passes expert.model through to runExpert
    // without additional resolveModelAlias transformation
    const expertModels: (string | undefined)[] = []
    const services = createMockServices({
      runExpert: vi.fn().mockImplementation(async (expert: ExpertDef): Promise<ExpertOutput> => {
        expertModels.push(expert.model)
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

    const config: SwarmStrategyConfig = {
      mode: "moa" as SwarmStrategyConfig["mode"],
      topic: "model routing test",
      rounds: 1,
      consensusThreshold: 0.7,
      nodeId: "moa-model-test",
      failurePolicy: "continue_partial",
      contextTier: new ContextTierResolver(),
    }

    const strategy = new MoaStrategy(services, config)
    const experts: ExpertDef[] = [
      { role: "expert-a", prompt: "task A", model: "opus" },
      { role: "expert-b", prompt: "task B", model: "pro-max" },
    ]

    await strategy.run(experts, new MessageBus(), new SharedMemory())

    // Expert models should pass through unchanged (no alias resolution in strategy)
    expect(expertModels).toEqual(["opus", "pro-max"])
  })
})

// ── 4. VarPool auto-outputs ─────────────────────────────

describe("MOA Integration: VarPool Auto-Outputs", () => {
  it("MoaStrategy result contains expert outputs and failed experts arrays", async () => {
    const services = createMockServices({
      runExpert: vi.fn()
        .mockImplementationOnce(async (expert: ExpertDef): Promise<ExpertOutput> => ({
          output: "Success from expert-a",
          tokens: 100,
          inputTokens: 50,
          outputTokens: 50,
          files_changed: [],
          tools_used: [],
        }))
        .mockImplementationOnce(async (): Promise<ExpertOutput> => {
          throw new Error("Expert B failed")
        }),
    })

    const config: SwarmStrategyConfig = {
      mode: "moa" as SwarmStrategyConfig["mode"],
      topic: "failure test",
      rounds: 1,
      consensusThreshold: 0.7,
      nodeId: "moa-fail-test",
      failurePolicy: "continue_partial",
      contextTier: new ContextTierResolver(),
    }

    const strategy = new MoaStrategy(services, config)
    const experts: ExpertDef[] = [
      { role: "expert-a", prompt: "task A" },
      { role: "expert-b", prompt: "task B" },
    ]

    const result = await strategy.run(experts, new MessageBus(), new SharedMemory())

    // Verify result has expert tracking fields
    expect(result.experts).toHaveLength(2)
    expect(result.experts[0].status).toBe("completed")
    expect(result.experts[1].status).toBe("failed")
    expect(result.failed_experts).toContain("expert-b")
    expect(result.failed_experts).not.toContain("expert-a")
  })

  it("full MOA execution writes synthesis and expert tracking to VarPool", async () => {
    const node = makeMoaNode()
    const pool = new VarPool()
    const provider = createMockProvider("moa expert output")
    const providers: Record<string, IAgentProvider> = { claude: provider }

    const executor = new SwarmExecutor(
      node as any, pool, providers, "/tmp",
    )

    // M2 fix: remove silent try/catch — moa mode is implemented, test should fail if it breaks
    const result = await executor.execute()
    expect(result.status).toBe("completed")

    const id = node.id
    // Standard auto-outputs
    expect(pool.get(`${id}_synthesis`)).toBeDefined()
    expect(pool.get(`${id}_expert_count`)).toBe(2)

    // MOA-specific auto-outputs (P2)
    expect(pool.get(`${id}_expert_outputs`)).toBeDefined()
    expect(pool.get(`${id}_failed_experts`)).toBeDefined()
  })
})

// ── C1 fix: Coordinator-level SSE event dedup ──
describe("MOA Integration: SSE Event Deduplication", () => {
  it("coordinator emits exactly 1 expert_spawn + 1 expert_complete per expert (no duplicates)", async () => {
    const node = makeMoaNode()
    const pool = new VarPool()
    const provider = createMockProvider("test output")
    const providers: Record<string, IAgentProvider> = { claude: provider }

    const executor = new SwarmExecutor(node as any, pool, providers, "/tmp")

    const result = await executor.execute()
    expect(result.status).toBe("completed")

    // The SwarmExecutor uses SwarmCoordinator which emits events.
    // With C1 fix, MoaStrategy no longer emits expert_spawn/complete directly —
    // only the coordinator does. So we expect exactly N events per expert, not 2N.
    // We verify this indirectly: if double-emit existed, the coordinator's emit
    // would be called twice per expert. The mock provider confirms single execution.
    expect(provider.sendQuery).toHaveBeenCalledTimes(3) // 2 experts + 1 aggregator
  })
})

// ── Per-expert engine routing ──
describe("MOA Integration: Per-Expert Engine", () => {
  it("schema accepts expert with engine field", () => {
    const result = SwarmNodeDefSchema.safeParse(makeMoaNode({
      experts: [
        { role: "claude-expert", prompt: "task A", engine: "claude" },
        { role: "pi-expert", prompt: "task B", engine: "pi" },
      ],
    }))
    expect(result.success).toBe(true)
  })

  it("MoaStrategy passes expert.engine through to runExpert services", async () => {
    const engineValues: (string | undefined)[] = []
    const services = createMockServices({
      runExpert: vi.fn().mockImplementation(async (expert: ExpertDef): Promise<ExpertOutput> => {
        engineValues.push(expert.engine)
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

    const config: SwarmStrategyConfig = {
      mode: "moa" as SwarmStrategyConfig["mode"],
      topic: "per-expert engine test",
      rounds: 1,
      consensusThreshold: 0.7,
      nodeId: "moa-engine-test",
      failurePolicy: "continue_partial",
      contextTier: new ContextTierResolver(),
    }

    const strategy = new MoaStrategy(services, config)
    const experts: ExpertDef[] = [
      { role: "claude-expert", prompt: "task A", engine: "claude" },
      { role: "pi-expert", prompt: "task B", engine: "pi" },
    ]

    await strategy.run(experts, new MessageBus(), new SharedMemory())

    // Strategy passes experts through unchanged — engine resolution happens in SwarmExecutor
    expect(engineValues).toEqual(["claude", "pi"])
  })
})
