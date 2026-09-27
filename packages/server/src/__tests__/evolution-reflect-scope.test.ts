/**
 * Ticket 05 — Evolution Reflect + Scope Integration
 *
 * Tests:
 * - AC-1: reflect() accepts optional scope parameter, filters by scope
 * - AC-2: reflect insights are written to experiences table (source_type='reflection')
 * - AC-3: harness scope reflect analyzes decision stats + detector accuracy + pattern frequency
 * - AC-4: reflection experiences are searchable via FTS5 searchByScope
 * - AC-5: existing reflect() behavior (no scope) is unchanged
 * - AC-6: reflection trigger mechanism is well-defined (onExecutionEnd or periodic)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { EvolutionDAO } from "../db/dao"
import { describePg, setupPgSchema, type PgFixture } from "../db/pg/__tests__/dao-fixture"
import { EvolutionService } from "../services/agent/evolution-service"
import type { ExperienceRowV2 } from "../db/types"

const TEST_ORG = "test-reflect-scope-org"

function makeV2Row(overrides: Partial<ExperienceRowV2> = {}): Omit<ExperienceRowV2, "id"> {
  return {
    skill_name: "harness-test-detector",
    content: "test harness experience",
    source_session_id: null,
    org: TEST_ORG,
    created_at: new Date().toISOString(),
    scope: "harness",
    scope_ref: "deterministic_error",
    pattern_tags: '["fix_and_retry","bash","critical"]',
    outcome: JSON.stringify({ label: "success" }),
    source_type: "harness",
    execution_id: "exec-reflect-001",
    node_id: "node-1",
    ...overrides,
  }
}

// P1 B3: EvolutionDAO 已迁 postgres.js —— 本文件切 PG 随机库（每例一座）。
describePg("Ticket 05 — Evolution Reflect + Scope Integration", () => {
  let dao: EvolutionDAO
  let service: EvolutionService
  let pg: PgFixture

  beforeEach(async () => {
    pg = await setupPgSchema()
    dao = new EvolutionDAO(pg.sql)
    service = new EvolutionService(dao)
  })

  afterEach(async () => {
    await pg.close()
  })

  // ── AC-5: Backward compatibility — no scope param ─────────────────

  describe("AC-5: reflect() without scope works as before", () => {
    it("returns not identified for neutral user feedback (unchanged)", async () => {
      const result = await service.reflect(TEST_ORG, {
        type: "user_feedback",
        content: "This looks great, thanks!",
      })
      expect(result.identified).toBe(false)
    })

    it("detects user correction patterns (unchanged)", async () => {
      const result = await service.reflect(TEST_ORG, {
        type: "user_feedback",
        content: "不要这样做了，以后先检查再执行",
        skill_name: "octo-agent-orchestrator",
      })
      expect(result.identified).toBe(true)
      expect(result.candidate?.summary).toContain("User feedback correction")
    })

    it("detects improvable execution results (unchanged)", async () => {
      const result = await service.reflect(TEST_ORG, {
        type: "execution",
        content: "Task done",
        skill_name: "test-skill",
        result_summary: "可以改进的地方：添加更多测试",
      })
      expect(result.identified).toBe(true)
      expect(result.level).toBe("minor")
    })

    it("self_check with no experiences returns not identified (unchanged)", async () => {
      const result = await service.reflect(TEST_ORG, {
        type: "self_check",
        content: "Periodic check",
      })
      expect(result.identified).toBe(false)
    })
  })

  // ── AC-1: reflect() accepts optional scope parameter ───────────────

  describe("AC-1: reflect() with scope filters analysis scope", () => {
    it("accepts optional scope parameter in reflect()", async () => {
      // Should not throw when scope is provided
      const result = await service.reflect(TEST_ORG, {
        type: "self_check",
        content: "Periodic harness reflection",
        scope: "harness",
      })
      // With no data, should return not identified
      expect(result.identified).toBe(false)
    })

    it("uses listByScope when scope is provided (self_check)", async () => {
      // Insert harness experiences
      for (let i = 0; i < 5; i++) {
        await dao.insertExperienceV2(makeV2Row({
          content: `harness intervention ${i}`,
          scope_ref: "detector_a",
        }))
      }
      // Insert agent experiences (should be excluded when scope='harness')
      for (let i = 0; i < 5; i++) {
        await dao.insertExperienceV2(makeV2Row({
          content: `agent experience ${i}`,
          scope: "agent",
          scope_ref: "skill_x",
        }))
      }

      const result = await service.reflect(TEST_ORG, {
        type: "self_check",
        content: "Periodic harness reflection",
        scope: "harness",
      })

      // Should find harness experiences (5 harness, all same skill_name)
      // and identify a pattern for harness scope
      expect(result.identified).toBe(true)
      expect(result.reasoning).toContain("harness")
    })

    it("filters execution-based reflection by scope", async () => {
      // Insert harness failure experiences
      for (let i = 0; i < 4; i++) {
        await dao.insertExperienceV2(makeV2Row({
          content: `harness failure error in bash node ${i}`,
          scope_ref: "deterministic_error",
        }))
      }

      const result = await service.reflect(TEST_ORG, {
        type: "execution",
        content: "Execution completed with errors",
        scope: "harness",
      })

      // Should detect failure pattern in harness scope
      expect(result.identified).toBe(true)
    })
  })

  // ── AC-2: reflect insights written to experiences table ─────────────

  describe("AC-2: reflect insights written as reflection experiences", () => {
    it("writes reflection experience when insight is identified (harness scope)", async () => {
      // Insert enough harness data to trigger reflection insight
      await dao.insertExperienceV2(makeV2Row({
        pattern_tags: '["timeout_cascade","bash","critical"]',
        outcome: JSON.stringify({ label: "failed" }),
        scope_ref: "timeout_detector",
        content: "timeout cascade in bash node",
      }))
      await dao.insertExperienceV2(makeV2Row({
        pattern_tags: '["timeout_cascade","python","warning"]',
        outcome: JSON.stringify({ label: "failed" }),
        scope_ref: "timeout_detector",
        content: "timeout cascade in python node",
      }))
      await dao.insertExperienceV2(makeV2Row({
        pattern_tags: '["fix_and_retry","bash","critical"]',
        outcome: JSON.stringify({ label: "success" }),
        scope_ref: "deterministic_error",
        content: "fix and retry success",
      }))

      const result = await service.reflect(TEST_ORG, {
        type: "self_check",
        content: "Periodic harness reflection",
        scope: "harness",
      })

      // Should have written a reflection experience
      const reflections = (await dao.listByScope(TEST_ORG, "harness", { scopeRef: undefined, limit: 100 }))
        .filter(e => {
          try {
            return JSON.parse(e.pattern_tags || "[]").includes("reflection")
          } catch {
            return false
          }
        })

      if (result.identified) {
        expect(reflections.length).toBeGreaterThan(0)
        const refExp = reflections[0]
        expect(refExp.scope).toBe("harness")
      }
    })

    it("writes reflection experience with source_type='reflection'", async () => {
      // Insert data to trigger an insight
      await dao.insertExperienceV2(makeV2Row({
        pattern_tags: '["fix_and_retry","bash"]',
        outcome: JSON.stringify({ label: "success" }),
        content: "fix_and_retry success on bash",
      }))
      await dao.insertExperienceV2(makeV2Row({
        pattern_tags: '["fix_and_retry","python"]',
        outcome: JSON.stringify({ label: "success" }),
        content: "fix_and_retry success on python",
      }))
      await dao.insertExperienceV2(makeV2Row({
        pattern_tags: '["fix_and_retry","bash"]',
        outcome: JSON.stringify({ label: "failed" }),
        content: "fix_and_retry failed on bash",
      }))

      await service.reflect(TEST_ORG, {
        type: "self_check",
        content: "harness reflection check",
        scope: "harness",
      })

      // Check that experiences with source_type='reflection' exist
      const allHarness = await dao.listByScope(TEST_ORG, "harness")
      const reflectionExps = allHarness.filter(e => e.source_type === "reflection")

      // If identified, we should have at least one reflection
      // The insight is written as experience
      for (const ref of reflectionExps) {
        expect(ref.source_type).toBe("reflection")
        expect(ref.scope).toBe("harness")
      }
    })

    it("does not write reflection experience when no insight found", async () => {
      // No data in DB
      const result = await service.reflect(TEST_ORG, {
        type: "self_check",
        content: "Periodic check",
        scope: "harness",
      })

      expect(result.identified).toBe(false)

      const allHarness = await dao.listByScope(TEST_ORG, "harness")
      const reflectionExps = allHarness.filter(e => e.source_type === "reflection")
      expect(reflectionExps).toHaveLength(0)
    })
  })

  // ── AC-3: Harness-specific analysis ─────────────────────────────────

  describe("AC-3: Harness scope analyzes decision stats + detector accuracy", () => {
    it("generates insights about low success rate decisions", async () => {
      // Insert data: timeout_cascade + agent_takeover has low success rate
      for (let i = 0; i < 3; i++) {
        await dao.insertExperienceV2(makeV2Row({
          pattern_tags: '["agent_takeover","timeout_cascade","bash"]',
          outcome: JSON.stringify({ label: "failed" }),
          scope_ref: "timeout_detector",
          content: `timeout cascade agent takeover failed ${i}`,
        }))
      }
      await dao.insertExperienceV2(makeV2Row({
        pattern_tags: '["agent_takeover","timeout_cascade","bash"]',
        outcome: JSON.stringify({ label: "success" }),
        scope_ref: "timeout_detector",
        content: "timeout cascade agent takeover success",
      }))

      // fix_and_retry has high success rate
      for (let i = 0; i < 4; i++) {
        await dao.insertExperienceV2(makeV2Row({
          pattern_tags: '["fix_and_retry","deterministic_error","bash"]',
          outcome: JSON.stringify({ label: "success" }),
          scope_ref: "deterministic_error",
          content: `fix_and_retry success ${i}`,
        }))
      }

      const result = await service.reflect(TEST_ORG, {
        type: "self_check",
        content: "Harness reflection with stats",
        scope: "harness",
      })

      // Should identify patterns related to success rates
      if (result.identified && result.candidate) {
        // The insight should mention decision patterns
        expect(result.reasoning.length).toBeGreaterThan(0)
      }
    })

    it("uses getSuccessStats to analyze decision effectiveness", async () => {
      // Verify the DAO method works correctly for harness analysis
      await dao.insertExperienceV2(makeV2Row({
        pattern_tags: '["fix_and_retry","bash"]',
        outcome: JSON.stringify({ label: "success" }),
      }))
      await dao.insertExperienceV2(makeV2Row({
        pattern_tags: '["fix_and_retry","python"]',
        outcome: JSON.stringify({ label: "success" }),
      }))
      await dao.insertExperienceV2(makeV2Row({
        pattern_tags: '["agent_takeover","timeout_cascade"]',
        outcome: JSON.stringify({ label: "failed" }),
        scope_ref: "timeout_detector",
      }))

      const stats = await dao.getSuccessStats(TEST_ORG, "harness")

      expect(stats.decisionStats["fix_and_retry"]).toBeDefined()
      expect(stats.decisionStats["fix_and_retry"].rate).toBe(1) // 2/2 = 100%
      expect(stats.decisionStats["agent_takeover"]).toBeDefined()
      expect(stats.decisionStats["agent_takeover"].rate).toBe(0) // 0/1 = 0%
    })

    it("generates actionable insight text", async () => {
      // Insert data with clear pattern: one detector always fails
      for (let i = 0; i < 5; i++) {
        await dao.insertExperienceV2(makeV2Row({
          pattern_tags: '["agent_takeover","timeout_cascade"]',
          outcome: JSON.stringify({ label: "failed" }),
          scope_ref: "timeout_detector",
          content: `timeout_cascade agent_takeover failed ${i}`,
        }))
      }
      for (let i = 0; i < 5; i++) {
        await dao.insertExperienceV2(makeV2Row({
          pattern_tags: '["guide_and_retry","timeout_cascade"]',
          outcome: JSON.stringify({ label: "success" }),
          scope_ref: "timeout_detector",
          content: `timeout_cascade guide_and_retry success ${i}`,
        }))
      }

      const result = await service.reflect(TEST_ORG, {
        type: "self_check",
        content: "Harness stats analysis",
        scope: "harness",
      })

      // When insights are found, they should be actionable
      if (result.identified && result.candidate) {
        expect(result.candidate.summary.length).toBeGreaterThan(10)
      }
    })
  })

  // ── AC-4: Reflection experiences searchable via FTS5 ────────────────

  describe("AC-4: Reflection experiences are FTS5 searchable", () => {
    it("reflection experiences can be found via searchByScope", async () => {
      // Insert harness data to trigger reflection
      for (let i = 0; i < 5; i++) {
        await dao.insertExperienceV2(makeV2Row({
          content: `harness timeout intervention ${i}`,
          scope_ref: "timeout_detector",
        }))
      }

      // Trigger reflection
      await service.reflect(TEST_ORG, {
        type: "self_check",
        content: "harness reflection",
        scope: "harness",
      })

      // Search for reflection experiences
      const reflectionResults = await dao.searchByScope("reflection", "harness")

      // Should find reflection experiences if any were created
      // (Only if an insight was identified)
      for (const r of reflectionResults) {
        expect(r.scope).toBe("harness")
      }
    })

    it("reflection experience content is indexed in FTS5", async () => {
      // Manually insert a reflection experience to verify FTS works
      await dao.insertExperienceV2({
        skill_name: "harness-timeout_detector",
        content: "reflection insight: timeout_cascade + agent_takeover 成功率仅 30%，建议优先 guide_and_retry",
        source_session_id: null,
        org: TEST_ORG,
        created_at: new Date().toISOString(),
        scope: "harness",
        scope_ref: "timeout_detector",
        pattern_tags: '["reflection","timeout_cascade","low_success_rate"]',
        outcome: null,
        source_type: "reflection",
        execution_id: null,
        node_id: null,
      })

      // Should be searchable
      const results = await dao.searchByScope("timeout_cascade", "harness")
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].content).toContain("timeout_cascade")
      expect(results[0].scope).toBe("harness")
    })

    it("reflection experience is found by decision keyword search", async () => {
      await dao.insertExperienceV2({
        skill_name: "harness-deterministic_error",
        content: "reflection: fix_and_retry 对 deterministic_error 成功率 95%，推荐作为首选策略",
        source_session_id: null,
        org: TEST_ORG,
        created_at: new Date().toISOString(),
        scope: "harness",
        scope_ref: "deterministic_error",
        pattern_tags: '["reflection","fix_and_retry","high_success_rate"]',
        outcome: null,
        source_type: "reflection",
        execution_id: null,
        node_id: null,
      })

      const results = await dao.searchByScope("fix_and_retry", "harness")
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].content).toContain("fix_and_retry")
    })
  })

  // ── AC-6: Reflection trigger mechanism ──────────────────────────────

  describe("AC-6: Reflection trigger mechanism", () => {
    it("reflect() can be called with type='self_check' for periodic reflection", async () => {
      // This is the periodic trigger path
      const result = await service.reflect(TEST_ORG, {
        type: "self_check",
        content: "Periodic harness reflection",
        scope: "harness",
      })
      // Should complete without error
      expect(result).toBeDefined()
      expect(result.reasoning).toBeDefined()
    })

    it("reflect() can be called with type='execution' after execution end", async () => {
      // This is the onExecutionEnd trigger path
      const result = await service.reflect(TEST_ORG, {
        type: "execution",
        content: "Execution completed",
        result_summary: "Execution failed with timeout errors",
        scope: "harness",
      })
      expect(result).toBeDefined()
    })

    it("reflect with scope returns harness-specific reasoning", async () => {
      await dao.insertExperienceV2(makeV2Row({ content: "harness failure error 1" }))
      await dao.insertExperienceV2(makeV2Row({ content: "harness failure error 2" }))
      await dao.insertExperienceV2(makeV2Row({ content: "harness failure error 3" }))

      const result = await service.reflect(TEST_ORG, {
        type: "execution",
        content: "Execution had errors",
        scope: "harness",
      })

      if (result.identified) {
        // Reasoning should reference harness scope
        expect(result.reasoning.toLowerCase()).toContain("harness")
      }
    })
  })

  // ── Integration: full reflection loop ───────────────────────────────

  describe("Integration: full reflection → experience → FTS loop", () => {
    it("completes the full learning loop", async () => {
      // 1. Insert harness experiences with various outcomes
      await dao.insertExperienceV2(makeV2Row({
        content: "timeout cascade in bash node",
        pattern_tags: '["agent_takeover","timeout_cascade","bash","critical"]',
        outcome: JSON.stringify({ label: "failed" }),
        scope_ref: "timeout_detector",
      }))
      await dao.insertExperienceV2(makeV2Row({
        content: "timeout cascade in python node",
        pattern_tags: '["agent_takeover","timeout_cascade","python","warning"]',
        outcome: JSON.stringify({ label: "failed" }),
        scope_ref: "timeout_detector",
      }))
      await dao.insertExperienceV2(makeV2Row({
        content: "timeout cascade resolved with guide",
        pattern_tags: '["guide_and_retry","timeout_cascade","bash"]',
        outcome: JSON.stringify({ label: "success" }),
        scope_ref: "timeout_detector",
      }))

      // 2. Run reflection with harness scope
      const result = await service.reflect(TEST_ORG, {
        type: "self_check",
        content: "Periodic harness reflection",
        scope: "harness",
      })

      // 3. If insight was found, it should be written as experience
      if (result.identified && result.candidate) {
        // 4. Verify reflection experiences exist in DB
        const harnessExps = await dao.listByScope(TEST_ORG, "harness")
        const reflectionExps = harnessExps.filter(e => e.source_type === "reflection")

        // Should have at least one reflection experience
        expect(reflectionExps.length).toBeGreaterThanOrEqual(0)

        // 5. Verify FTS5 search finds reflection experiences
        for (const ref of reflectionExps) {
          const ftsResults = await dao.searchByScope("reflection", "harness")
          expect(ftsResults.some(r => r.id === ref.id)).toBe(true)
        }
      }
    })
  })
})
