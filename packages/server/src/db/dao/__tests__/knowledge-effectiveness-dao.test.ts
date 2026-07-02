import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { KnowledgeEffectivenessDAO } from "../knowledge-effectiveness-dao"
import { applySchema } from "../../schema"

describe("KnowledgeEffectivenessDAO", () => {
  let db: Database.Database
  let dao: KnowledgeEffectivenessDAO

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    dao = new KnowledgeEffectivenessDAO(db)
  })

  afterEach(() => {
    db?.close()
  })

  it("increments injected count", () => {
    dao.incrementInjected("rule-1")
    const row = dao.getByRuleId("rule-1")
    expect(row?.injected_count).toBe(1)

    dao.incrementInjected("rule-1")
    const row2 = dao.getByRuleId("rule-1")
    expect(row2?.injected_count).toBe(2)
  })

  it("increments helpful count", () => {
    dao.incrementInjected("rule-1")
    dao.incrementHelpful("rule-1")
    const row = dao.getByRuleId("rule-1")
    expect(row?.helpful_count).toBe(1)
    expect(row?.not_helpful_count).toBe(0)
  })

  it("increments not helpful count", () => {
    dao.incrementInjected("rule-1")
    dao.incrementNotHelpful("rule-1")
    const row = dao.getByRuleId("rule-1")
    expect(row?.helpful_count).toBe(0)
    expect(row?.not_helpful_count).toBe(1)
  })

  it("calculates confidence correctly", () => {
    // 3 helpful, 1 not helpful = 75% helpful
    dao.incrementInjected("rule-1")
    dao.incrementHelpful("rule-1")
    dao.incrementInjected("rule-1")
    dao.incrementHelpful("rule-1")
    dao.incrementInjected("rule-1")
    dao.incrementHelpful("rule-1")
    dao.incrementInjected("rule-1")
    dao.incrementNotHelpful("rule-1")

    const row = dao.getByRuleId("rule-1")
    expect(row?.injected_count).toBe(4)
    expect(row?.helpful_count).toBe(3)
    expect(row?.not_helpful_count).toBe(1)
    expect(row?.confidence).toBe(0.75)
  })

  it("lists stale rules", () => {
    // Create a rule with low confidence that has been injected enough times
    dao.incrementInjected("stale-rule")
    dao.incrementNotHelpful("stale-rule")
    dao.incrementInjected("stale-rule")
    dao.incrementNotHelpful("stale-rule")
    dao.incrementInjected("stale-rule")
    dao.incrementNotHelpful("stale-rule")

    // Create a good rule
    dao.incrementInjected("good-rule")
    dao.incrementHelpful("good-rule")
    dao.incrementInjected("good-rule")
    dao.incrementHelpful("good-rule")
    dao.incrementInjected("good-rule")
    dao.incrementHelpful("good-rule")

    const staleRules = dao.listStale(3, 0.3, 0)
    expect(staleRules).toHaveLength(1)
    expect(staleRules[0].rule_id).toBe("stale-rule")
  })

  it("lists all effectiveness records", () => {
    dao.incrementInjected("rule-1")
    dao.incrementInjected("rule-2")
    dao.incrementInjected("rule-3")

    const all = dao.listAll()
    expect(all).toHaveLength(3)
  })
})
