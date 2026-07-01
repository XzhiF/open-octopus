import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../../../db/schema"
import { KnowledgeRuleDAO } from "../../../db/dao/knowledge-rule-dao"
import { KnowledgeEffectivenessDAO } from "../../../db/dao/knowledge-effectiveness-dao"
import { PendingReviewDAO } from "../../../db/dao/pending-review-dao"
import { appendToKnowledgeFile, generateRuleId } from "../file-ops"
import { precomputeRelevantRules } from "../precompute"
import { trackEffectiveness, applyEffectivenessUpdates, computeEffectivenessUpdates } from "../effectiveness"
import { KnowledgeInjector } from "@octopus/engine"
import { VarPool } from "@octopus/shared"

/**
 * TC-039: End-to-end knowledge loop integration test.
 * Verifies the 7-step pipeline: archive → extract → review → write → inject → execute → track.
 */
describe("US-28: knowledge loop integration", () => {
  let db: Database.Database
  let ruleDAO: KnowledgeRuleDAO
  let effectivenessDAO: KnowledgeEffectivenessDAO
  let pendingReviewDAO: PendingReviewDAO
  let tmpDir: string

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    ruleDAO = new KnowledgeRuleDAO(db)
    effectivenessDAO = new KnowledgeEffectivenessDAO(db)
    pendingReviewDAO = new PendingReviewDAO(db)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-loop-"))
    process.env.OCTOPUS_KNOWLEDGE_DIR = tmpDir
  })

  afterEach(() => {
    db?.close()
    delete process.env.OCTOPUS_KNOWLEDGE_DIR
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("runs the full 7-step loop", async () => {
    // Step 1: Archive — execution completed (simulated by having an exec result)
    const execResult = {
      id: "exec-001",
      status: "completed",
      nodes: {
        "node-1": { status: "completed", exitCode: 0, lastOutput: "Build succeeded" },
      },
      poolSnapshot: {},
    }

    // Step 2: Extract — simulate rule extraction (LLM would do this, we mock the output)
    const proposedRule = {
      id: generateRuleId("test"),
      text: "Always run tests before merging",
      source: "manual" as const,
      scope: "project" as const,
      target_file: "octopus.md",
    }

    // Step 3: Review — rule enters pending review queue
    pendingReviewDAO.insert({
      id: proposedRule.id,
      type: "rule",
      source: proposedRule.source,
      source_ref: "exec-001",
      source_label: "Manual test rule",
      content: proposedRule.text,
      target_file: proposedRule.target_file,
      scope: proposedRule.scope,
      conflicts: null,
      confidence: 1.0,
      auto_approve: 0,
      status: "pending",
      user_notes: null,
    })

    const pending = pendingReviewDAO.listBySource("manual")
    expect(pending).toHaveLength(1)
    expect(pending[0].content).toBe("Always run tests before merging")

    // Step 4: Write — approve rule, write to knowledge file + DB
    const ruleId = generateRuleId("test")
    ruleDAO.insert({
      rule_id: ruleId,
      file_name: "octopus.md",
      text: proposedRule.text,
      scope: "project",
      source: "manual",
      status: "active",
    })

    const knowledgeFile = path.join(tmpDir, "octopus.md")
    fs.writeFileSync(knowledgeFile, "", "utf-8")
    appendToKnowledgeFile(knowledgeFile, proposedRule.text, ruleId, "manual")

    const content = fs.readFileSync(knowledgeFile, "utf-8")
    expect(content).toContain("Always run tests before merging")
    expect(content).toContain(ruleId)

    // Update pending status to approved
    pendingReviewDAO.updateStatus(proposedRule.id, "approved")
    const approved = pendingReviewDAO.getById(proposedRule.id)
    expect(approved?.status).toBe("approved")

    // Step 5: Inject — precompute + inject rules into agent prompt
    const pool = new VarPool({})
    await precomputeRelevantRules("test-org", "octopus", "test-workflow", {}, ruleDAO, pool)

    const cacheRaw = pool.get("__knowledge_rule_cache") as string
    expect(cacheRaw).toBeDefined()
    const cache = JSON.parse(cacheRaw)
    expect(cache[ruleId]).toBe(proposedRule.text)

    const injector = new KnowledgeInjector(pool)
    const injected = injector.getInjectedPrompts("test-workflow", "node-1")
    expect(injected.some(p => p.includes("Always run tests before merging"))).toBe(true)

    // Step 6: Execute — simulated workflow execution with injected rules
    const injectIdsRaw = pool.get("__injected_rule_ids") as string
    const injectedIds = JSON.parse(injectIdsRaw) as string[]
    expect(injectedIds).toContain(ruleId)

    // Step 7: Track — measure effectiveness of injected rules
    const postExecResult = {
      id: "exec-002",
      status: "completed",
      nodes: {
        "node-1": { status: "completed", exitCode: 0, lastOutput: "All tests passed" },
      },
      poolSnapshot: {
        __injected_rule_ids: JSON.stringify([ruleId]),
      },
    }

    const tracked = trackEffectiveness(postExecResult, effectivenessDAO, ruleDAO)
    expect(tracked).toBe(1)

    const effectiveness = effectivenessDAO.getByRuleId(ruleId)
    expect(effectiveness).toBeDefined()
    expect(effectiveness?.injected_count).toBe(1)
  })

  it("handles the loop cycling — rules from one execution improve the next", async () => {
    // First cycle: add a rule
    const ruleId = generateRuleId("cycle")
    ruleDAO.insert({
      rule_id: ruleId,
      file_name: "octopus.md",
      text: "Use prepared statements for SQL queries",
      scope: "project",
      source: "manual",
      status: "active",
    })

    // Second cycle: rule is available for injection
    const pool = new VarPool({})
    await precomputeRelevantRules("test-org", "octopus", "test-workflow", {}, ruleDAO, pool)

    const injector = new KnowledgeInjector(pool)
    const prompts = injector.getInjectedPrompts("test-workflow", "node-1")
    expect(prompts.some(p => p.includes("Use prepared statements for SQL queries"))).toBe(true)

    // Track: rule helps (no SQL errors)
    const updates = computeEffectivenessUpdates(
      [ruleId],
      "Build succeeded",
      new Map([[ruleId, "Use prepared statements for SQL queries"]]),
    )
    expect(updates[0].helpful).toBe(true)
    applyEffectivenessUpdates(effectivenessDAO, updates)

    const row = effectivenessDAO.getByRuleId(ruleId)
    expect(row?.helpful_count).toBe(1)
    expect(row?.confidence).toBe(1)
  })
})
