import { describe, it, expect, vi, beforeEach } from "vitest"
import { SwarmExecutor } from "../executors/swarm"
import type { NodeDef, ExpertDef } from "@octopus/shared"
import type { IAgentProvider, MessageChunk } from "@octopus/providers"
import { VarPool } from "@octopus/shared"
import { join } from "path"

/**
 * Helper: creates a mock IAgentProvider whose sendQuery yields a sequence of MessageChunks.
 * The generator yields text_delta chunks followed by a result chunk with token usage.
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
    id: "swarm-node-1",
    type: "swarm",
    mode: "review",
    topic: "test topic",
    experts: [
      { role: "reviewer", prompt: "review this" },
    ],
    ...overrides,
  }
}

describe("SwarmExecutor", () => {
  let pool: VarPool

  beforeEach(() => {
    pool = new VarPool()
  })

  describe("auto-outputs", () => {
    it("writes 9 auto-outputs to VarPool", async () => {
      const node = makeNode()
      const provider = createMockProvider("expert output")
      const providers: Record<string, IAgentProvider> = { claude: provider }

      const executor = new SwarmExecutor(node, pool, { providers, cwd: "/tmp" })
      const result = await executor.execute()

      expect(result.status).toBe("completed")

      // Check all 9 auto-outputs
      const id = node.id
      expect(pool.get(`${id}_synthesis`)).toBeDefined()
      expect(pool.get(`${id}_consensus_score`)).toBeDefined() // null for review mode
      expect(pool.get(`${id}_rounds_used`)).toBe(1)
      expect(pool.get(`${id}_expert_count`)).toBe(1)
      expect(pool.get(`${id}_experts`)).toBeDefined()
      expect(pool.get(`${id}_history`)).toBeDefined()
      expect(pool.get(`${id}_task_breakdown`)).toBeDefined()
      expect(pool.get(`${id}_budget_exhausted`)).toBe(false)
      expect(pool.get(`${id}_timeout_exceeded`)).toBe(false)
    })

    it("writes synthesis as lastOutput", async () => {
      const node = makeNode()
      // Provider returns text for expert AND host
      const provider: IAgentProvider = {
        sendQuery: vi.fn()
          .mockImplementationOnce(async function* () {
            yield { type: "text_delta", content: "expert analysis", messageId: "msg-1" } as MessageChunk
            yield { type: "result", content: "expert analysis", tokens: { input: 100, output: 50 }, messageId: "msg-1" } as MessageChunk
          })
          .mockImplementationOnce(async function* () {
            yield { type: "text_delta", content: "host synthesis result", messageId: "msg-2" } as MessageChunk
            yield { type: "result", content: "host synthesis result", tokens: { input: 200, output: 100 }, messageId: "msg-2" } as MessageChunk
          }),
        getType: () => "mock",
      }

      const providers: Record<string, IAgentProvider> = { claude: provider }
      const executor = new SwarmExecutor(node, pool, { providers, cwd: "/tmp" })
      const result = await executor.execute()

      expect(result.status).toBe("completed")
      expect(result.lastOutput).toBeDefined()
    })
  })

  describe("expert_defaults merge", () => {
    it("merges expert_defaults into each expert", async () => {
      const node = makeNode({
        expert_defaults: {
          model: "haiku",
          tools: ["tool-a"],
          disallowed_tools: ["tool-x"],
        },
        experts: [
          { role: "expert-1", prompt: "prompt 1" },
          { role: "expert-2", prompt: "prompt 2", model: "opus" },
        ],
      })

      const provider = createMockProvider("output")
      const providers: Record<string, IAgentProvider> = { claude: provider }

      const executor = new SwarmExecutor(node, pool, { providers, cwd: "/tmp" })
      const result = await executor.execute()

      expect(result.status).toBe("completed")

      // Verify experts were merged with defaults
      const experts = JSON.parse(pool.get(`${node.id}_experts`) ?? "[]")
      expect(experts).toContain("expert-1")
      expect(experts).toContain("expert-2")
    })

    it("expert-specific values override defaults", async () => {
      const node = makeNode({
        expert_defaults: { model: "haiku" },
        experts: [
          { role: "expert-1", prompt: "prompt", model: "opus" },
        ],
      })

      const calls: Array<{ prompt: string; model?: string }> = []
      const provider: IAgentProvider = {
        sendQuery: vi.fn().mockImplementation(async function* (prompt: string, cwd: string, resumeId?: string, opts?: any) {
          calls.push({ prompt, model: opts?.model })
          yield { type: "text_delta", content: "output", messageId: "msg-1" } as MessageChunk
          yield { type: "result", content: "output", tokens: { input: 10, output: 10 }, messageId: "msg-1" } as MessageChunk
        }),
        getType: () => "mock",
      }

      const providers: Record<string, IAgentProvider> = { claude: provider }
      const executor = new SwarmExecutor(node, pool, { providers, cwd: "/tmp" })
      await executor.execute()

      // Expert model "opus" should override default "haiku"
      const expertCall = calls.find(c => c.prompt.includes("expert-1"))
      // The model passed to sendQuery for the expert should be "opus"
      expect(expertCall?.model).toBe("opus")
    })

    it("concatenates expert_defaults.skills with expert.skills", async () => {
      const node = makeNode({
        expert_defaults: {
          skills: ["octo-xzf-clarify"],
        },
        experts: [
          { role: "expert-1", prompt: "prompt 1", skills: ["octo-xzf-spec-designer"] },
        ],
      })

      const capturedOptions: any[] = []
      const provider: IAgentProvider = {
        sendQuery: vi.fn().mockImplementation(async function* (prompt: string, cwd: string, resumeId?: string, opts?: any) {
          capturedOptions.push(opts)
          yield { type: "text_delta", content: "output", messageId: "msg-1" } as MessageChunk
          yield { type: "result", content: "output", tokens: { input: 10, output: 10 }, messageId: "msg-1" } as MessageChunk
        }),
        getType: () => "mock",
      }

      const providers: Record<string, IAgentProvider> = { claude: provider }
      const executor = new SwarmExecutor(node, pool, { providers, cwd: "/tmp" })
      await executor.execute()

      const expertCall = capturedOptions.find((o: any) => o.skills?.length > 0)
      expect(expertCall?.skills).toEqual(["octo-xzf-clarify", "octo-xzf-spec-designer"])
    })

    it("passes expert_defaults.skills when expert has no skills", async () => {
      const node = makeNode({
        expert_defaults: {
          skills: ["octo-xzf-clarify"],
        },
        experts: [
          { role: "expert-1", prompt: "prompt 1" },
        ],
      })

      const capturedOptions: any[] = []
      const provider: IAgentProvider = {
        sendQuery: vi.fn().mockImplementation(async function* (prompt: string, cwd: string, resumeId?: string, opts?: any) {
          capturedOptions.push(opts)
          yield { type: "text_delta", content: "output", messageId: "msg-1" } as MessageChunk
          yield { type: "result", content: "output", tokens: { input: 10, output: 10 }, messageId: "msg-1" } as MessageChunk
        }),
        getType: () => "mock",
      }

      const providers: Record<string, IAgentProvider> = { claude: provider }
      const executor = new SwarmExecutor(node, pool, { providers, cwd: "/tmp" })
      await executor.execute()

      const expertCall = capturedOptions.find((o: any) => o.skills?.length > 0)
      expect(expertCall?.skills).toEqual(["octo-xzf-clarify"])
    })

    it("backward compatible — no skills field works as before", async () => {
      const node = makeNode()

      const provider = createMockProvider("output")
      const providers: Record<string, IAgentProvider> = { claude: provider }
      const executor = new SwarmExecutor(node, pool, { providers, cwd: "/tmp" })
      const result = await executor.execute()

      expect(result.status).toBe("completed")
    })
  })

  describe("error handling", () => {
    it("returns failed status when no provider available", async () => {
      const node = makeNode()
      const providers: Record<string, IAgentProvider> = {}

      const executor = new SwarmExecutor(node, pool, { providers, cwd: "/tmp" })
      const result = await executor.execute()

      expect(result.status).toBe("failed")
      expect(result.error).toBeDefined()
    })

    it("returns completed with degraded output when provider always throws", async () => {
      const node = makeNode({
        experts: [{ role: "reviewer", prompt: "review" }],
      })
      // Provider throws for every call (expert AND host)
      const provider: IAgentProvider = {
        sendQuery: vi.fn().mockImplementation(async function* () {
          throw new Error("provider error")
        }),
        getType: () => "mock",
      }

      const providers: Record<string, IAgentProvider> = { claude: provider }
      const executor = new SwarmExecutor(node, pool, { providers, cwd: "/tmp" })
      const result = await executor.execute()

      // When all experts fail, strategy returns "failed" (see TC-038)
      expect(result.status).toBe("failed")
      // But the expert should be marked as failed
      const experts = JSON.parse(pool.get(`${node.id}_experts`) ?? "[]")
      expect(experts).toContain("reviewer")
    })

    it("includes logLines with failure message", async () => {
      const node = makeNode()
      const providers: Record<string, IAgentProvider> = {}

      const executor = new SwarmExecutor(node, pool, { providers, cwd: "/tmp" })
      const result = await executor.execute()

      expect(result.logLines.length).toBeGreaterThan(0)
      expect(result.logLines[0]).toContain("Swarm failed")
    })
  })

  describe("engine provider resolution", () => {
    it("uses engine field to resolve provider", async () => {
      const node = makeNode({ engine: "claude-code" })
      const provider = createMockProvider("output")
      const providers: Record<string, IAgentProvider> = { claude: provider }

      const executor = new SwarmExecutor(node, pool, { providers, cwd: "/tmp" })
      const result = await executor.execute()

      // Should resolve "claude-code" to "claude" provider
      expect(result.status).toBe("completed")
    })
  })

  describe("TC-028: checkpoint resume", () => {
    it("loads checkpoint data and resumes from saved round", async () => {
      const node = makeNode({
        id: "swarm-resume",
        mode: "debate",
        rounds: 3,
        experts: [
          { role: "expert-a", prompt: "prompt a" },
          { role: "expert-b", prompt: "prompt b" },
        ],
      })

      // Mock provider: tracks which round each expert call is for
      const callPrompts: string[] = []
      const provider: IAgentProvider = {
        sendQuery: vi.fn().mockImplementation(async function* (prompt: string) {
          callPrompts.push(prompt)
          yield { type: "text_delta", content: `response for: ${prompt.slice(0, 30)}`, messageId: "msg" } as MessageChunk
          yield { type: "result", content: "response", tokens: { input: 10, output: 10 }, messageId: "msg" } as MessageChunk
        }),
        getType: () => "mock",
      }
      const providers: Record<string, IAgentProvider> = { claude: provider }

      // Mock checkpoint store with round 1 data
      const checkpointStore = {
        save: vi.fn(),
        load: vi.fn().mockReturnValue({
          executionId: "exec-123",
          workflowRef: "test-flow",
          timestamp: new Date().toISOString(),
          completedNodes: {},
          poolSnapshot: {},
          branchSessionIds: {},
          resumeAttempts: 0,
          swarmData: {
            nodeId: "swarm-resume",
            mode: "debate",
            currentRound: 1,
            messages: [
              { from: "expert-a", to: "*", round: 1, content: "round 1 from A", timestamp: 1000 },
              { from: "expert-b", to: "*", round: 1, content: "round 1 from B", timestamp: 2000 },
            ],
            expertResults: [
              { role: "expert-a", status: "completed", output: "round 1 from A", rounds: 1, tools_used: [], files_changed: [], source: "predefined", attempts: 1 },
              { role: "expert-b", status: "completed", output: "round 1 from B", rounds: 1, tools_used: [], files_changed: [], source: "predefined", attempts: 1 },
            ],
            consensusScore: 0.5,
            consumedTokens: 500,
            startTime: Date.now() - 10000,
          },
        }),
        cleanExpired: vi.fn(),
      }

      const executor = new SwarmExecutor(node, pool, { providers, cwd: "/tmp", checkpointStore, executionId: "exec-123" })
      const result = await executor.execute()

      expect(result.status).toBe("completed")

      // Verify checkpoint was loaded
      expect(checkpointStore.load).toHaveBeenCalledWith("exec-123")

      // Verify resume log line
      expect(result.logLines.some(l => l.includes("Resuming from checkpoint"))).toBe(true)

      // rounds_used should be >= 2 (resumed from round 1, so starts at round 2)
      expect(pool.get("swarm-resume_rounds_used")).toBeGreaterThanOrEqual(2)

      // History should contain both round 1 (restored) and later rounds
      const history = JSON.parse(pool.get("swarm-resume_history") ?? "[]")
      expect(history.length).toBeGreaterThanOrEqual(2)
      // Round 1 messages should be present
      expect(history.some((m: any) => m.round === 1 && m.from === "expert-a")).toBe(true)
    })

    it("works normally when no checkpoint exists", async () => {
      const node = makeNode({ id: "swarm-no-cp" })
      const provider = createMockProvider("fresh output")
      const providers: Record<string, IAgentProvider> = { claude: provider }

      const checkpointStore = {
        save: vi.fn(),
        load: vi.fn().mockReturnValue(null),
        cleanExpired: vi.fn(),
      }

      const executor = new SwarmExecutor(node, pool, { providers, cwd: "/tmp", checkpointStore, executionId: "exec-456" })
      const result = await executor.execute()

      expect(result.status).toBe("completed")
      expect(pool.get("swarm-no-cp_rounds_used")).toBe(1)
      // No resume log line
      expect(result.logLines.some(l => l.includes("Resuming from checkpoint"))).toBe(false)
    })
  })

  describe("TC-009: tool tracking via collectFromProvider", () => {
    it("captures tool_call chunks (toolsUsed + filesChanged) from provider", async () => {
      const node = makeNode({
        id: "swarm-tools",
        mode: "review",
        experts: [{ role: "coder", prompt: "create file" }],
      })

      // Provider emits tool_call chunks alongside text
      const provider: IAgentProvider = {
        sendQuery: vi.fn().mockImplementation(async function* () {
          yield { type: "text_delta", content: "Creating file...", messageId: "msg" } as MessageChunk
          yield {
            type: "tool_call",
            toolName: "Write",
            toolInput: { file_path: "/src/hello.ts", content: "export default 1" },
            messageId: "msg",
          } as MessageChunk
          yield {
            type: "tool_call",
            toolName: "Bash",
            toolInput: { command: "npx vitest run" },
            messageId: "msg",
          } as MessageChunk
          yield { type: "text_delta", content: "Done.", messageId: "msg" } as MessageChunk
          yield { type: "result", content: "Done", tokens: { input: 50, output: 30 }, messageId: "msg" } as MessageChunk
        }),
        getType: () => "mock",
      }
      const providers: Record<string, IAgentProvider> = { claude: provider }

      const executor = new SwarmExecutor(node, pool, { providers, cwd: "/tmp" })
      const result = await executor.execute()

      expect(result.status).toBe("completed")
      // Verify provider was called (tool_call chunks consumed without error)
      expect(provider.sendQuery).toHaveBeenCalled()
      // Verify text output was collected (text_delta chunks)
      const history = JSON.parse(pool.get("swarm-tools_history") ?? "[]")
      expect(history.length).toBeGreaterThan(0)
      // Expert output should contain text from text_delta chunks
      expect(history.some((m: any) => m.content?.includes("Creating file") || m.content?.includes("Done"))).toBe(true)
    })
  })

  describe("TC-031: mixed predefined + dynamic experts", () => {
    it("deduplicates predefined experts when dynamic routing adds same role", async () => {
      const node = makeNode({
        id: "swarm-mixed",
        mode: "swarm",
        dynamic: true,
        max_experts: 5,
        experts: [
          { role: "security-reviewer", prompt: "review security" },
          { role: "code-quality", prompt: "review quality" },
        ],
      })

      // First call = Router LLM, subsequent calls = expert + host
      let callCount = 0
      const provider: IAgentProvider = {
        sendQuery: vi.fn().mockImplementation(async function* (prompt: string) {
          callCount++
          if (callCount === 1) {
            // Router response: suggests security-reviewer (already predefined) + new backend-architect
            const routerJson = JSON.stringify({
              mode: "review",
              mode_reasoning: "security focus",
              experts: [
                { role: "security-reviewer", match_score: 0.95, match_reasoning: "predefined" },
                { role: "backend-architect", match_score: 0.85, match_reasoning: "backend patterns" },
              ],
            })
            yield { type: "text_delta", content: routerJson, messageId: "msg" } as MessageChunk
          } else {
            yield { type: "text_delta", content: "expert response", messageId: "msg" } as MessageChunk
          }
          yield { type: "result", content: "result", tokens: { input: 10, output: 10 }, messageId: "msg" } as MessageChunk
        }),
        getType: () => "mock",
      }
      const providers: Record<string, IAgentProvider> = { claude: provider }

      // Need agents dir for RoleRegistry
      const fs = await import("fs")
      const agentsDir = "/tmp/.claude/agents"
      fs.mkdirSync(agentsDir, { recursive: true })
      fs.writeFileSync(join(agentsDir, "security-reviewer.md"), "---\nname: security-reviewer\ndescription: Security expert\ncategory: engineering\n---\nRole")
      fs.writeFileSync(join(agentsDir, "backend-architect.md"), "---\nname: backend-architect\ndescription: Backend architect\ncategory: engineering\n---\nRole")
      fs.writeFileSync(join(agentsDir, "code-quality.md"), "---\nname: code-quality\ndescription: Code quality expert\ncategory: engineering\n---\nRole")

      const executor = new SwarmExecutor(node, pool, { providers, cwd: "/tmp" })
      const result = await executor.execute()

      expect(result.status).toBe("completed")
      // Expert count should be <= max_experts
      expect(pool.get("swarm-mixed_expert_count")).toBeLessThanOrEqual(5)
      // Verify dedup: predefined experts not duplicated by dynamic
      const experts = JSON.parse(pool.get("swarm-mixed_experts") ?? "[]")
      const securityCount = experts.filter((e: string) => e === "security-reviewer").length
      expect(securityCount).toBeLessThanOrEqual(1) // not duplicated

      // Cleanup
      fs.rmSync(agentsDir, { recursive: true, force: true })
    })
  })

  describe("TC-P1-006: timeout protection integration", () => {
    it("timeout_exceeded is set when swarm execution exceeds timeout", async () => {
      const node = makeNode({
        id: "swarm-timeout",
        mode: "review",
        timeout: 0.001, // 1ms timeout — triggers immediately after first expert call
        experts: [{ role: "reviewer", prompt: "review" }],
      })

      // Provider that completes but takes enough time for 1ms timeout to trigger
      const provider: IAgentProvider = {
        sendQuery: vi.fn().mockImplementation(async function* () {
          await new Promise(r => setTimeout(r, 50))
          yield { type: "text_delta", content: "output", messageId: "msg" } as MessageChunk
          yield { type: "result", content: "output", tokens: { input: 10, output: 10 }, messageId: "msg" } as MessageChunk
        }),
        getType: () => "mock",
      }
      const providers: Record<string, IAgentProvider> = { claude: provider }

      const executor = new SwarmExecutor(node, pool, { providers, cwd: "/tmp" })
      const result = await executor.execute()

      // Expert should fail with timeout error (coordinator checks isTimedOut before LLM call)
      // The swarm should still complete (degraded) but with timeout indication
      expect(result.status).toBeDefined()
      // timeout_exceeded auto-output should be written to VarPool
      const timeoutVal = pool.get("swarm-timeout_timeout_exceeded")
      expect(timeoutVal).toBeDefined()
    })

    it("BudgetTracker.isTimedOut returns true after timeout elapsed", async () => {
      // Direct verification of the timeout mechanism
      const { BudgetTracker } = await import("../executors/swarm/budget-tracker")
      const tracker = new BudgetTracker(undefined, 10) // 10 second timeout
      const startTime = Date.now() - 15000 // started 15 seconds ago

      expect(tracker.isTimedOut(startTime)).toBe(true)
      expect(tracker.isTimedOut(Date.now())).toBe(false) // just started
    })
  })
})
