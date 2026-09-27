// P1 B2: KnowledgeEffectivenessDAO 已迁 postgres.js —— 本文件走 PG 随机测试库
// （每例一座，dao-fixture 快路径）。用例语义与条数逐条保持。
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { KnowledgeEffectivenessDAO } from "../knowledge-effectiveness-dao"
import { describePg, setupPgSchema, type PgFixture } from "../../pg/__tests__/dao-fixture"

describePg("KnowledgeEffectivenessDAO", () => {
  let pg: PgFixture
  let dao: KnowledgeEffectivenessDAO

  beforeEach(async () => {
    pg = await setupPgSchema()
    dao = new KnowledgeEffectivenessDAO(pg.sql)
  })

  afterEach(async () => {
    await pg.close()
  })

  it("increments injected count", async () => {
    await dao.incrementInjected("rule-1")
    const row = await dao.getByRuleId("rule-1")
    expect(row?.injected_count).toBe(1)

    await dao.incrementInjected("rule-1")
    const row2 = await dao.getByRuleId("rule-1")
    expect(row2?.injected_count).toBe(2)
  })

  it("increments helpful count", async () => {
    await dao.incrementInjected("rule-1")
    await dao.incrementHelpful("rule-1")
    const row = await dao.getByRuleId("rule-1")
    expect(row?.helpful_count).toBe(1)
    expect(row?.not_helpful_count).toBe(0)
  })

  it("increments not helpful count", async () => {
    await dao.incrementInjected("rule-1")
    await dao.incrementNotHelpful("rule-1")
    const row = await dao.getByRuleId("rule-1")
    expect(row?.helpful_count).toBe(0)
    expect(row?.not_helpful_count).toBe(1)
  })

  it("calculates confidence correctly", async () => {
    // 3 helpful, 1 not helpful = 75% helpful
    await dao.incrementInjected("rule-1")
    await dao.incrementHelpful("rule-1")
    await dao.incrementInjected("rule-1")
    await dao.incrementHelpful("rule-1")
    await dao.incrementInjected("rule-1")
    await dao.incrementHelpful("rule-1")
    await dao.incrementInjected("rule-1")
    await dao.incrementNotHelpful("rule-1")

    const row = await dao.getByRuleId("rule-1")
    expect(row?.injected_count).toBe(4)
    expect(row?.helpful_count).toBe(3)
    expect(row?.not_helpful_count).toBe(1)
    expect(row?.confidence).toBe(0.75)
  })

  it("lists stale rules", async () => {
    // Create a rule with low confidence that has been injected enough times
    await dao.incrementInjected("stale-rule")
    await dao.incrementNotHelpful("stale-rule")
    await dao.incrementInjected("stale-rule")
    await dao.incrementNotHelpful("stale-rule")
    await dao.incrementInjected("stale-rule")
    await dao.incrementNotHelpful("stale-rule")

    // Create a good rule
    await dao.incrementInjected("good-rule")
    await dao.incrementHelpful("good-rule")
    await dao.incrementInjected("good-rule")
    await dao.incrementHelpful("good-rule")
    await dao.incrementInjected("good-rule")
    await dao.incrementHelpful("good-rule")

    const staleRules = await dao.listStale(3, 0.3, 0)
    expect(staleRules).toHaveLength(1)
    expect(staleRules[0].rule_id).toBe("stale-rule")
  })

  it("lists all effectiveness records", async () => {
    await dao.incrementInjected("rule-1")
    await dao.incrementInjected("rule-2")
    await dao.incrementInjected("rule-3")

    const all = await dao.listAll()
    expect(all).toHaveLength(3)
  })
})
