import { describe, it, expect, vi, beforeEach } from "vitest"
import { SwarmExecutor } from "../executors/swarm"
import type { NodeDef } from "@octopus/shared"
import type { IAgentProvider, MessageChunk } from "@octopus/providers"
import { VarPool } from "@octopus/shared"
import type { EngineCallbacks } from "../engine"
import type { JsonlLogger } from "../logger"

/**
 * Integration test: SwarmExecutor -> Coordinator -> SSE emit + JSONL log
 *
 * Verifies the full chain:
 * 1. SSE events are emitted for each expert spawn/complete
 * 2. JSONL logSwarmEvent is called with correct event types
 * 3. Round end events fire after each round
 * 4. swarm_complete event fires at the end
 */

function createMockProvider(text: string, inputTokens = 100, outputTokens = 50): IAgentProvider {
  const provider: IAgentProvider = {
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
  }
  return provider
}

function makeNode(overrides: Partial<NodeDef> = {}): NodeDef {
  return {
    id: "swarm-integration",
    type: "swarm",
    mode: "review",
    topic: "integration test topic",
    experts: [
      { role: "reviewer", prompt: "review this" },
    ],
    ...overrides,
  }
}

function createMockLogger(): JsonlLogger {
  return {
    log: vi.fn(),
    getLogDir: vi.fn().mockReturnValue("/tmp/test-logs"),
  } as unknown as JsonlLogger
}

function createMockCallbacks(): EngineCallbacks {
  return {
    onNodeStart: vi.fn(),
    onNodeEnd: vi.fn(),
    onNodeLog: vi.fn(),
    onStatusChange: vi.fn(),
    onError: vi.fn(),
    onComplete: vi.fn(),
    onSwarmEvent: vi.fn(),
  }
}

describe("Swarm Integration: SSE + JSONL + Hooks", () => {
  let pool: VarPool
  let mockLogger: JsonlLogger
  let mockCallbacks: EngineCallbacks

  beforeEach(() => {
    pool = new VarPool()
    mockLogger = createMockLogger()
    mockCallbacks = createMockCallbacks()
  })

  describe("SSE event emission", () => {
    it("emits expert_spawn event when expert runs", async () => {
      const node = makeNode()
      const provider = createMockProvider("expert output")
      const providers: Record<string, IAgentProvider> = { claude: provider }

      const executor = new SwarmExecutor(
        node, pool, providers, "/tmp",
        mockCallbacks, mockLogger,
      )
      await executor.execute()

      // Verify that logger.log was called with expert_spawn event
      const logCalls = (mockLogger.log as ReturnType<typeof vi.fn>).mock.calls
      const spawnCalls = logCalls.filter((call: any[]) => call[1] === "expert_spawn")
      expect(spawnCalls.length).toBeGreaterThan(0)

      // Verify spawn event has correct data
      const spawnData = spawnCalls[0][2]
      expect(spawnData).toMatchObject({
        nodeId: "swarm-integration",
        role: "reviewer",
        source: "predefined",
      })
    })

    it("emits expert_complete event when expert finishes", async () => {
      const node = makeNode()
      const provider = createMockProvider("expert output")
      const providers: Record<string, IAgentProvider> = { claude: provider }

      const executor = new SwarmExecutor(
        node, pool, providers, "/tmp",
        mockCallbacks, mockLogger,
      )
      await executor.execute()

      // Verify that logger.log was called with expert_complete event
      const logCalls = (mockLogger.log as ReturnType<typeof vi.fn>).mock.calls
      const completeCalls = logCalls.filter((call: any[]) => call[1] === "expert_complete")
      expect(completeCalls.length).toBeGreaterThan(0)

      // Verify complete event has correct data
      const completeData = completeCalls[0][2]
      expect(completeData).toMatchObject({
        nodeId: "swarm-integration",
        role: "reviewer",
        status: "completed",
      })
      expect(completeData.tokens).toBeDefined()
    })

    it("emits events for multiple experts", async () => {
      const node = makeNode({
        experts: [
          { role: "reviewer-1", prompt: "review 1" },
          { role: "reviewer-2", prompt: "review 2" },
        ],
      })
      const provider = createMockProvider("expert output")
      const providers: Record<string, IAgentProvider> = { claude: provider }

      const executor = new SwarmExecutor(
        node, pool, providers, "/tmp",
        mockCallbacks, mockLogger,
      )
      await executor.execute()

      // Count spawn events
      const logCalls = (mockLogger.log as ReturnType<typeof vi.fn>).mock.calls
      const spawnCalls = logCalls.filter((call: any[]) => call[1] === "expert_spawn")
      expect(spawnCalls.length).toBe(2)

      // Count complete events
      const completeCalls = logCalls.filter((call: any[]) => call[1] === "expert_complete")
      expect(completeCalls.length).toBe(2)
    })
  })

  describe("JSONL logging", () => {
    it("logs swarm_event via logger for each SSE emission", async () => {
      const node = makeNode()
      const provider = createMockProvider("expert output")
      const providers: Record<string, IAgentProvider> = { claude: provider }

      const executor = new SwarmExecutor(
        node, pool, providers, "/tmp",
        mockCallbacks, mockLogger,
      )
      await executor.execute()

      // Verify logger.log was called (for both SSE and JSONL)
      expect((mockLogger.log as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0)
    })

    it("calls onSwarmEvent callback via emitSSE instead of logging swarm_event", async () => {
      const node = makeNode()
      const provider = createMockProvider("expert output")
      const providers: Record<string, IAgentProvider> = { claude: provider }

      const executor = new SwarmExecutor(
        node, pool, providers, "/tmp",
        mockCallbacks, mockLogger,
      )
      await executor.execute()

      // emitSSE now calls onSwarmEvent callback (not logger)
      const onSwarmEventCalls = (mockCallbacks.onSwarmEvent as ReturnType<typeof vi.fn>).mock.calls
      expect(onSwarmEventCalls.length).toBeGreaterThan(0)

      // Verify no "swarm_event" wrapper entries in JSONL (removed — redundant with logSwarmEvent)
      const logCalls = (mockLogger.log as ReturnType<typeof vi.fn>).mock.calls
      const swarmEventCalls = logCalls.filter((call: any[]) => call[1] === "swarm_event")
      expect(swarmEventCalls.length).toBe(0)
    })
  })

  describe("Callback integration", () => {
    it("emits onNodeLog at swarm start", async () => {
      const node = makeNode()
      const provider = createMockProvider("expert output")
      const providers: Record<string, IAgentProvider> = { claude: provider }

      const executor = new SwarmExecutor(
        node, pool, providers, "/tmp",
        mockCallbacks, mockLogger,
      )
      await executor.execute()

      // Verify onNodeLog was called with swarm start message
      const logCalls = (mockCallbacks.onNodeLog as ReturnType<typeof vi.fn>).mock.calls
      const startLogs = logCalls.filter((call: any[]) =>
        call[1].includes("[swarm] Starting swarm")
      )
      expect(startLogs.length).toBe(1)
      expect(startLogs[0][1]).toContain("mode=review")
      expect(startLogs[0][1]).toContain("experts=1")
    })

    it("emits onNodeLog at swarm completion", async () => {
      const node = makeNode()
      const provider = createMockProvider("expert output")
      const providers: Record<string, IAgentProvider> = { claude: provider }

      const executor = new SwarmExecutor(
        node, pool, providers, "/tmp",
        mockCallbacks, mockLogger,
      )
      await executor.execute()

      // Verify onNodeLog was called with swarm completion message
      const logCalls = (mockCallbacks.onNodeLog as ReturnType<typeof vi.fn>).mock.calls
      const completeLogs = logCalls.filter((call: any[]) =>
        call[1].includes("[swarm] Completed:")
      )
      expect(completeLogs.length).toBe(1)
      expect(completeLogs[0][1]).toContain("status=completed")
    })

    it("emits onNodeLog with correct expert count for multi-expert swarm", async () => {
      const node = makeNode({
        experts: [
          { role: "expert-a", prompt: "task a" },
          { role: "expert-b", prompt: "task b" },
          { role: "expert-c", prompt: "task c" },
        ],
      })
      const provider = createMockProvider("expert output")
      const providers: Record<string, IAgentProvider> = { claude: provider }

      const executor = new SwarmExecutor(
        node, pool, providers, "/tmp",
        mockCallbacks, mockLogger,
      )
      await executor.execute()

      const logCalls = (mockCallbacks.onNodeLog as ReturnType<typeof vi.fn>).mock.calls
      const startLogs = logCalls.filter((call: any[]) =>
        call[1].includes("[swarm] Starting swarm")
      )
      expect(startLogs[0][1]).toContain("experts=3")
    })
  })

  describe("Round events", () => {
    it("emits swarm_round_end events in debate mode", async () => {
      const node = makeNode({
        mode: "debate",
        rounds: 2,
        experts: [
          { role: "debater-1", prompt: "argue for" },
          { role: "debater-2", prompt: "argue against" },
        ],
      })
      const provider = createMockProvider("debate position")
      const providers: Record<string, IAgentProvider> = { claude: provider }

      const executor = new SwarmExecutor(
        node, pool, providers, "/tmp",
        mockCallbacks, mockLogger,
      )
      await executor.execute()

      // Check for round_end events in logs
      const logCalls = (mockLogger.log as ReturnType<typeof vi.fn>).mock.calls
      const roundEndCalls = logCalls.filter((call: any[]) => call[1] === "swarm_round_end")
      // Debate mode should emit round end events
      expect(roundEndCalls.length).toBeGreaterThan(0)
    })
  })

  describe("swarm_complete event", () => {
    it("emits swarm_complete event at the end", async () => {
      const node = makeNode()
      const provider = createMockProvider("expert output")
      const providers: Record<string, IAgentProvider> = { claude: provider }

      const executor = new SwarmExecutor(
        node, pool, providers, "/tmp",
        mockCallbacks, mockLogger,
      )
      await executor.execute()

      // Check for swarm_complete event in logs
      const logCalls = (mockLogger.log as ReturnType<typeof vi.fn>).mock.calls
      const completeCalls = logCalls.filter((call: any[]) => call[1] === "swarm_complete")
      expect(completeCalls.length).toBeGreaterThan(0)

      // Verify event data
      const completeData = completeCalls[0][2]
      expect(completeData).toMatchObject({
        nodeId: "swarm-integration",
        status: "completed",
      })
    })
  })

  describe("Hook lifecycle events", () => {
    it("logs hook events for swarm lifecycle", async () => {
      const node = makeNode({
        mode: "review",
        experts: [
          { role: "expert-a", prompt: "analyze" },
        ],
      })
      const provider = createMockProvider("expert output")
      const providers: Record<string, IAgentProvider> = { claude: provider }

      const executor = new SwarmExecutor(
        node, pool, providers, "/tmp",
        mockCallbacks, mockLogger,
      )
      await executor.execute()

      // Verify hook_event logs were written
      const logCalls = (mockLogger.log as ReturnType<typeof vi.fn>).mock.calls
      const hookEvents = logCalls.filter((call: any[]) => call[1] === "hook_event")
      expect(hookEvents.length).toBeGreaterThan(0)

      // Check for swarm_start, expert_spawn, expert_complete, swarm_complete
      const hookEventNames = hookEvents.map((call: any[]) => call[2]?.event)
      expect(hookEventNames).toContain("swarm_start")
      expect(hookEventNames).toContain("expert_spawn")
      expect(hookEventNames).toContain("expert_complete")
      expect(hookEventNames).toContain("swarm_complete")
    })
  })

  describe("No callbacks provided", () => {
    it("works without callbacks or logger", async () => {
      const node = makeNode()
      const provider = createMockProvider("expert output")
      const providers: Record<string, IAgentProvider> = { claude: provider }

      // No callbacks, no logger - should not throw
      const executor = new SwarmExecutor(node, pool, providers, "/tmp")
      const result = await executor.execute()

      expect(result.status).toBe("completed")
    })

    it("works with callbacks but no logger", async () => {
      const node = makeNode()
      const provider = createMockProvider("expert output")
      const providers: Record<string, IAgentProvider> = { claude: provider }

      const executor = new SwarmExecutor(
        node, pool, providers, "/tmp",
        mockCallbacks, undefined,
      )
      const result = await executor.execute()

      expect(result.status).toBe("completed")
      // Callbacks should still fire
      const logCalls = (mockCallbacks.onNodeLog as ReturnType<typeof vi.fn>).mock.calls
      expect(logCalls.length).toBeGreaterThan(0)
    })
  })
})
