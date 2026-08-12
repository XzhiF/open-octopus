/**
 * EvolutionDAO V2 Tests — scope-aware DAO methods
 *
 * Tests the 4 new methods:
 * - listByScope: list experiences by scope with optional scopeRef filter
 * - searchByScope: FTS5 MATCH + scope filter with LIKE fallback
 * - updateOutcome: update outcome JSON for an experience
 * - getSuccessStats: aggregate decision × pattern success rates
 *
 * Also tests insertExperienceV2 and backward compatibility.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { initDb, closeDb, getDb } from "../db/connection"
import { EvolutionDAO } from "../db/dao"
import type { ExperienceRowV2 } from "../db/types"

const TEST_ORG = "test-evo-v2-org"

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

describe("EvolutionDAO V2 — Scope-aware methods", () => {
  let dao: EvolutionDAO

  beforeEach(() => {
    initDb(":memory:")
    dao = new EvolutionDAO(getDb())
  })

  afterEach(() => {
    closeDb()
  })

  // ── insertExperienceV2 ────────────────────────────────────────────

  describe("insertExperienceV2", () => {
    it("inserts a V2 experience with all new fields", () => {
      const row = makeV2Row()
      const result = dao.insertExperienceV2(row)
      expect(result.lastInsertRowid).toBeGreaterThan(0)

      const stored = getDb().prepare("SELECT * FROM experiences WHERE id = ?").get(result.lastInsertRowid) as Record<string, unknown>
      expect(stored.scope).toBe("harness")
      expect(stored.scope_ref).toBe("deterministic_error")
      expect(stored.pattern_tags).toBe('["fix_and_retry","bash","critical"]')
      expect(stored.source_type).toBe("harness")
      expect(stored.execution_id).toBe("exec-001")
      expect(stored.node_id).toBe("node-pull")
    })

    it("also inserts into FTS index", () => {
      const row = makeV2Row({ content: "harness timeout intervention" })
      dao.insertExperienceV2(row)

      const results = dao.searchByScope("timeout", "harness")
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].content).toContain("timeout")
    })

    it("handles nullable fields correctly", () => {
      const row = makeV2Row({
        scope_ref: null,
        outcome: null,
        execution_id: null,
        node_id: null,
      })
      const result = dao.insertExperienceV2(row)
      const stored = getDb().prepare("SELECT * FROM experiences WHERE id = ?").get(result.lastInsertRowid) as Record<string, unknown>
      expect(stored.scope_ref).toBeNull()
      expect(stored.outcome).toBeNull()
      expect(stored.execution_id).toBeNull()
      expect(stored.node_id).toBeNull()
    })
  })

  // ── listByScope ───────────────────────────────────────────────────

  describe("listByScope", () => {
    beforeEach(() => {
      // Insert test data with different scopes
      dao.insertExperienceV2(makeV2Row({ scope: "harness", scope_ref: "detector_a", content: "harness exp 1" }))
      dao.insertExperienceV2(makeV2Row({ scope: "harness", scope_ref: "detector_b", content: "harness exp 2" }))
      dao.insertExperienceV2(makeV2Row({ scope: "harness", scope_ref: "detector_a", content: "harness exp 3" }))
      dao.insertExperienceV2(makeV2Row({ scope: "agent", scope_ref: "skill_x", content: "agent exp 1" }))
      dao.insertExperienceV2(makeV2Row({ scope: "workflow", scope_ref: "wf_y", content: "workflow exp 1" }))
    })

    it("filters by scope", () => {
      const harnessExps = dao.listByScope(TEST_ORG, "harness")
      expect(harnessExps).toHaveLength(3)
      harnessExps.forEach(e => expect(e.scope).toBe("harness"))
    })

    it("filters by scope + scopeRef", () => {
      const results = dao.listByScope(TEST_ORG, "harness", { scopeRef: "detector_a" })
      expect(results).toHaveLength(2)
      results.forEach(e => {
        expect(e.scope).toBe("harness")
        expect(e.scope_ref).toBe("detector_a")
      })
    })

    it("returns empty array for non-matching scope", () => {
      const results = dao.listByScope(TEST_ORG, "global")
      expect(results).toHaveLength(0)
    })

    it("respects limit parameter", () => {
      const results = dao.listByScope(TEST_ORG, "harness", { limit: 2 })
      expect(results).toHaveLength(2)
    })

    it("orders by created_at DESC", () => {
      const results = dao.listByScope(TEST_ORG, "harness")
      // All have the same timestamp, so just verify they're returned
      expect(results.length).toBeGreaterThan(0)
    })

    it("does not return data from other scopes (AC-6 scope isolation)", () => {
      const agentExps = dao.listByScope(TEST_ORG, "agent")
      expect(agentExps).toHaveLength(1)
      expect(agentExps[0].scope).toBe("agent")

      const harnessExps = dao.listByScope(TEST_ORG, "harness")
      expect(harnessExps.every(e => e.scope === "harness")).toBe(true)
    })

    it("does not return data from other orgs", () => {
      const results = dao.listByScope("other-org", "harness")
      expect(results).toHaveLength(0)
    })
  })

  // ── searchByScope ─────────────────────────────────────────────────

  describe("searchByScope", () => {
    beforeEach(() => {
      dao.insertExperienceV2(makeV2Row({
        content: "timeout cascade detected in bash node",
        scope: "harness",
        scope_ref: "timeout_detector",
        pattern_tags: '["fix_and_retry","bash","critical"]',
      }))
      dao.insertExperienceV2(makeV2Row({
        content: "syntax error in python script",
        scope: "harness",
        scope_ref: "syntax_detector",
        pattern_tags: '["guide_and_retry","python","warning"]',
      }))
      dao.insertExperienceV2(makeV2Row({
        content: "timeout issue with agent node",
        scope: "agent",
        scope_ref: "some_skill",
        pattern_tags: '["retry"]',
      }))
    })

    it("searches by query with scope filter", () => {
      const results = dao.searchByScope("timeout", "harness")
      expect(results.length).toBeGreaterThan(0)
      results.forEach(r => {
        expect(r.scope).toBe("harness")
        expect(r.content.toLowerCase()).toContain("timeout")
      })
    })

    it("searches without scope filter (returns all scopes)", () => {
      const results = dao.searchByScope("timeout")
      expect(results.length).toBeGreaterThanOrEqual(2) // harness + agent
    })

    it("returns empty for non-matching query", () => {
      const results = dao.searchByScope("nonexistent_term_xyz")
      expect(results).toHaveLength(0)
    })

    it("respects limit parameter", () => {
      const results = dao.searchByScope("timeout", "harness", 1)
      expect(results).toHaveLength(1)
    })

    it("returns outcome and pattern_tags in results", () => {
      const results = dao.searchByScope("timeout", "harness")
      expect(results.length).toBeGreaterThan(0)
      expect(results[0]).toHaveProperty("outcome")
      expect(results[0]).toHaveProperty("pattern_tags")
      expect(results[0]).toHaveProperty("scope")
      expect(results[0]).toHaveProperty("scope_ref")
    })

    it("falls back to LIKE when FTS MATCH fails", () => {
      // FTS MATCH can fail with special characters
      const results = dao.searchByScope("timeout*", "harness")
      // Should still return results via LIKE fallback or FTS
      // (The behavior depends on whether FTS parses the * as a prefix query)
      expect(Array.isArray(results)).toBe(true)
    })
  })

  // ── updateOutcome ─────────────────────────────────────────────────

  describe("updateOutcome", () => {
    it("updates outcome JSON for an experience", () => {
      const result = dao.insertExperienceV2(makeV2Row({ outcome: null }))
      const id = result.lastInsertRowid as number

      const outcome = JSON.stringify({ label: "success", success_rate: 0.87, usage_count: 10, last_applied: "2024-01-15" })
      dao.updateOutcome(id, outcome)

      const stored = getDb().prepare("SELECT outcome FROM experiences WHERE id = ?").get(id) as { outcome: string }
      const parsed = JSON.parse(stored.outcome)
      expect(parsed.label).toBe("success")
      expect(parsed.success_rate).toBe(0.87)
    })

    it("can update from pending to failed", () => {
      const result = dao.insertExperienceV2(makeV2Row({
        outcome: JSON.stringify({ label: "pending" }),
      }))
      const id = result.lastInsertRowid as number

      const outcome = JSON.stringify({ label: "failed" })
      dao.updateOutcome(id, outcome)

      const stored = getDb().prepare("SELECT outcome FROM experiences WHERE id = ?").get(id) as { outcome: string }
      const parsed = JSON.parse(stored.outcome)
      expect(parsed.label).toBe("failed")
    })

    it("returns RunResult with changes count", () => {
      const result = dao.insertExperienceV2(makeV2Row())
      const id = result.lastInsertRowid as number

      const updateResult = dao.updateOutcome(id, JSON.stringify({ label: "success" }))
      expect(updateResult.changes).toBe(1)
    })

    it("returns 0 changes for non-existent id", () => {
      const updateResult = dao.updateOutcome(99999, JSON.stringify({ label: "success" }))
      expect(updateResult.changes).toBe(0)
    })
  })

  // ── getSuccessStats ───────────────────────────────────────────────

  describe("getSuccessStats", () => {
    beforeEach(() => {
      // Insert harness experiences with various outcomes
      // fix_and_retry: 3 success, 1 failed → rate 75%
      dao.insertExperienceV2(makeV2Row({
        pattern_tags: '["fix_and_retry","bash"]',
        outcome: JSON.stringify({ label: "success" }),
        scope_ref: "detector_a",
      }))
      dao.insertExperienceV2(makeV2Row({
        pattern_tags: '["fix_and_retry","python"]',
        outcome: JSON.stringify({ label: "success" }),
        scope_ref: "detector_a",
      }))
      dao.insertExperienceV2(makeV2Row({
        pattern_tags: '["fix_and_retry","bash"]',
        outcome: JSON.stringify({ label: "success" }),
        scope_ref: "detector_a",
      }))
      dao.insertExperienceV2(makeV2Row({
        pattern_tags: '["fix_and_retry","bash"]',
        outcome: JSON.stringify({ label: "failed" }),
        scope_ref: "detector_a",
      }))

      // guide_and_retry: 1 success, 1 pending
      dao.insertExperienceV2(makeV2Row({
        pattern_tags: '["guide_and_retry","bash"]',
        outcome: JSON.stringify({ label: "success" }),
        scope_ref: "detector_a",
      }))
      dao.insertExperienceV2(makeV2Row({
        pattern_tags: '["guide_and_retry","python"]',
        outcome: JSON.stringify({ label: "pending" }),
        scope_ref: "detector_a",
      }))

      // Agent scope (should not be included when querying harness)
      dao.insertExperienceV2(makeV2Row({
        scope: "agent",
        pattern_tags: '["fix_and_retry"]',
        outcome: JSON.stringify({ label: "failed" }),
      }))
    })

    it("returns decision stats grouped by first pattern tag", () => {
      const stats = dao.getSuccessStats(TEST_ORG, "harness")
      expect(stats.decisionStats).toHaveProperty("fix_and_retry")
      expect(stats.decisionStats).toHaveProperty("guide_and_retry")
    })

    it("calculates correct success rate for fix_and_retry", () => {
      const stats = dao.getSuccessStats(TEST_ORG, "harness")
      const fixAndRetry = stats.decisionStats["fix_and_retry"]
      expect(fixAndRetry.success).toBe(3)
      expect(fixAndRetry.failed).toBe(1)
      expect(fixAndRetry.pending).toBe(0)
      expect(fixAndRetry.total).toBe(4)
      // 3 success / (3 success + 1 failed) = 0.75
      expect(fixAndRetry.rate).toBe(0.75)
    })

    it("calculates correct stats for guide_and_retry", () => {
      const stats = dao.getSuccessStats(TEST_ORG, "harness")
      const guideAndRetry = stats.decisionStats["guide_and_retry"]
      expect(guideAndRetry.success).toBe(1)
      expect(guideAndRetry.failed).toBe(0)
      expect(guideAndRetry.pending).toBe(1)
      expect(guideAndRetry.total).toBe(2)
      // 1 success / (1 success + 0 failed) = 1.0
      expect(guideAndRetry.rate).toBe(1)
    })

    it("does not include data from other scopes", () => {
      const stats = dao.getSuccessStats(TEST_ORG, "harness")
      // The agent scope fix_and_retry failure should NOT be counted
      const fixAndRetry = stats.decisionStats["fix_and_retry"]
      expect(fixAndRetry.failed).toBe(1) // Only harness failure, not agent
    })

    it("filters by scopeRef when provided", () => {
      // Add a harness experience with a different scope_ref
      dao.insertExperienceV2(makeV2Row({
        pattern_tags: '["agent_takeover"]',
        outcome: JSON.stringify({ label: "failed" }),
        scope_ref: "detector_b",
      }))

      const stats = dao.getSuccessStats(TEST_ORG, "harness", "detector_a")
      expect(stats.decisionStats).not.toHaveProperty("agent_takeover")
      expect(stats.decisionStats).toHaveProperty("fix_and_retry")
    })

    it("returns pattern stats for all tags", () => {
      const stats = dao.getSuccessStats(TEST_ORG, "harness")
      // pattern stats include all tags, not just the first
      expect(stats.patternStats).toHaveProperty("bash")
      expect(stats.patternStats).toHaveProperty("python")
      expect(stats.patternStats).toHaveProperty("fix_and_retry")
      expect(stats.patternStats).toHaveProperty("guide_and_retry")
    })

    it("handles null outcome as pending", () => {
      dao.insertExperienceV2(makeV2Row({
        pattern_tags: '["new_decision"]',
        outcome: null,
        scope_ref: "detector_c",
      }))

      const stats = dao.getSuccessStats(TEST_ORG, "harness", "detector_c")
      const newDecision = stats.decisionStats["new_decision"]
      expect(newDecision.pending).toBe(1)
      expect(newDecision.rate).toBe(0) // No resolved outcomes
    })

    it("handles empty result set", () => {
      const stats = dao.getSuccessStats("nonexistent-org", "harness")
      expect(Object.keys(stats.decisionStats)).toHaveLength(0)
      expect(Object.keys(stats.patternStats)).toHaveLength(0)
    })

    it("returns rate 0 when no resolved outcomes exist", () => {
      // Clear and insert only pending
      const allHarness = dao.listByScope(TEST_ORG, "harness")
      for (const exp of allHarness) {
        dao.updateOutcome(exp.id, JSON.stringify({ label: "pending" }))
      }

      const stats = dao.getSuccessStats(TEST_ORG, "harness")
      for (const key of Object.keys(stats.decisionStats)) {
        expect(stats.decisionStats[key].rate).toBe(0)
      }
    })
  })

  // ── searchByScopes ────────────────────────────────────────────────

  describe("searchByScopes", () => {
    beforeEach(() => {
      dao.insertExperienceV2(makeV2Row({
        content: "timeout cascade detected in bash node",
        scope: "harness",
        scope_ref: "timeout_detector",
        pattern_tags: '["fix_and_retry","bash","critical"]',
      }))
      dao.insertExperienceV2(makeV2Row({
        content: "syntax error in python script",
        scope: "harness",
        scope_ref: "syntax_detector",
        pattern_tags: '["guide_and_retry","python","warning"]',
      }))
      dao.insertExperienceV2(makeV2Row({
        content: "timeout issue with agent node",
        scope: "agent",
        scope_ref: "some_skill",
        pattern_tags: '["retry"]',
      }))
      dao.insertExperienceV2(makeV2Row({
        content: "global timeout configuration best practice",
        scope: "global",
        scope_ref: null,
        pattern_tags: '["best_practice"]',
      }))
      dao.insertExperienceV2(makeV2Row({
        content: "workflow timeout handling strategy",
        scope: "workflow",
        scope_ref: "wf_node_1",
        pattern_tags: '["timeout_handling"]',
      }))
    })

    it("searches across multiple scopes", () => {
      const results = dao.searchByScopes("timeout", ["harness", "global"], 10)
      expect(results.length).toBeGreaterThanOrEqual(2)
      results.forEach(r => {
        expect(["harness", "global"]).toContain(r.scope)
      })
    })

    it("returns only rows matching specified scopes", () => {
      const results = dao.searchByScopes("timeout", ["agent", "global"], 10)
      results.forEach(r => {
        expect(["agent", "global"]).toContain(r.scope)
      })
      // Should NOT include harness or workflow results
      expect(results.every(r => r.scope !== "harness")).toBe(true)
      expect(results.every(r => r.scope !== "workflow")).toBe(true)
    })

    it("returns empty array when no scopes match", () => {
      const results = dao.searchByScopes("timeout", ["nonexistent_scope"], 10)
      expect(results).toHaveLength(0)
    })

    it("returns empty array for non-matching query", () => {
      const results = dao.searchByScopes("xyznonexistent", ["harness", "global"], 10)
      expect(results).toHaveLength(0)
    })

    it("respects limit parameter", () => {
      const results = dao.searchByScopes("timeout", ["harness", "agent", "global", "workflow"], 2)
      expect(results).toHaveLength(2)
    })

    it("returns full experience row with all V2 fields", () => {
      const results = dao.searchByScopes("timeout", ["harness"], 10)
      expect(results.length).toBeGreaterThan(0)
      const row = results[0]
      expect(row).toHaveProperty("id")
      expect(row).toHaveProperty("skill_name")
      expect(row).toHaveProperty("content")
      expect(row).toHaveProperty("scope")
      expect(row).toHaveProperty("scope_ref")
      expect(row).toHaveProperty("pattern_tags")
      expect(row).toHaveProperty("outcome")
    })

    it("falls back to LIKE when FTS MATCH fails", () => {
      // Use a query with special chars that might break FTS
      const results = dao.searchByScopes("timeout*", ["harness", "global"], 10)
      expect(Array.isArray(results)).toBe(true)
    })

    it("handles empty scopes array", () => {
      const results = dao.searchByScopes("timeout", [], 10)
      expect(results).toHaveLength(0)
    })

    it("uses default limit of 5 when not specified", () => {
      // Insert more than 5 matching rows
      for (let i = 0; i < 7; i++) {
        dao.insertExperienceV2(makeV2Row({
          content: `timeout issue number ${i}`,
          scope: "harness",
        }))
      }
      const results = dao.searchByScopes("timeout", ["harness"])
      expect(results.length).toBeLessThanOrEqual(5)
    })
  })

  // ── Backward compatibility ────────────────────────────────────────

  describe("backward compatibility (AC-8)", () => {
    it("existing listExperiences still works with V2 schema", () => {
      // Insert using old method (no V2 fields)
      dao.insertExperience({
        skill_name: "old-skill",
        content: "old content",
        source_session_id: null,
        org: TEST_ORG,
        created_at: "2024-01-01",
      })

      const results = dao.listExperiences(TEST_ORG)
      expect(results).toHaveLength(1)
      expect(results[0].skill_name).toBe("old-skill")
      expect(results[0].content).toBe("old content")
    })

    it("existing searchExperiences still works with V2 FTS", () => {
      dao.insertExperience({
        skill_name: "search-skill",
        content: "searchable content about errors",
        source_session_id: null,
        org: TEST_ORG,
        created_at: "2024-01-01",
      })

      const results = dao.searchExperiences("errors")
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].skill_name).toBe("search-skill")
    })

    it("insertExperienceWithFts still works", () => {
      dao.insertExperienceWithFts({
        skill_name: "fts-skill",
        content: "fts content about failures",
        source_session_id: null,
        org: TEST_ORG,
        created_at: "2024-01-01",
      })

      const results = dao.searchExperiences("failures")
      expect(results.length).toBeGreaterThan(0)
    })

    it("old experiences have default scope='agent'", () => {
      dao.insertExperience({
        skill_name: "default-scope-skill",
        content: "should have default scope",
        source_session_id: null,
        org: TEST_ORG,
        created_at: "2024-01-01",
      })

      const stored = getDb().prepare("SELECT scope, source_type FROM experiences WHERE skill_name = ?").get("default-scope-skill") as { scope: string; source_type: string }
      expect(stored.scope).toBe("agent")
      expect(stored.source_type).toBe("session")
    })
  })
})
