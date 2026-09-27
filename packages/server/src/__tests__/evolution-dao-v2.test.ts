// P1 B3: EvolutionDAO 已迁 postgres.js —— 本文件从 initDb(:memory:) 切到
// PG 随机测试库（每例一座）。用例语义与条数逐条保持；jsonb 列断言按 B2 配方
// 走 JSON.parse deep-equal（jsonb 规范化文本与写入串空白/键序可能不同）。
/**
 * EvolutionDAO V2 Tests — scope-aware DAO methods
 *
 * Tests the 4 new methods:
 * - listByScope: list experiences by scope with optional scopeRef filter
 * - searchByScope: 检索面 + scope 过滤（LIKE 兜底）
 * - updateOutcome: update outcome JSON for an experience
 * - getSuccessStats: aggregate decision × pattern success rates
 *
 * Also tests insertExperienceV2 and backward compatibility.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { EvolutionDAO } from "../db/dao/evolution-dao"
import type { ExperienceRowV2 } from "../db/types"
import { describePg, setupPgSchema, type PgFixture } from "../db/pg/__tests__/dao-fixture"

const TEST_ORG = "test-evo-v2-org"

let pg: PgFixture
let dao: EvolutionDAO

function makeV2Row(overrides: Partial<ExperienceRowV2> = {}): Omit<ExperienceRowV2, "id"> {
  return {
    skill_name: "test-skill",
    content: "test experience content",
    source_session_id: null,
    org: TEST_ORG,
    created_at: "2024-01-01T00:00:00.000Z",
    scope: "harness",
    scope_ref: "deterministic_error",
    pattern_tags: '["fix_and_retry","bash","critical"]',
    outcome: null,
    source_type: "harness",
    execution_id: "exec-001",
    node_id: "node-pull",
    ...overrides,
  }
}

describePg("EvolutionDAO V2 — Scope-aware methods", () => {
  beforeEach(async () => {
    pg = await setupPgSchema()
    dao = new EvolutionDAO(pg.sql)
  })

  afterEach(async () => {
    await pg.close()
  })

  // ── insertExperienceV2 ────────────────────────────────────────────

  describe("insertExperienceV2", () => {
    it("inserts a V2 experience with all new fields", async () => {
      const row = makeV2Row()
      const result = await dao.insertExperienceV2(row)
      expect(result.id).toBeGreaterThan(0)

      const stored = (await pg.sql`SELECT id::int AS id, scope, scope_ref, pattern_tags #>> '{}' AS pattern_tags, source_type, execution_id, node_id FROM experiences WHERE id = ${result.id}`)[0] as Record<string, unknown>
      expect(stored.scope).toBe("harness")
      expect(stored.scope_ref).toBe("deterministic_error")
      expect(JSON.parse(stored.pattern_tags as string)).toEqual(["fix_and_retry", "bash", "critical"])
      expect(stored.source_type).toBe("harness")
      expect(stored.execution_id).toBe("exec-001")
      expect(stored.node_id).toBe("node-pull")
    })

    it("also inserts into FTS index", async () => {
      const row = makeV2Row({ content: "harness timeout intervention" })
      await dao.insertExperienceV2(row)

      const results = await dao.searchByScope("timeout", "harness")
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].content).toContain("timeout")
    })

    it("handles nullable fields correctly", async () => {
      const row = makeV2Row({
        scope_ref: null,
        outcome: null,
        execution_id: null,
        node_id: null,
      })
      const result = await dao.insertExperienceV2(row)
      const stored = (await pg.sql`SELECT scope_ref, outcome, execution_id, node_id FROM experiences WHERE id = ${result.id}`)[0] as Record<string, unknown>
      expect(stored.scope_ref).toBeNull()
      expect(stored.outcome).toBeNull()
      expect(stored.execution_id).toBeNull()
      expect(stored.node_id).toBeNull()
    })
  })

  // ── listByScope ───────────────────────────────────────────────────

  describe("listByScope", () => {
    beforeEach(async () => {
      // Insert test data with different scopes
      await dao.insertExperienceV2(makeV2Row({ scope: "harness", scope_ref: "detector_a", content: "harness exp 1" }))
      await dao.insertExperienceV2(makeV2Row({ scope: "harness", scope_ref: "detector_b", content: "harness exp 2" }))
      await dao.insertExperienceV2(makeV2Row({ scope: "harness", scope_ref: "detector_a", content: "harness exp 3" }))
      await dao.insertExperienceV2(makeV2Row({ scope: "agent", scope_ref: "skill_x", content: "agent exp 1" }))
      await dao.insertExperienceV2(makeV2Row({ scope: "workflow", scope_ref: "wf_y", content: "workflow exp 1" }))
    })

    it("filters by scope", async () => {
      const harnessExps = await dao.listByScope(TEST_ORG, "harness")
      expect(harnessExps).toHaveLength(3)
      harnessExps.forEach(e => expect(e.scope).toBe("harness"))
    })

    it("filters by scope + scopeRef", async () => {
      const results = await dao.listByScope(TEST_ORG, "harness", { scopeRef: "detector_a" })
      expect(results).toHaveLength(2)
      results.forEach(e => {
        expect(e.scope).toBe("harness")
        expect(e.scope_ref).toBe("detector_a")
      })
    })

    it("returns empty array for non-matching scope", async () => {
      const results = await dao.listByScope(TEST_ORG, "global")
      expect(results).toHaveLength(0)
    })

    it("respects limit parameter", async () => {
      const results = await dao.listByScope(TEST_ORG, "harness", { limit: 2 })
      expect(results).toHaveLength(2)
    })

    it("orders by created_at DESC", async () => {
      const results = await dao.listByScope(TEST_ORG, "harness")
      // All have the same timestamp, so just verify they're returned
      expect(results.length).toBeGreaterThan(0)
    })

    it("does not return data from other scopes (AC-6 scope isolation)", async () => {
      const agentExps = await dao.listByScope(TEST_ORG, "agent")
      expect(agentExps).toHaveLength(1)
      expect(agentExps[0].scope).toBe("agent")

      const harnessExps = await dao.listByScope(TEST_ORG, "harness")
      expect(harnessExps.every(e => e.scope === "harness")).toBe(true)
    })

    it("does not return data from other orgs", async () => {
      const results = await dao.listByScope("other-org", "harness")
      expect(results).toHaveLength(0)
    })
  })

  // ── searchByScope ─────────────────────────────────────────────────

  describe("searchByScope", () => {
    beforeEach(async () => {
      await dao.insertExperienceV2(makeV2Row({
        content: "timeout cascade detected in bash node",
        scope: "harness",
        scope_ref: "timeout_detector",
        pattern_tags: '["fix_and_retry","bash","critical"]',
      }))
      await dao.insertExperienceV2(makeV2Row({
        content: "syntax error in python script",
        scope: "harness",
        scope_ref: "syntax_detector",
        pattern_tags: '["guide_and_retry","python","warning"]',
      }))
      await dao.insertExperienceV2(makeV2Row({
        content: "timeout issue with agent node",
        scope: "agent",
        scope_ref: "some_skill",
        pattern_tags: '["retry"]',
      }))
    })

    it("searches by query with scope filter", async () => {
      const results = await dao.searchByScope("timeout", "harness")
      expect(results.length).toBeGreaterThan(0)
      results.forEach(r => {
        expect(r.scope).toBe("harness")
        expect(r.content.toLowerCase()).toContain("timeout")
      })
    })

    it("searches without scope filter (returns all scopes)", async () => {
      const results = await dao.searchByScope("timeout")
      expect(results.length).toBeGreaterThanOrEqual(2) // harness + agent
    })

    it("returns empty for non-matching query", async () => {
      const results = await dao.searchByScope("nonexistent_term_xyz")
      expect(results).toHaveLength(0)
    })

    it("respects limit parameter", async () => {
      const results = await dao.searchByScope("timeout", "harness", 1)
      expect(results).toHaveLength(1)
    })

    it("returns outcome and pattern_tags in results", async () => {
      const results = await dao.searchByScope("timeout", "harness")
      expect(results.length).toBeGreaterThan(0)
      expect(results[0]).toHaveProperty("outcome")
      expect(results[0]).toHaveProperty("pattern_tags")
      expect(results[0]).toHaveProperty("scope")
      expect(results[0]).toHaveProperty("scope_ref")
    })

    it("falls back to LIKE when FTS MATCH fails", async () => {
      // 检索面对特殊字符输入不许抛（段1 ILIKE / 段2 BM25 解析炸 → ILIKE 兜底）
      const results = await dao.searchByScope("timeout*", "harness")
      // Should still return results via LIKE fallback or FTS
      // (The behavior depends on whether FTS parses the * as a prefix query)
      expect(Array.isArray(results)).toBe(true)
    })
  })

  // ── updateOutcome ─────────────────────────────────────────────────

  describe("updateOutcome", () => {
    it("updates outcome JSON for an experience", async () => {
      const result = await dao.insertExperienceV2(makeV2Row({ outcome: null }))
      const id = result.id

      const outcome = JSON.stringify({ label: "success", success_rate: 0.87, usage_count: 10, last_applied: "2024-01-15" })
      await dao.updateOutcome(id, outcome)

      const stored = (await pg.sql`SELECT outcome FROM experiences WHERE id = ${id}`)[0] as { outcome: string }
      const parsed = JSON.parse(stored.outcome)
      expect(parsed.label).toBe("success")
      expect(parsed.success_rate).toBe(0.87)
    })

    it("can update from pending to failed", async () => {
      const result = await dao.insertExperienceV2(makeV2Row({
        outcome: JSON.stringify({ label: "pending" }),
      }))
      const id = result.id

      const outcome = JSON.stringify({ label: "failed" })
      await dao.updateOutcome(id, outcome)

      const stored = (await pg.sql`SELECT outcome FROM experiences WHERE id = ${id}`)[0] as { outcome: string }
      const parsed = JSON.parse(stored.outcome)
      expect(parsed.label).toBe("failed")
    })

    it("returns RunResult with changes count", async () => {
      const result = await dao.insertExperienceV2(makeV2Row())
      const id = result.id

      const updateResult = await dao.updateOutcome(id, JSON.stringify({ label: "success" }))
      expect(updateResult.changes).toBe(1)
    })

    it("returns 0 changes for non-existent id", async () => {
      const updateResult = await dao.updateOutcome(99999, JSON.stringify({ label: "success" }))
      expect(updateResult.changes).toBe(0)
    })
  })

  // ── getSuccessStats ───────────────────────────────────────────────

  describe("getSuccessStats", () => {
    beforeEach(async () => {
      // Insert harness experiences with various outcomes
      // fix_and_retry: 3 success, 1 failed → rate 75%
      await dao.insertExperienceV2(makeV2Row({
        pattern_tags: '["fix_and_retry","bash"]',
        outcome: JSON.stringify({ label: "success" }),
        scope_ref: "detector_a",
      }))
      await dao.insertExperienceV2(makeV2Row({
        pattern_tags: '["fix_and_retry","python"]',
        outcome: JSON.stringify({ label: "success" }),
        scope_ref: "detector_a",
      }))
      await dao.insertExperienceV2(makeV2Row({
        pattern_tags: '["fix_and_retry","bash"]',
        outcome: JSON.stringify({ label: "success" }),
        scope_ref: "detector_a",
      }))
      await dao.insertExperienceV2(makeV2Row({
        pattern_tags: '["fix_and_retry","bash"]',
        outcome: JSON.stringify({ label: "failed" }),
        scope_ref: "detector_a",
      }))

      // guide_and_retry: 1 success, 1 pending
      await dao.insertExperienceV2(makeV2Row({
        pattern_tags: '["guide_and_retry","bash"]',
        outcome: JSON.stringify({ label: "success" }),
        scope_ref: "detector_a",
      }))
      await dao.insertExperienceV2(makeV2Row({
        pattern_tags: '["guide_and_retry","python"]',
        outcome: JSON.stringify({ label: "pending" }),
        scope_ref: "detector_a",
      }))

      // Agent scope (should not be included when querying harness)
      await dao.insertExperienceV2(makeV2Row({
        scope: "agent",
        pattern_tags: '["fix_and_retry"]',
        outcome: JSON.stringify({ label: "failed" }),
      }))
    })

    it("returns decision stats grouped by first pattern tag", async () => {
      const stats = await dao.getSuccessStats(TEST_ORG, "harness")
      expect(stats.decisionStats).toHaveProperty("fix_and_retry")
      expect(stats.decisionStats).toHaveProperty("guide_and_retry")
    })

    it("calculates correct success rate for fix_and_retry", async () => {
      const stats = await dao.getSuccessStats(TEST_ORG, "harness")
      const fixAndRetry = stats.decisionStats["fix_and_retry"]
      expect(fixAndRetry.success).toBe(3)
      expect(fixAndRetry.failed).toBe(1)
      expect(fixAndRetry.pending).toBe(0)
      expect(fixAndRetry.total).toBe(4)
      // 3 success / (3 success + 1 failed) = 0.75
      expect(fixAndRetry.rate).toBe(0.75)
    })

    it("calculates correct stats for guide_and_retry", async () => {
      const stats = await dao.getSuccessStats(TEST_ORG, "harness")
      const guideAndRetry = stats.decisionStats["guide_and_retry"]
      expect(guideAndRetry.success).toBe(1)
      expect(guideAndRetry.failed).toBe(0)
      expect(guideAndRetry.pending).toBe(1)
      expect(guideAndRetry.total).toBe(2)
      // 1 success / (1 success + 0 failed) = 1.0
      expect(guideAndRetry.rate).toBe(1)
    })

    it("does not include data from other scopes", async () => {
      const stats = await dao.getSuccessStats(TEST_ORG, "harness")
      // The agent scope fix_and_retry failure should NOT be counted
      const fixAndRetry = stats.decisionStats["fix_and_retry"]
      expect(fixAndRetry.failed).toBe(1) // Only harness failure, not agent
    })

    it("filters by scopeRef when provided", async () => {
      // Add a harness experience with a different scope_ref
      await dao.insertExperienceV2(makeV2Row({
        pattern_tags: '["agent_takeover"]',
        outcome: JSON.stringify({ label: "failed" }),
        scope_ref: "detector_b",
      }))

      const stats = await dao.getSuccessStats(TEST_ORG, "harness", "detector_a")
      expect(stats.decisionStats).not.toHaveProperty("agent_takeover")
      expect(stats.decisionStats).toHaveProperty("fix_and_retry")
    })

    it("returns pattern stats for all tags", async () => {
      const stats = await dao.getSuccessStats(TEST_ORG, "harness")
      // pattern stats include all tags, not just the first
      expect(stats.patternStats).toHaveProperty("bash")
      expect(stats.patternStats).toHaveProperty("python")
      expect(stats.patternStats).toHaveProperty("fix_and_retry")
      expect(stats.patternStats).toHaveProperty("guide_and_retry")
    })

    it("handles null outcome as pending", async () => {
      await dao.insertExperienceV2(makeV2Row({
        pattern_tags: '["new_decision"]',
        outcome: null,
        scope_ref: "detector_c",
      }))

      const stats = await dao.getSuccessStats(TEST_ORG, "harness", "detector_c")
      const newDecision = stats.decisionStats["new_decision"]
      expect(newDecision.pending).toBe(1)
      expect(newDecision.rate).toBe(0) // No resolved outcomes
    })

    it("handles empty result set", async () => {
      const stats = await dao.getSuccessStats("nonexistent-org", "harness")
      expect(Object.keys(stats.decisionStats)).toHaveLength(0)
      expect(Object.keys(stats.patternStats)).toHaveLength(0)
    })

    it("returns rate 0 when no resolved outcomes exist", async () => {
      // Clear and insert only pending
      const allHarness = await dao.listByScope(TEST_ORG, "harness")
      for (const exp of allHarness) {
        await dao.updateOutcome(exp.id, JSON.stringify({ label: "pending" }))
      }

      const stats = await dao.getSuccessStats(TEST_ORG, "harness")
      for (const key of Object.keys(stats.decisionStats)) {
        expect(stats.decisionStats[key].rate).toBe(0)
      }
    })
  })

  // ── Backward compatibility ────────────────────────────────────────

  describe("backward compatibility (AC-8)", () => {
    it("existing listExperiences still works with V2 schema", async () => {
      // Insert using old method (no V2 fields)
      await dao.insertExperience({
        skill_name: "old-skill",
        content: "old content",
        source_session_id: null,
        org: TEST_ORG,
        created_at: "2024-01-01",
      })

      const results = await dao.listExperiences(TEST_ORG)
      expect(results).toHaveLength(1)
      expect(results[0].skill_name).toBe("old-skill")
      expect(results[0].content).toBe("old content")
    })

    it("existing searchExperiences still works with V2 FTS", async () => {
      await dao.insertExperience({
        skill_name: "search-skill",
        content: "searchable content about errors",
        source_session_id: null,
        org: TEST_ORG,
        created_at: "2024-01-01",
      })

      const results = await dao.searchExperiences("errors")
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].skill_name).toBe("search-skill")
    })

    it("insertExperienceWithFts still works", async () => {
      await dao.insertExperienceWithFts({
        skill_name: "fts-skill",
        content: "fts content about failures",
        source_session_id: null,
        org: TEST_ORG,
        created_at: "2024-01-01",
      })

      const results = await dao.searchExperiences("failures")
      expect(results.length).toBeGreaterThan(0)
    })

    it("old experiences have default scope='agent'", async () => {
      await dao.insertExperience({
        skill_name: "default-scope-skill",
        content: "should have default scope",
        source_session_id: null,
        org: TEST_ORG,
        created_at: "2024-01-01",
      })

      const stored = (await pg.sql`SELECT scope, source_type FROM experiences WHERE skill_name = 'default-scope-skill'`)[0] as { scope: string; source_type: string }
      expect(stored.scope).toBe("agent")
      expect(stored.source_type).toBe("session")
    })
  })
})
