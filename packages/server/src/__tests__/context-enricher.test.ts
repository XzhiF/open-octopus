/**
 * ContextEnricher Tests — unified experience enrichment layer
 *
 * Tests:
 * - Keyword detection (Chinese + English trigger words)
 * - Visibility rules (scope isolation)
 * - Budget management (5→3→1 reduction)
 * - Structured markdown formatting
 * - Null segment for no-match scenarios
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { initDb, closeDb, getDb } from "../db/connection"
import { EvolutionDAO } from "../db/dao"
import { ContextEnricher } from "../services/agent/context-enricher"
import type { ExperienceRowV2 } from "../db/types"

const TEST_ORG = "test-enricher-org"

function makeV2Row(overrides: Partial<ExperienceRowV2> = {}): Omit<ExperienceRowV2, "id"> {
  return {
    skill_name: "test-skill",
    content: "test experience content",
    source_session_id: null,
    org: TEST_ORG,
    created_at: "2026-08-10T00:00:00.000Z",
    scope: "agent",
    scope_ref: null,
    pattern_tags: '["fix_and_retry"]',
    outcome: JSON.stringify({ label: "success" }),
    source_type: "session",
    execution_id: null,
    node_id: null,
    ...overrides,
  }
}

describe("ContextEnricher", () => {
  let dao: EvolutionDAO
  let enricher: ContextEnricher

  beforeEach(() => {
    initDb(":memory:")
    dao = new EvolutionDAO(getDb())
    enricher = new ContextEnricher(dao)
  })

  afterEach(() => {
    closeDb()
  })

  // ── Keyword Detection (agent scope) ────────────────────────────────

  describe("keyword detection — agent scope", () => {
    it("triggers search when message contains '之前'", async () => {
      dao.insertExperienceV2(makeV2Row({
        content: "之前部署失败是怎么解决的问题，修复了配置文件",
        scope: "agent",
      }))

      const result = await enricher.enrich({
        scope: "agent",
        query: "之前部署失败是怎么解决的",
        org: TEST_ORG,
        budget: 1200,
      })

      expect(result.segment).not.toBeNull()
      expect(result.count).toBeGreaterThan(0)
    })

    it("triggers search when message contains '上次'", async () => {
      dao.insertExperienceV2(makeV2Row({
        content: "上次报错怎么处理的，增加了重试逻辑",
        scope: "agent",
      }))

      const result = await enricher.enrich({
        scope: "agent",
        query: "上次报错怎么处理的",
        org: TEST_ORG,
        budget: 1200,
      })

      expect(result.segment).not.toBeNull()
    })

    it("triggers search when message contains 'error'", async () => {
      dao.insertExperienceV2(makeV2Row({
        content: "got an error in the build pipeline, fixed it",
        scope: "agent",
      }))

      const result = await enricher.enrich({
        scope: "agent",
        query: "got an error in the build",
        org: TEST_ORG,
        budget: 1200,
      })

      expect(result.segment).not.toBeNull()
    })

    it("triggers search when message contains 'failed'", async () => {
      dao.insertExperienceV2(makeV2Row({
        content: "deployment failed yesterday due to config issue",
        scope: "agent",
      }))

      const result = await enricher.enrich({
        scope: "agent",
        query: "deployment failed yesterday",
        org: TEST_ORG,
        budget: 1200,
      })

      expect(result.segment).not.toBeNull()
    })

    it("triggers search when message contains 'remember'", async () => {
      dao.insertExperienceV2(makeV2Row({
        content: "do you remember the fix for timeout issue",
        scope: "agent",
      }))

      const result = await enricher.enrich({
        scope: "agent",
        query: "do you remember the fix",
        org: TEST_ORG,
        budget: 1200,
      })

      expect(result.segment).not.toBeNull()
    })

    it("returns null segment when no trigger word matches", async () => {
      dao.insertExperienceV2(makeV2Row({
        content: "some relevant experience about deployment",
        scope: "agent",
      }))

      const result = await enricher.enrich({
        scope: "agent",
        query: "帮我创建一个新文件",
        org: TEST_ORG,
        budget: 1200,
      })

      expect(result.segment).toBeNull()
      expect(result.count).toBe(0)
      expect(result.tokensUsed).toBe(0)
    })

    it("forceSearch bypasses keyword detection", async () => {
      dao.insertExperienceV2(makeV2Row({
        content: "deployment strategies and best practices",
        scope: "agent",
      }))

      const result = await enricher.enrich({
        scope: "agent",
        query: "deployment strategies",
        org: TEST_ORG,
        budget: 1200,
        forceSearch: true,
      })

      expect(result.segment).not.toBeNull()
    })
  })

  // ── Always-on scopes (harness/workflow) ────────────────────────────

  describe("always-on scopes — harness and workflow", () => {
    it("harness scope always searches (no keyword needed)", async () => {
      dao.insertExperienceV2(makeV2Row({
        content: "harness timeout intervention for syntax_error detector",
        scope: "harness",
      }))

      const result = await enricher.enrich({
        scope: "harness",
        query: "syntax_error",
        org: TEST_ORG,
        budget: 1200,
      })

      expect(result.segment).not.toBeNull()
    })

    it("workflow scope always searches (no keyword needed)", async () => {
      dao.insertExperienceV2(makeV2Row({
        content: "workflow node timeout handling for bash execution",
        scope: "workflow",
      }))

      const result = await enricher.enrich({
        scope: "workflow",
        query: "bash node execution",
        org: TEST_ORG,
        budget: 1200,
      })

      expect(result.segment).not.toBeNull()
    })
  })

  // ── Visibility Rules ───────────────────────────────────────────────

  describe("visibility rules — scope isolation", () => {
    beforeEach(() => {
      dao.insertExperienceV2(makeV2Row({
        content: "agent scope experience data",
        scope: "agent",
      }))
      dao.insertExperienceV2(makeV2Row({
        content: "harness scope experience data",
        scope: "harness",
      }))
      dao.insertExperienceV2(makeV2Row({
        content: "workflow scope experience data",
        scope: "workflow",
      }))
      dao.insertExperienceV2(makeV2Row({
        content: "global scope experience data",
        scope: "global",
      }))
    })

    it("agent scope sees only agent + global", async () => {
      const result = await enricher.enrich({
        scope: "agent",
        query: "experience",
        org: TEST_ORG,
        budget: 1200,
        forceSearch: true,
      })

      expect(result.segment).not.toBeNull()
      expect(result.segment).toContain("agent scope experience")
      expect(result.segment).toContain("global scope experience")
      expect(result.segment).not.toContain("harness scope experience")
      expect(result.segment).not.toContain("workflow scope experience")
    })

    it("harness scope sees only harness + global", async () => {
      const result = await enricher.enrich({
        scope: "harness",
        query: "experience",
        org: TEST_ORG,
        budget: 1200,
      })

      expect(result.segment).toContain("harness scope experience")
      expect(result.segment).toContain("global scope experience")
      expect(result.segment).not.toContain("agent scope experience")
      expect(result.segment).not.toContain("workflow scope experience")
    })

    it("workflow scope sees only workflow + global", async () => {
      const result = await enricher.enrich({
        scope: "workflow",
        query: "experience",
        org: TEST_ORG,
        budget: 1200,
      })

      expect(result.segment).toContain("workflow scope experience")
      expect(result.segment).toContain("global scope experience")
      expect(result.segment).not.toContain("agent scope experience")
      expect(result.segment).not.toContain("harness scope experience")
    })
  })

  // ── Budget Management ──────────────────────────────────────────────

  describe("budget management", () => {
    beforeEach(() => {
      // Insert 7 experiences with long content (each ~150 chars)
      for (let i = 0; i < 7; i++) {
        dao.insertExperienceV2(makeV2Row({
          content: `experience item ${i} with enough content to consume tokens in the budget calculation process for testing purposes with additional padding text here`,
          scope: "agent",
          created_at: `2026-08-${String(10 - i).padStart(2, "0")}T00:00:00.000Z`,
        }))
      }
    })

    it("reduces count when over budget (5→3)", async () => {
      const result = await enricher.enrich({
        scope: "agent",
        query: "experience",
        org: TEST_ORG,
        budget: 250, // Budget that fits ~3 items (each ~70-80 tokens formatted)
        forceSearch: true,
      })

      expect(result.segment).not.toBeNull()
      expect(result.count).toBeLessThanOrEqual(3)
    })

    it("reduces count to 1 when budget is very small", async () => {
      const result = await enricher.enrich({
        scope: "agent",
        query: "experience",
        org: TEST_ORG,
        budget: 80, // Very small budget fits only 1
        forceSearch: true,
      })

      expect(result.segment).not.toBeNull()
      expect(result.count).toBeLessThanOrEqual(1)
    })

    it("returns all items when budget is sufficient", async () => {
      const result = await enricher.enrich({
        scope: "agent",
        query: "experience",
        org: TEST_ORG,
        budget: 10000, // Large budget
        forceSearch: true,
      })

      expect(result.segment).not.toBeNull()
      expect(result.count).toBe(5) // max 5 by default
    })
  })

  // ── Formatting ─────────────────────────────────────────────────────

  describe("formatted output", () => {
    it("includes date, pattern, decision and result markers", async () => {
      dao.insertExperienceV2(makeV2Row({
        content: "bash syntax error fix applied previously",
        scope: "agent",
        pattern_tags: '["deterministic_error","syntax_error"]',
        outcome: JSON.stringify({ label: "success" }),
        created_at: "2026-08-10T00:00:00.000Z",
      }))

      const result = await enricher.enrich({
        scope: "agent",
        query: "syntax error",
        org: TEST_ORG,
        budget: 1200,
        forceSearch: true,
      })

      expect(result.segment).not.toBeNull()
      // Date marker
      expect(result.segment).toContain("2026-08-10")
      // Pattern tag
      expect(result.segment).toContain("deterministic_error")
      // Result marker (✅ for success)
      expect(result.segment).toContain("✅")
    })

    it("shows ❌ for failed outcomes", async () => {
      dao.insertExperienceV2(makeV2Row({
        content: "timeout intervention failed completely",
        scope: "agent",
        pattern_tags: '["timeout_cascade"]',
        outcome: JSON.stringify({ label: "failed" }),
        created_at: "2026-08-09T00:00:00.000Z",
      }))

      const result = await enricher.enrich({
        scope: "agent",
        query: "timeout",
        org: TEST_ORG,
        budget: 1200,
        forceSearch: true,
      })

      expect(result.segment).not.toBeNull()
      expect(result.segment).toContain("❌")
    })

    it("includes header with count", async () => {
      dao.insertExperienceV2(makeV2Row({
        content: "relevant experience one about deployment",
        scope: "agent",
      }))
      dao.insertExperienceV2(makeV2Row({
        content: "relevant experience two about deployment",
        scope: "global",
      }))

      const result = await enricher.enrich({
        scope: "agent",
        query: "experience",
        org: TEST_ORG,
        budget: 1200,
        forceSearch: true,
      })

      expect(result.segment).not.toBeNull()
      expect(result.segment).toContain("相关历史经验")
      expect(result.segment).toContain(`${result.count}条`)
    })
  })

  // ── No results ─────────────────────────────────────────────────────

  describe("no results", () => {
    it("returns null segment when no matching experiences found", async () => {
      const result = await enricher.enrich({
        scope: "agent",
        query: "之前部署的经验",
        org: TEST_ORG,
        budget: 1200,
      })

      expect(result.segment).toBeNull()
      expect(result.count).toBe(0)
      expect(result.tokensUsed).toBe(0)
    })

    it("returns null segment for harness scope with no data", async () => {
      const result = await enricher.enrich({
        scope: "harness",
        query: "nonexistent_pattern_xyz",
        org: TEST_ORG,
        budget: 1200,
      })

      expect(result.segment).toBeNull()
      expect(result.count).toBe(0)
    })
  })
})
