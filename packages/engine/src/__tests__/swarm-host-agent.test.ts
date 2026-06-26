import { describe, it, expect, vi, beforeEach } from "vitest"
import { HostAgent } from "../executors/swarm/host-agent"
import type { HostAgentConfig } from "../executors/swarm/host-agent"
import type { ExpertResult, Message } from "../executors/swarm/swarm-types"

function makeExpertResult(
  role: string,
  overrides: Partial<ExpertResult> = {},
): ExpertResult {
  return {
    role,
    status: "completed",
    output: `Output from ${role}`,
    rounds: 1,
    tools_used: [],
    files_changed: [],
    source: "predefined",
    attempts: 1,
    ...overrides,
  }
}

function makeConfig(overrides: Partial<HostAgentConfig> = {}): HostAgentConfig {
  return {
    topic: "test topic",
    ...overrides,
  }
}

describe("HostAgent", () => {
  describe("TC-037: LLM fails -> fallback model -> degrade to concatenation", () => {
    it("tries primary model, then fallback sonnet, then degrades", async () => {
      const callLog: string[] = []
      const llmCall = vi.fn().mockImplementation(async (_prompt: string, model?: string) => {
        callLog.push(model ?? "default")
        throw new Error("LLM unavailable")
      })

      const agent = new HostAgent(llmCall)
      const experts = [
        makeExpertResult("expert-a"),
        makeExpertResult("expert-b"),
      ]

      // opus primary → sonnet fallback → degradation
      const config = makeConfig({ host: { role: "host", prompt: "test", model: "opus" } })
      const result = await agent.synthesize(experts, [], config)

      // Should have tried: opus (1 attempt), sonnet (1 attempt)
      expect(callLog).toEqual(["opus", "sonnet"])
      // Should degrade to concatenation
      expect(result.degraded).toBe(true)
      expect(result.synthesis).toContain("expert-a")
      expect(result.synthesis).toContain("expert-b")
    })

    it("succeeds on fallback sonnet after primary opus fails", async () => {
      const llmCall = vi.fn().mockImplementation(async (_prompt: string, model?: string) => {
        if (model === "sonnet") {
          return JSON.stringify({ synthesis: "Sonnet synthesis result" })
        }
        throw new Error("Opus unavailable")
      })

      const agent = new HostAgent(llmCall)
      const experts = [makeExpertResult("expert-a")]

      const config = makeConfig({ host: { role: "host", prompt: "test", model: "opus" } })
      const result = await agent.synthesize(experts, [], config)

      expect(result.degraded).toBeUndefined()
      expect(result.synthesis).toBe("Sonnet synthesis result")
    })

    it("skips sonnet fallback when primary model is already sonnet", async () => {
      const callLog: string[] = []
      const llmCall = vi.fn().mockImplementation(async (_prompt: string, model?: string) => {
        callLog.push(model ?? "default")
        throw new Error("fail")
      })

      const agent = new HostAgent(llmCall)
      const experts = [makeExpertResult("expert-a")]

      const config = makeConfig({ host: { role: "host", prompt: "test", model: "sonnet" } })
      const result = await agent.synthesize(experts, [], config)

      // Only sonnet attempt (no double-fallback when primary IS sonnet)
      expect(callLog).toEqual(["sonnet"])
      expect(result.degraded).toBe(true)
    })
  })

  describe("TC-038: All experts failed -> empty synthesis, no LLM call", () => {
    it("returns empty synthesis when all experts failed", async () => {
      const llmCall = vi.fn().mockResolvedValue("should not be called")

      const agent = new HostAgent(llmCall)
      const experts = [
        makeExpertResult("expert-a", { status: "failed", output: "" }),
        makeExpertResult("expert-b", { status: "failed", output: "" }),
      ]

      const config = makeConfig()
      const result = await agent.synthesize(experts, [], config)

      expect(result.synthesis).toBe("")
      expect(result.degraded).toBe(true)
      expect(llmCall).not.toHaveBeenCalled()
    })

    it("returns empty synthesis when expert list is empty", async () => {
      const llmCall = vi.fn().mockResolvedValue("should not be called")

      const agent = new HostAgent(llmCall)
      const config = makeConfig()
      const result = await agent.synthesize([], [], config)

      expect(result.synthesis).toBe("")
      expect(result.degraded).toBe(true)
      expect(llmCall).not.toHaveBeenCalled()
    })

    it("returns empty when mix of failed and skipped experts", async () => {
      const llmCall = vi.fn().mockResolvedValue("should not be called")

      const agent = new HostAgent(llmCall)
      const experts = [
        makeExpertResult("expert-a", { status: "failed", output: "" }),
        makeExpertResult("expert-b", { status: "skipped", output: "" }),
        makeExpertResult("expert-c", { status: "budget_exceeded", output: "" }),
      ]

      const config = makeConfig()
      const result = await agent.synthesize(experts, [], config)

      expect(result.synthesis).toBe("")
      expect(result.degraded).toBe(true)
      expect(llmCall).not.toHaveBeenCalled()
    })
  })

  describe("Debate mode prompt includes consensus assessment structure", () => {
    it("includes assessment fields in debate mode", async () => {
      let capturedPrompt = ""
      const llmCall = vi.fn().mockImplementation(async (prompt: string) => {
        capturedPrompt = prompt
        return JSON.stringify({
          synthesis: "debate synthesis",
          assessment: {
            consensus_score: 0.8,
            key_agreements: ["agreement 1"],
            key_disagreements: [],
            should_continue: false,
            confidence: 0.9,
          },
        })
      })

      const agent = new HostAgent(llmCall)
      const experts = [
        makeExpertResult("expert-a"),
        makeExpertResult("expert-b"),
      ]

      const config = makeConfig({ mode: "debate" })
      const result = await agent.synthesize(experts, [], config)

      // Verify prompt contains consensus assessment instructions
      expect(capturedPrompt).toContain("consensus")
      expect(capturedPrompt).toContain("assessment")
      expect(capturedPrompt).toContain("should_continue")

      // Verify parsed response includes assessment
      expect(result.assessment).toBeDefined()
      expect(result.assessment!.consensus_score).toBe(0.8)
      expect(result.assessment!.should_continue).toBe(false)
    })
  })

  describe("Structured output format -> JSON response", () => {
    it("requests structured JSON when outputFormat is structured", async () => {
      let capturedPrompt = ""
      const llmCall = vi.fn().mockImplementation(async (prompt: string) => {
        capturedPrompt = prompt
        return JSON.stringify({
          synthesis: "structured synthesis",
          experts: [{ role: "expert-a", opinion: "opinion A" }],
          disagreements: [],
          recommendation: "recommendation",
          confidence: 0.85,
        })
      })

      const agent = new HostAgent(llmCall)
      const experts = [makeExpertResult("expert-a")]

      const config = makeConfig({ outputFormat: "structured" })
      const result = await agent.synthesize(experts, [], config)

      expect(capturedPrompt).toContain("JSON structure")
      // Structured output: synthesis is the full JSON string
      const parsed = JSON.parse(result.synthesis)
      expect(parsed.synthesis).toBe("structured synthesis")
      expect(parsed.experts).toBeDefined()
    })
  })

  describe("Degraded output is still consumable", () => {
    it("degraded synthesis has text content from expert outputs", async () => {
      const llmCall = vi.fn().mockRejectedValue(new Error("fail"))

      const agent = new HostAgent(llmCall)
      const experts = [
        makeExpertResult("expert-a", { output: "Expert A detailed analysis" }),
        makeExpertResult("expert-b", { output: "Expert B detailed analysis" }),
      ]

      const config = makeConfig({ host: { role: "host", prompt: "test", model: "sonnet" } })
      const result = await agent.synthesize(experts, [], config)

      expect(result.degraded).toBe(true)
      expect(result.synthesis).toContain("Expert A detailed analysis")
      expect(result.synthesis).toContain("Expert B detailed analysis")
      expect(result.synthesis).toContain("degraded")
      expect(result.synthesis.length).toBeGreaterThan(10)
    })

    it("degraded synthesis only includes completed experts", async () => {
      const llmCall = vi.fn().mockRejectedValue(new Error("fail"))

      const agent = new HostAgent(llmCall)
      const experts = [
        makeExpertResult("good-expert", { output: "Good analysis" }),
        makeExpertResult("failed-expert", { status: "failed", output: "" }),
      ]

      const config = makeConfig({ host: { role: "host", prompt: "test", model: "sonnet" } })
      const result = await agent.synthesize(experts, [], config)

      expect(result.synthesis).toContain("Good analysis")
      expect(result.synthesis).not.toContain("failed-expert")
    })
  })

  describe("Normal successful synthesis", () => {
    it("returns parsed synthesis from LLM response", async () => {
      const llmCall = vi.fn().mockResolvedValue(
        JSON.stringify({ synthesis: "Final synthesis result" }),
      )

      const agent = new HostAgent(llmCall)
      const experts = [makeExpertResult("expert-a")]

      const config = makeConfig()
      const result = await agent.synthesize(experts, [], config)

      expect(result.synthesis).toBe("Final synthesis result")
      expect(result.degraded).toBeUndefined()
    })

    it("handles non-JSON LLM response gracefully", async () => {
      const llmCall = vi.fn().mockResolvedValue("Plain text synthesis without JSON")

      const agent = new HostAgent(llmCall)
      const experts = [makeExpertResult("expert-a")]

      const config = makeConfig()
      const result = await agent.synthesize(experts, [], config)

      expect(result.synthesis).toBe("Plain text synthesis without JSON")
    })
  })

  describe("rawResponse propagation for vars_update extraction", () => {
    it("returns full LLM response as rawResponse when host outputs multiple JSON objects", async () => {
      // Simulate host outputting both assessment and vars_update as separate JSON objects
      const fullResponse = `## 扫描报告

分析完成，发现 20 个 BUG。

{"assessment": {"consensus_score": 0.82, "should_continue": true, "summary": "20 bugs found"}}

{"vars_update": {"candidate_count": "20", "conclusion": "Found 20 bugs"}}`

      const llmCall = vi.fn().mockResolvedValue(fullResponse)

      const agent = new HostAgent(llmCall)
      const experts = [makeExpertResult("expert-a")]

      const config = makeConfig({ outputFormat: "structured" })
      const result = await agent.synthesize(experts, [], config)

      // rawResponse should contain the full LLM response text
      expect(result.rawResponse).toBe(fullResponse)
      // rawResponse should contain vars_update
      expect(result.rawResponse).toContain("vars_update")
      expect(result.rawResponse).toContain("candidate_count")
    })

    it("rawResponse is available even when synthesis only captures first JSON", async () => {
      const fullResponse = `Report text here.
{"assessment": {"consensus_score": 0.9}}
More text.
{"vars_update": {"candidate_count": "5"}}`

      const llmCall = vi.fn().mockResolvedValue(fullResponse)

      const agent = new HostAgent(llmCall)
      const experts = [makeExpertResult("expert-a")]

      const config = makeConfig({ outputFormat: "structured" })
      const result = await agent.synthesize(experts, [], config)

      // synthesis might only capture the first JSON
      // but rawResponse should have the full text
      expect(result.rawResponse).toBe(fullResponse)
      expect(result.rawResponse).toContain('"vars_update"')
    })
  })
})
