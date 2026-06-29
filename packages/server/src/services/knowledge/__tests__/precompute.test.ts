import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { KnowledgeRuleDAO } from "../../../db/dao/knowledge-rule-dao"
import { applySchema } from "../../../db/schema"
import { precomputeRelevantRules } from "../precompute"
import { VarPool } from "@octopus/shared"

describe("precompute", () => {
  let db: Database.Database
  let ruleDAO: KnowledgeRuleDAO

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    ruleDAO = new KnowledgeRuleDAO(db)
  })

  afterEach(() => {
    db?.close()
  })

  it("writes rule cache and relevant IDs to pool", async () => {
    ruleDAO.insert({
      rule_id: "rule-1",
      file_name: "test.md",
      text: "Always validate inputs",
      scope: "project",
      source: "system",
      status: "active",
    })
    ruleDAO.insert({
      rule_id: "rule-2",
      file_name: "test.md",
      text: "Use prepared statements",
      scope: "project",
      source: "system",
      status: "active",
    })

    const pool = new VarPool({})
    await precomputeRelevantRules("test-org", "test-workflow", {}, ruleDAO, pool)

    const cacheRaw = pool.get("__knowledge_rule_cache") as string
    const cache = JSON.parse(cacheRaw)
    expect(cache["rule-1"]).toBe("Always validate inputs")
    expect(cache["rule-2"]).toBe("Use prepared statements")

    const idsRaw = pool.get("__relevant_rule_ids") as string
    const ids = JSON.parse(idsRaw)
    expect(ids).toContain("rule-1")
    expect(ids).toContain("rule-2")
  })

  it("skips when no active rules", async () => {
    const pool = new VarPool({})
    await precomputeRelevantRules("test-org", "test-workflow", {}, ruleDAO, pool)

    expect(pool.get("__knowledge_rule_cache")).toBeUndefined()
    expect(pool.get("__relevant_rule_ids")).toBeUndefined()
  })

  it("only includes active rules", async () => {
    ruleDAO.insert({
      rule_id: "active-rule",
      file_name: "test.md",
      text: "Active rule",
      scope: "project",
      source: "system",
      status: "active",
    })
    ruleDAO.insert({
      rule_id: "retired-rule",
      file_name: "test.md",
      text: "Retired rule",
      scope: "project",
      source: "system",
      status: "retired",
    })

    const pool = new VarPool({})
    await precomputeRelevantRules("test-org", "test-workflow", {}, ruleDAO, pool)

    const idsRaw = pool.get("__relevant_rule_ids") as string
    const ids = JSON.parse(idsRaw)
    expect(ids).toContain("active-rule")
    expect(ids).not.toContain("retired-rule")
  })
})
