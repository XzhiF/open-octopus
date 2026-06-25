import { describe, it, expect } from "vitest"
import { ExpertDefSchema, SwarmNodeDefSchema, StructuredOutputSchema, OutputFormatSchema } from "../types/swarm"

describe("ExpertDefSchema", () => {
  it("validates expert with agent_file", () => {
    const result = ExpertDefSchema.safeParse({
      role: "security-reviewer",
      agent_file: ".claude/agents/security.md",
    })
    expect(result.success).toBe(true)
  })

  it("validates expert with prompt", () => {
    const result = ExpertDefSchema.safeParse({
      role: "perf-reviewer",
      prompt: "Review for performance issues",
    })
    expect(result.success).toBe(true)
  })

  it("validates expert with both agent_file and prompt", () => {
    const result = ExpertDefSchema.safeParse({
      role: "full-expert",
      agent_file: ".claude/agents/expert.md",
      prompt: "Focus on edge cases",
      perspective: "security",
      task: "Review auth module",
      depends_on: ["other-role"],
      tools: ["Read", "Grep"],
      disallowed_tools: ["Bash"],
      model: "opus",
    })
    expect(result.success).toBe(true)
  })

  it("rejects expert without agent_file or prompt", () => {
    const result = ExpertDefSchema.safeParse({
      role: "empty-expert",
    })
    expect(result.success).toBe(false)
  })

  it("rejects expert without role", () => {
    const result = ExpertDefSchema.safeParse({
      prompt: "do something",
    })
    expect(result.success).toBe(false)
  })
})

describe("OutputFormatSchema", () => {
  it("validates all output formats", () => {
    expect(OutputFormatSchema.safeParse("summary").success).toBe(true)
    expect(OutputFormatSchema.safeParse("full").success).toBe(true)
    expect(OutputFormatSchema.safeParse("structured").success).toBe(true)
  })

  it("rejects invalid format", () => {
    expect(OutputFormatSchema.safeParse("verbose").success).toBe(false)
  })
})

describe("StructuredOutputSchema", () => {
  it("validates structured output", () => {
    const result = StructuredOutputSchema.safeParse({
      synthesis: "Overall summary",
      experts: [{ role: "reviewer", opinion: "Looks good" }],
      disagreements: ["Minor style preference"],
      recommendation: "Approve with changes",
      confidence: 0.85,
    })
    expect(result.success).toBe(true)
  })

  it("rejects confidence out of range", () => {
    const result = StructuredOutputSchema.safeParse({
      synthesis: "Summary",
      experts: [],
      disagreements: [],
      recommendation: "Approve",
      confidence: 1.5,
    })
    expect(result.success).toBe(false)
  })
})

describe("SwarmNodeDefSchema", () => {
  it("validates minimal review swarm", () => {
    const result = SwarmNodeDefSchema.safeParse({
      type: "swarm",
      topic: "Review the auth module",
      mode: "review",
      experts: [
        { role: "security-reviewer", prompt: "Check for vulnerabilities" },
      ],
    })
    expect(result.success).toBe(true)
  })

  it("validates debate swarm with two experts", () => {
    const result = SwarmNodeDefSchema.safeParse({
      type: "swarm",
      topic: "Choose the best architecture",
      mode: "debate",
      experts: [
        { role: "advocate-a", prompt: "Advocate for microservices" },
        { role: "advocate-b", prompt: "Advocate for monolith" },
      ],
    })
    expect(result.success).toBe(true)
  })

  it("validates dispatch swarm with dynamic experts", () => {
    const result = SwarmNodeDefSchema.safeParse({
      type: "swarm",
      topic: "Fix all bugs in the issue tracker",
      mode: "dispatch",
      dynamic: true,
      max_experts: 5,
    })
    expect(result.success).toBe(true)
  })

  it("validates full swarm config with all fields", () => {
    const result = SwarmNodeDefSchema.safeParse({
      type: "swarm",
      topic: "Comprehensive code review",
      mode: "swarm",
      experts: [
        {
          role: "security",
          prompt: "Security review",
          depends_on: [],
          tools: ["Read", "Grep"],
          model: "opus",
        },
        {
          role: "performance",
          prompt: "Performance review",
          depends_on: ["security"],
        },
      ],
      rounds: 3,
      consensus_threshold: 0.8,
      budget: 100,
      timeout: 600,
      host: {
        role: "host-moderator",
        prompt: "Use the expert opinions to synthesize a final report",
        model: "opus",
      },
      failure_policy: "continue_partial",
      output_format: "structured",
      outputs: { summary: "$last_output" },
      expert_defaults: {
        model: "sonnet",
        tools: ["Read"],
        disallowed_tools: ["Bash"],
      },
    })
    expect(result.success).toBe(true)
  })

  // TC-016: review mode without experts fails
  it("TC-016: rejects review mode without experts", () => {
    const result = SwarmNodeDefSchema.safeParse({
      type: "swarm",
      topic: "Review code",
      mode: "review",
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map(i => i.message)
      expect(messages).toContain("review mode requires at least 1 expert")
    }
  })

  // TC-017: debate mode with < 2 experts fails
  it("TC-017: rejects debate mode with fewer than 2 experts", () => {
    const result = SwarmNodeDefSchema.safeParse({
      type: "swarm",
      topic: "Debate architecture",
      mode: "debate",
      experts: [
        { role: "only-one", prompt: "I am alone" },
      ],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map(i => i.message)
      expect(messages).toContain("debate mode requires at least 2 experts")
    }
  })

  it("TC-017b: rejects debate mode with no experts", () => {
    const result = SwarmNodeDefSchema.safeParse({
      type: "swarm",
      topic: "Debate architecture",
      mode: "debate",
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map(i => i.message)
      expect(messages).toContain("debate mode requires at least 2 experts")
    }
  })

  // TC-018: consensus_threshold out of range (0-1) fails
  it("TC-018: rejects consensus_threshold below 0", () => {
    const result = SwarmNodeDefSchema.safeParse({
      type: "swarm",
      topic: "Review",
      mode: "review",
      experts: [{ role: "r1", prompt: "review" }],
      consensus_threshold: -0.1,
    })
    expect(result.success).toBe(false)
  })

  it("TC-018: rejects consensus_threshold above 1", () => {
    const result = SwarmNodeDefSchema.safeParse({
      type: "swarm",
      topic: "Review",
      mode: "review",
      experts: [{ role: "r1", prompt: "review" }],
      consensus_threshold: 1.1,
    })
    expect(result.success).toBe(false)
  })

  it("TC-018: accepts consensus_threshold at boundaries", () => {
    const at0 = SwarmNodeDefSchema.safeParse({
      type: "swarm",
      topic: "Review",
      mode: "review",
      experts: [{ role: "r1", prompt: "review" }],
      consensus_threshold: 0,
    })
    expect(at0.success).toBe(true)

    const at1 = SwarmNodeDefSchema.safeParse({
      type: "swarm",
      topic: "Review",
      mode: "review",
      experts: [{ role: "r1", prompt: "review" }],
      consensus_threshold: 1,
    })
    expect(at1.success).toBe(true)
  })

  // TC-019: depends_on referencing non-existent role fails
  it("TC-019: rejects depends_on referencing non-existent role", () => {
    const result = SwarmNodeDefSchema.safeParse({
      type: "swarm",
      topic: "Review",
      mode: "review",
      experts: [
        { role: "reviewer-a", prompt: "review", depends_on: ["nonexistent"] },
      ],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map(i => i.message)
      expect(messages.some(m => m.includes('depends_on references non-existent role "nonexistent"'))).toBe(true)
    }
  })

  it("TC-019: accepts depends_on referencing existing role", () => {
    const result = SwarmNodeDefSchema.safeParse({
      type: "swarm",
      topic: "Review",
      mode: "review",
      experts: [
        { role: "reviewer-a", prompt: "first pass" },
        { role: "reviewer-b", prompt: "second pass", depends_on: ["reviewer-a"] },
      ],
    })
    expect(result.success).toBe(true)
  })

  // dynamic without max_experts fails
  it("rejects dynamic mode without max_experts", () => {
    const result = SwarmNodeDefSchema.safeParse({
      type: "swarm",
      topic: "Dispatch tasks",
      mode: "dispatch",
      dynamic: true,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map(i => i.message)
      expect(messages).toContain("dynamic mode requires max_experts")
    }
  })

  // expert_defaults merge logic — schema validates expert_defaults correctly
  it("validates expert_defaults for later merge", () => {
    const result = SwarmNodeDefSchema.safeParse({
      type: "swarm",
      topic: "Review with defaults",
      mode: "review",
      experts: [
        { role: "reviewer", prompt: "review code" },
      ],
      expert_defaults: {
        model: "sonnet",
        tools: ["Read", "Grep"],
        disallowed_tools: ["Bash"],
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.expert_defaults?.model).toBe("sonnet")
      expect(result.data.expert_defaults?.tools).toEqual(["Read", "Grep"])
      expect(result.data.expert_defaults?.disallowed_tools).toEqual(["Bash"])
    }
  })

  // review mode with dynamic does not require experts
  it("allows review mode with dynamic and no predefined experts", () => {
    const result = SwarmNodeDefSchema.safeParse({
      type: "swarm",
      topic: "Dynamic review",
      mode: "review",
      dynamic: true,
      max_experts: 3,
    })
    expect(result.success).toBe(true)
  })

  // invalid mode rejected
  it("rejects invalid mode", () => {
    const result = SwarmNodeDefSchema.safeParse({
      type: "swarm",
      topic: "Review",
      mode: "invalid_mode",
    })
    expect(result.success).toBe(false)
  })

  // invalid failure_policy rejected
  it("rejects invalid failure_policy", () => {
    const result = SwarmNodeDefSchema.safeParse({
      type: "swarm",
      topic: "Review",
      mode: "review",
      experts: [{ role: "r1", prompt: "review" }],
      failure_policy: "ignore_errors",
    })
    expect(result.success).toBe(false)
  })
})
