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

  it("injects global rules regardless of scope filter", () => {
    const pool = new VarPool({})
    const ruleCache = {
      "rule-1": "Always validate inputs",
      "rule-2": "Use prepared statements",
    }
    const ruleMeta = {
      "rule-1": { fileName: "general.md", scope: "global" },
      "rule-2": { fileName: "security.md", scope: "global" },
    }
    pool.set("__knowledge_rule_cache", JSON.stringify(ruleCache))
    pool.set("__knowledge_rule_meta", JSON.stringify(ruleMeta))
    pool.set("__relevant_rule_ids", JSON.stringify(["rule-1", "rule-2"]))
    pool.set("__knowledge_scope_filter", JSON.stringify({ repoNames: ["octopus"], workflowName: "build" }))

    const injector = new KnowledgeInjector(pool)
    const prompts = injector.getInjectedPrompts("build", "node-1")

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain("Knowledge Rules — Global")
    expect(prompts[0]).toContain("Always validate inputs")
    expect(prompts[0]).toContain("Use prepared statements")

    const injectedIds = JSON.parse(pool.get("__injected_rule_ids") as string)
    expect(injectedIds).toEqual(["rule-1", "rule-2"])
  })

  it("injects knowledge rules with no scope filter (backward compat)", () => {
    const pool = new VarPool({})
    const ruleCache = {
      "rule-1": "Always validate inputs",
    }
    const ruleMeta = {
      "rule-1": { fileName: "general.md", scope: "global" },
    }
    pool.set("__knowledge_rule_cache", JSON.stringify(ruleCache))
    pool.set("__knowledge_rule_meta", JSON.stringify(ruleMeta))
    pool.set("__relevant_rule_ids", JSON.stringify(["rule-1"]))

    const injector = new KnowledgeInjector(pool)
    const prompts = injector.getInjectedPrompts("test-workflow", "node-1")

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain("Always validate inputs")

    const injectedIds = JSON.parse(pool.get("__injected_rule_ids") as string)
    expect(injectedIds).toEqual(["rule-1"])
  })

  it("respects budget limit (max 10 rules)", () => {
    const pool = new VarPool({})
    const ruleCache: Record<string, string> = {}
    const ruleMeta: Record<string, { fileName: string; scope: string }> = {}
    const ruleIds: string[] = []
    for (let i = 0; i < 15; i++) {
      ruleCache[`rule-${i}`] = `Rule ${i}`
      ruleMeta[`rule-${i}`] = { fileName: "general.md", scope: "global" }
      ruleIds.push(`rule-${i}`)
    }
    pool.set("__knowledge_rule_cache", JSON.stringify(ruleCache))
    pool.set("__knowledge_rule_meta", JSON.stringify(ruleMeta))
    pool.set("__relevant_rule_ids", JSON.stringify(ruleIds))

    const injector = new KnowledgeInjector(pool)
    const prompts = injector.getInjectedPrompts("test-workflow", "node-1")

    const injectedIds = JSON.parse(pool.get("__injected_rule_ids") as string)
    expect(injectedIds.length).toBeLessThanOrEqual(10)
  })

  it("filters project rules by repoName", () => {
    const pool = new VarPool({})
    const ruleCache = {
      "rule-1": "Project octopus rule",
      "rule-2": "Project other rule",
    }
    const ruleMeta = {
      "rule-1": { fileName: "projects/octopus.md", scope: "project" },
      "rule-2": { fileName: "projects/other.md", scope: "project" },
    }
    pool.set("__knowledge_rule_cache", JSON.stringify(ruleCache))
    pool.set("__knowledge_rule_meta", JSON.stringify(ruleMeta))
    pool.set("__relevant_rule_ids", JSON.stringify(["rule-1", "rule-2"]))
    pool.set("__knowledge_scope_filter", JSON.stringify({ repoNames: ["octopus"], workflowName: "build" }))

    const injector = new KnowledgeInjector(pool)
    const prompts = injector.getInjectedPrompts("build", "node-1")

    // Only rule-1 should be injected (matching repoName)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain("Knowledge Rules — Project: octopus")
    expect(prompts[0]).toContain("Project octopus rule")
    expect(prompts[0]).not.toContain("Project other rule")

    const injectedIds = JSON.parse(pool.get("__injected_rule_ids") as string)
    expect(injectedIds).toEqual(["rule-1"])
  })

  it("filters workflow rules by workflowName", () => {
    const pool = new VarPool({})
    const ruleCache = {
      "rule-1": "Build workflow rule",
      "rule-2": "Deploy workflow rule",
    }
    const ruleMeta = {
      "rule-1": { fileName: "workflows/build.md", scope: "workflow" },
      "rule-2": { fileName: "workflows/deploy.md", scope: "workflow" },
    }
    pool.set("__knowledge_rule_cache", JSON.stringify(ruleCache))
    pool.set("__knowledge_rule_meta", JSON.stringify(ruleMeta))
    pool.set("__relevant_rule_ids", JSON.stringify(["rule-1", "rule-2"]))
    pool.set("__knowledge_scope_filter", JSON.stringify({ repoNames: ["octopus"], workflowName: "build" }))

    const injector = new KnowledgeInjector(pool)
    const prompts = injector.getInjectedPrompts("build", "node-1")

    // Only rule-1 should be injected (matching workflowName)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain("Knowledge Rules — Workflow: build")
    expect(prompts[0]).toContain("Build workflow rule")
    expect(prompts[0]).not.toContain("Deploy workflow rule")

    const injectedIds = JSON.parse(pool.get("__injected_rule_ids") as string)
    expect(injectedIds).toEqual(["rule-1"])
  })

  it("does not inject project rules when repoNames is empty", () => {
    const pool = new VarPool({})
    const ruleCache = {
      "rule-1": "Project rule",
    }
    const ruleMeta = {
      "rule-1": { fileName: "projects/octopus.md", scope: "project" },
    }
    pool.set("__knowledge_rule_cache", JSON.stringify(ruleCache))
    pool.set("__knowledge_rule_meta", JSON.stringify(ruleMeta))
    pool.set("__relevant_rule_ids", JSON.stringify(["rule-1"]))
    // Empty repoNames in scope filter
    pool.set("__knowledge_scope_filter", JSON.stringify({ repoNames: [], workflowName: "build" }))

    const injector = new KnowledgeInjector(pool)
    const prompts = injector.getInjectedPrompts("build", "node-1")

    // Project rules should not be injected without repoName
    const injectedIds = JSON.parse(pool.get("__injected_rule_ids") as string)
    expect(injectedIds).toEqual([])
    // Only user preference or empty
    const rulePrompts = prompts.filter(p => p.includes("Knowledge Rules"))
    expect(rulePrompts).toHaveLength(0)
  })

  it("skips rules with no meta entry", () => {
    const pool = new VarPool({})
    const ruleCache = {
      "rule-1": "Some rule",
    }
    // No rule meta written — no meta available
    pool.set("__knowledge_rule_cache", JSON.stringify(ruleCache))
    pool.set("__relevant_rule_ids", JSON.stringify(["rule-1"]))

    const injector = new KnowledgeInjector(pool)
    const prompts = injector.getInjectedPrompts("build", "node-1")

    // No meta → rule is skipped
    const injectedIds = JSON.parse(pool.get("__injected_rule_ids") as string)
    expect(injectedIds).toEqual([])
    const rulePrompts = prompts.filter(p => p.includes("Knowledge Rules"))
    expect(rulePrompts).toHaveLength(0)
  })

  it("outputs grouped sections for project and workflow rules", () => {
    const pool = new VarPool({})
    const ruleCache = {
      "rule-global": "Global knowledge",
      "rule-proj": "Octopus project rule",
      "rule-wf": "Build workflow rule",
    }
    const ruleMeta = {
      "rule-global": { fileName: "general.md", scope: "global" },
      "rule-proj": { fileName: "projects/octopus.md", scope: "project" },
      "rule-wf": { fileName: "workflows/build.md", scope: "workflow" },
    }
    pool.set("__knowledge_rule_cache", JSON.stringify(ruleCache))
    pool.set("__knowledge_rule_meta", JSON.stringify(ruleMeta))
    pool.set("__relevant_rule_ids", JSON.stringify(["rule-global", "rule-proj", "rule-wf"]))
    pool.set("__knowledge_scope_filter", JSON.stringify({ repoNames: ["octopus"], workflowName: "build" }))

    const injector = new KnowledgeInjector(pool)
    const prompts = injector.getInjectedPrompts("build", "node-1")

    // Should have 3 sections: Global, Project: octopus, Workflow: build
    const ruleSections = prompts.filter(p => p.includes("Knowledge Rules"))
    expect(ruleSections).toHaveLength(3)
    expect(ruleSections[0]).toContain("Knowledge Rules — Global")
    expect(ruleSections[0]).toContain("Global knowledge")
    expect(ruleSections[1]).toContain("Knowledge Rules — Project: octopus")
    expect(ruleSections[1]).toContain("Octopus project rule")
    expect(ruleSections[2]).toContain("Knowledge Rules — Workflow: build")
    expect(ruleSections[2]).toContain("Build workflow rule")

    const injectedIds = JSON.parse(pool.get("__injected_rule_ids") as string)
    expect(injectedIds).toEqual(["rule-global", "rule-proj", "rule-wf"])
  })

  it("injects rules from multiple matching projects", () => {
    const pool = new VarPool({})
    const ruleCache = {
      "r1": "Octopus rule",
      "r2": "My-app rule",
      "r3": "Other-repo rule",
    }
    const ruleMeta = {
      "r1": { fileName: "projects/octopus.md", scope: "project" },
      "r2": { fileName: "projects/my-app.md", scope: "project" },
      "r3": { fileName: "projects/other.md", scope: "project" },
    }
    pool.set("__knowledge_rule_cache", JSON.stringify(ruleCache))
    pool.set("__knowledge_rule_meta", JSON.stringify(ruleMeta))
    pool.set("__relevant_rule_ids", JSON.stringify(["r1", "r2", "r3"]))
    pool.set("__knowledge_scope_filter", JSON.stringify({ repoNames: ["octopus", "my-app"], workflowName: "build" }))

    const injector = new KnowledgeInjector(pool)
    const prompts = injector.getInjectedPrompts("build", "node-1")

    // Should inject r1 and r2 but not r3
    const allText = prompts.join("\n")
    expect(allText).toContain("Octopus rule")
    expect(allText).toContain("My-app rule")
    expect(allText).not.toContain("Other-repo rule")

    // Should have sections for each matching project
    const projectSections = prompts.filter(p => p.includes("Knowledge Rules — Project:"))
    expect(projectSections).toHaveLength(2)
    expect(projectSections[0]).toContain("Project: octopus")
    expect(projectSections[1]).toContain("Project: my-app")

    const injectedIds = JSON.parse(pool.get("__injected_rule_ids") as string)
    expect(injectedIds).toEqual(["r1", "r2"])
  })
})
