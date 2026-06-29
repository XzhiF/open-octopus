import { describe, it, expect } from "vitest"
import { VarPool } from "@octopus/shared"
import { KnowledgeInjector } from "../knowledge-injector"

describe("KnowledgeInjector", () => {
  it("returns empty prompts when no data in pool", () => {
    const pool = new VarPool({})
    const injector = new KnowledgeInjector(pool)
    const prompts = injector.getInjectedPrompts("test-workflow", "node-1")
    expect(prompts).toEqual([])
  })

  it("injects user preference when present", () => {
    const pool = new VarPool({})
    pool.set("__user_preference_text", "Always use TypeScript")
    const injector = new KnowledgeInjector(pool)
    const prompts = injector.getInjectedPrompts("test-workflow", "node-1")
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain("User Preferences")
    expect(prompts[0]).toContain("Always use TypeScript")
  })

  it("injects knowledge rules and writes __injected_rule_ids to pool", () => {
    const pool = new VarPool({})
    const ruleCache = {
      "rule-1": "Always validate inputs",
      "rule-2": "Use prepared statements",
    }
    pool.set("__knowledge_rule_cache", JSON.stringify(ruleCache))
    pool.set("__relevant_rule_ids", JSON.stringify(["rule-1", "rule-2"]))

    const injector = new KnowledgeInjector(pool)
    const prompts = injector.getInjectedPrompts("test-workflow", "node-1")

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain("Knowledge Rules")
    expect(prompts[0]).toContain("Always validate inputs")
    expect(prompts[0]).toContain("Use prepared statements")

    // Verify __injected_rule_ids was written to pool
    const injectedIds = JSON.parse(pool.get("__injected_rule_ids") as string)
    expect(injectedIds).toEqual(["rule-1", "rule-2"])
  })

  it("respects budget limit (max 10 rules)", () => {
    const pool = new VarPool({})
    const ruleCache: Record<string, string> = {}
    const ruleIds: string[] = []
    for (let i = 0; i < 15; i++) {
      ruleCache[`rule-${i}`] = `Rule ${i}`
      ruleIds.push(`rule-${i}`)
    }
    pool.set("__knowledge_rule_cache", JSON.stringify(ruleCache))
    pool.set("__relevant_rule_ids", JSON.stringify(ruleIds))

    const injector = new KnowledgeInjector(pool)
    const prompts = injector.getInjectedPrompts("test-workflow", "node-1")

    const injectedIds = JSON.parse(pool.get("__injected_rule_ids") as string)
    expect(injectedIds.length).toBeLessThanOrEqual(10)
  })

  it("filters by workflow scope when set", () => {
    const pool = new VarPool({})
    const ruleCache = {
      "rule-1": "Rule for build workflow",
    }
    pool.set("__knowledge_rule_cache", JSON.stringify(ruleCache))
    pool.set("__relevant_rule_ids", JSON.stringify(["rule-1"]))
    pool.set("__knowledge_scope_filter", JSON.stringify({ workflows: ["build"] }))

    const injector = new KnowledgeInjector(pool)

    // Should inject for matching workflow
    const prompts1 = injector.getInjectedPrompts("build", "node-1")
    expect(prompts1).toHaveLength(1)

    // Should not inject for non-matching workflow
    const prompts2 = injector.getInjectedPrompts("test", "node-1")
    expect(prompts2).toHaveLength(0)
  })
})
