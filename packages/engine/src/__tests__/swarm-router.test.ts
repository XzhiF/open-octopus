import { describe, it, expect, vi, beforeEach } from "vitest"
import { SwarmRouter } from "../executors/swarm/swarm-router"
import type { RoleRegistry, RoleDef } from "../executors/swarm/role-registry"

function makeRole(overrides: Partial<RoleDef> = {}): RoleDef {
  return {
    name: "test-role",
    description: "A test role",
    category: "engineering",
    source: "custom",
    ...overrides,
  }
}

function createMockRegistry(roles: RoleDef[] = []): RoleRegistry {
  return {
    loadIndex: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockReturnValue(roles),
    resolve: vi.fn().mockImplementation((name: string) => roles.find(r => r.name === name) ?? null),
    search: vi.fn().mockReturnValue([]),
    resolveMany: vi.fn().mockReturnValue([]),
    listByCategory: vi.fn().mockReturnValue({}),
  } as unknown as RoleRegistry
}

describe("SwarmRouter", () => {
  describe("TC-011: Security audit topic matches security-related experts", () => {
    it("selects security-related experts for a security audit topic", async () => {
      const roles = [
        makeRole({ name: "security-auditor", description: "Performs security audits and vulnerability assessments", category: "security" }),
        makeRole({ name: "penetration-tester", description: "Security penetration testing expert", category: "security" }),
        makeRole({ name: "frontend-dev", description: "React and CSS frontend developer", category: "engineering" }),
        makeRole({ name: "devops-engineer", description: "CI/CD pipeline and infrastructure", category: "devops" }),
      ]

      const registry = createMockRegistry(roles)
      const router = new SwarmRouter(registry)

      const llmCall = vi.fn().mockResolvedValue(JSON.stringify({
        mode: "review",
        mode_reasoning: "Security audit requires review mode",
        experts: [
          { role: "security-auditor", match_reasoning: "Core security expertise", match_score: 0.95 },
          { role: "penetration-tester", match_reasoning: "Hands-on security testing", match_score: 0.9 },
        ],
        alternatives_considered: ["devops-engineer"],
      }))

      const decision = await router.analyze("security audit vulnerability assessment", {
        llmCall,
      })

      expect(decision.mode).toBe("review")
      expect(decision.experts).toHaveLength(2)
      expect(decision.experts[0].role).toBe("security-auditor")
      expect(decision.experts[1].role).toBe("penetration-tester")
      expect(decision.experts[0].match_score).toBe(0.95)
    })
  })

  describe("TC-012: Tech selection topic selects debate mode", () => {
    it("selects debate mode for technology comparison topics", async () => {
      const roles = [
        makeRole({ name: "backend-architect", description: "System architecture and technology selection", category: "engineering" }),
        makeRole({ name: "database-expert", description: "Database design and optimization", category: "engineering" }),
        makeRole({ name: "cloud-architect", description: "Cloud infrastructure and services", category: "devops" }),
      ]

      const registry = createMockRegistry(roles)
      const router = new SwarmRouter(registry)

      const llmCall = vi.fn().mockResolvedValue(JSON.stringify({
        mode: "debate",
        mode_reasoning: "Technology selection involves trade-offs and comparisons",
        experts: [
          { role: "backend-architect", match_reasoning: "Architecture decisions", match_score: 0.9 },
          { role: "database-expert", match_reasoning: "Database trade-offs", match_score: 0.85 },
          { role: "cloud-architect", match_reasoning: "Cloud considerations", match_score: 0.8 },
        ],
        alternatives_considered: [],
      }))

      const decision = await router.analyze("PostgreSQL vs MongoDB for our new microservice", {
        llmCall,
      })

      expect(decision.mode).toBe("debate")
      expect(decision.mode_reasoning).toContain("trade-offs")
      expect(decision.experts.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe("TC-013: Full-stack dev topic selects dispatch mode", () => {
    it("selects dispatch mode for implementation tasks", async () => {
      const roles = [
        makeRole({ name: "fullstack-dev", description: "Full-stack web development", category: "engineering" }),
        makeRole({ name: "ui-designer", description: "UI/UX design and implementation", category: "design" }),
        makeRole({ name: "qa-engineer", description: "Quality assurance and testing", category: "testing" }),
      ]

      const registry = createMockRegistry(roles)
      const router = new SwarmRouter(registry)

      const llmCall = vi.fn().mockResolvedValue(JSON.stringify({
        mode: "dispatch",
        mode_reasoning: "Implementation task requires coordinated development work",
        experts: [
          { role: "fullstack-dev", match_reasoning: "Core implementation", match_score: 0.95 },
          { role: "ui-designer", match_reasoning: "UI implementation", match_score: 0.7 },
        ],
        alternatives_considered: ["qa-engineer"],
      }))

      const decision = await router.analyze("Build a user dashboard with React and Express API", {
        llmCall,
      })

      expect(decision.mode).toBe("dispatch")
      expect(decision.experts.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe("TC-014: max_experts truncation", () => {
    it("truncates experts list when exceeding maxExperts", async () => {
      const roles = [
        makeRole({ name: "expert-a", description: "Expert A", category: "engineering" }),
        makeRole({ name: "expert-b", description: "Expert B", category: "engineering" }),
        makeRole({ name: "expert-c", description: "Expert C", category: "engineering" }),
        makeRole({ name: "expert-d", description: "Expert D", category: "engineering" }),
        makeRole({ name: "expert-e", description: "Expert E", category: "engineering" }),
      ]

      const registry = createMockRegistry(roles)
      const router = new SwarmRouter(registry)

      const llmCall = vi.fn().mockResolvedValue(JSON.stringify({
        mode: "debate",
        mode_reasoning: "test",
        experts: [
          { role: "expert-a", match_reasoning: "a", match_score: 0.9 },
          { role: "expert-b", match_reasoning: "b", match_score: 0.8 },
          { role: "expert-c", match_reasoning: "c", match_score: 0.7 },
          { role: "expert-d", match_reasoning: "d", match_score: 0.6 },
          { role: "expert-e", match_reasoning: "e", match_score: 0.5 },
        ],
        alternatives_considered: [],
      }))

      const decision = await router.analyze("test topic", {
        maxExperts: 3,
        llmCall,
      })

      expect(decision.experts).toHaveLength(3)
      expect(decision.experts[0].role).toBe("expert-a")
      expect(decision.experts[2].role).toBe("expert-c")
      expect(decision.alternatives_considered.some(a => a.includes("Truncated"))).toBe(true)
    })
  })

  describe("TC-015: Router decision includes match_reasoning for each expert", () => {
    it("includes match_reasoning and match_score for every selected expert", async () => {
      const roles = [
        makeRole({ name: "architect", description: "System architect", category: "engineering" }),
        makeRole({ name: "reviewer", description: "Code reviewer", category: "engineering" }),
      ]

      const registry = createMockRegistry(roles)
      const router = new SwarmRouter(registry)

      const llmCall = vi.fn().mockResolvedValue(JSON.stringify({
        mode: "review",
        mode_reasoning: "Review mode for code assessment",
        experts: [
          { role: "architect", match_reasoning: "Architecture review capability", match_score: 0.88 },
          { role: "reviewer", match_reasoning: "Code review expertise", match_score: 0.92 },
        ],
        alternatives_considered: [],
      }))

      const decision = await router.analyze("review the architecture", { llmCall })

      for (const expert of decision.experts) {
        expect(expert.match_reasoning).toBeDefined()
        expect(expert.match_reasoning.length).toBeGreaterThan(0)
        expect(expert.match_score).toBeGreaterThan(0)
        expect(expert.match_score).toBeLessThanOrEqual(1)
      }
    })
  })

  describe("Empty role registry throws error", () => {
    it("throws error with install instructions when no roles available", async () => {
      const registry = createMockRegistry([]) // empty
      const router = new SwarmRouter(registry)

      await expect(
        router.analyze("any topic", { llmCall: vi.fn() }),
      ).rejects.toThrow("No roles available")

      await expect(
        router.analyze("any topic", { llmCall: vi.fn() }),
      ).rejects.toThrow("octopus setup")
    })
  })

  describe("LLM failure falls back to keyword-based selection", () => {
    it("falls back to keyword matching when LLM call throws", async () => {
      const roles = [
        makeRole({ name: "security-expert", description: "Security analysis and auditing", category: "security" }),
        makeRole({ name: "frontend-dev", description: "Frontend development with React", category: "engineering" }),
        makeRole({ name: "backend-dev", description: "Backend API development", category: "engineering" }),
      ]

      const registry = createMockRegistry(roles)
      const router = new SwarmRouter(registry)

      const llmCall = vi.fn().mockRejectedValue(new Error("LLM unavailable"))

      const decision = await router.analyze("security audit review", { llmCall })

      // Should fall back to debate mode with keyword-matched experts
      expect(decision.mode).toBe("debate")
      expect(decision.mode_reasoning).toContain("fallback")
      expect(decision.experts.length).toBeGreaterThan(0)
      // Each fallback expert should have match_reasoning
      for (const expert of decision.experts) {
        expect(expert.match_reasoning).toContain("Fallback")
        expect(expert.match_score).toBe(0.3)
      }
    })

    it("falls back when LLM returns non-JSON response", async () => {
      const roles = [
        makeRole({ name: "dev", description: "Developer", category: "engineering" }),
      ]

      const registry = createMockRegistry(roles)
      const router = new SwarmRouter(registry)

      const llmCall = vi.fn().mockResolvedValue("I cannot provide a JSON response")

      const decision = await router.analyze("development task", { llmCall })

      expect(decision.mode).toBe("debate")
      expect(decision.mode_reasoning).toContain("fallback")
    })
  })
})
