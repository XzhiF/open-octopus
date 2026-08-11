/**
 * Experience Precompute Tests — VarPool bridge for workflow agent nodes
 *
 * Verifies that the server-side precompute hook:
 * - Calls ContextEnricher with scope='workflow', forceSearch=true
 * - Writes result to VarPool under `__experience_segment` key
 * - Handles the case where no experiences are found (key absent or null)
 * - Does not break existing knowledge precompute
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { initDb, closeDb, getDb } from "../db/connection"
import { EvolutionDAO } from "../db/dao"
import { VarPool } from "@octopus/shared"
import type { ExperienceRowV2 } from "../db/types"
import { precomputeExperience } from "../services/agent/experience-precompute"

const TEST_ORG = "test-exp-precompute-org"

function makeV2Row(overrides: Partial<ExperienceRowV2> = {}): Omit<ExperienceRowV2, "id"> {
  return {
    skill_name: "test-skill",
    content: "test experience content",
    source_session_id: null,
    org: TEST_ORG,
    created_at: "2026-08-10T00:00:00.000Z",
    scope: "workflow",
    scope_ref: null,
    pattern_tags: '["deploy_fix"]',
    outcome: JSON.stringify({ label: "success" }),
    source_type: "session",
    execution_id: null,
    node_id: null,
    ...overrides,
  }
}

describe("experience-precompute", () => {
  let dao: EvolutionDAO

  beforeEach(() => {
    initDb(":memory:")
    dao = new EvolutionDAO(getDb())
  })

  afterEach(() => {
    closeDb()
  })

  it("writes __experience_segment to VarPool when matching experiences exist (AC-1, AC-2)", () => {
    // Content must contain the workflow name so LIKE search can match
    dao.insertExperienceV2(makeV2Row({
      content: "deploy-pipeline 部署失败后回滚版本解决了问题",
      scope: "workflow",
    }))

    const pool = new VarPool({})
    precomputeExperience(TEST_ORG, "deploy-pipeline", dao, pool)

    const segment = pool.get("__experience_segment") as string | undefined
    expect(segment).toBeDefined()
    expect(segment).toContain("部署失败")
  })

  it("does not write __experience_segment when no experiences match (AC-5)", () => {
    const pool = new VarPool({})
    precomputeExperience(TEST_ORG, "some-unique-workflow-xyz", dao, pool)

    const segment = pool.get("__experience_segment")
    expect(segment).toBeUndefined()
  })

  it("does not write experiences from other orgs (scope isolation)", () => {
    dao.insertExperienceV2(makeV2Row({
      content: "Another org experience",
      org: "different-org",
      scope: "workflow",
    }))

    const pool = new VarPool({})
    precomputeExperience(TEST_ORG, "deploy-pipeline", dao, pool)

    const segment = pool.get("__experience_segment")
    expect(segment).toBeUndefined()
  })

  it("uses forceSearch=true (always-on for workflow scope) (AC-1)", () => {
    // Even a non-keyword-matching query should find results because forceSearch=true
    // Content must contain the workflow name so LIKE search can match
    dao.insertExperienceV2(makeV2Row({
      content: "build-task 配置错误导致构建失败，修复了环境变量",
      scope: "workflow",
    }))

    const pool = new VarPool({})
    // Query has no trigger keywords — but forceSearch should bypass keyword detection
    precomputeExperience(TEST_ORG, "build-task", dao, pool)

    const segment = pool.get("__experience_segment") as string | undefined
    expect(segment).toBeDefined()
    expect(segment).toContain("配置错误")
  })

  it("does not affect existing knowledge VarPool keys (AC-6)", () => {
    const pool = new VarPool({})
    // Simulate existing knowledge keys
    pool.set("__knowledge_rule_cache", JSON.stringify({ "rule-1": "test rule" }))
    pool.set("__relevant_rule_ids", JSON.stringify(["rule-1"]))

    precomputeExperience(TEST_ORG, "test-workflow", dao, pool)

    // Existing keys should be untouched
    expect(pool.get("__knowledge_rule_cache")).toBe(JSON.stringify({ "rule-1": "test rule" }))
    expect(pool.get("__relevant_rule_ids")).toBe(JSON.stringify(["rule-1"]))
  })
})
