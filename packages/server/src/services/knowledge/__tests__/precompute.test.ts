import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import Database from "better-sqlite3"
import { KnowledgeRuleDAO } from "../../../db/dao/knowledge-rule-dao"
import { applySchema } from "../../../db/schema"
import { precomputeRelevantRules } from "../precompute"
import { VarPool } from "@octopus/shared"
import { writeKnowledgeFile } from "../file-ops"

describe("precompute", () => {
  let db: Database.Database
  let ruleDAO: KnowledgeRuleDAO
  let tmpDir: string

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    ruleDAO = new KnowledgeRuleDAO(db)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "precompute-test-"))
  })

  afterEach(() => {
    db?.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.OCTOPUS_KNOWLEDGE_DIR
  })

  it("sets __user_preference_text from effective user preference", async () => {
    process.env.OCTOPUS_KNOWLEDGE_DIR = tmpDir
    writeKnowledgeFile(path.join(tmpDir, "user_preference.md"), "# Test Pref\n- Prefer tests")

    const pool = new VarPool({})
    await precomputeRelevantRules("test-org", undefined, "test-workflow", {}, ruleDAO, pool)

    const prefText = pool.get("__user_preference_text") as string
    expect(prefText).toContain("Prefer tests")
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
    await precomputeRelevantRules("test-org", undefined, "test-workflow", {}, ruleDAO, pool)

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
    await precomputeRelevantRules("test-org", undefined, "test-workflow", {}, ruleDAO, pool)

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
    await precomputeRelevantRules("test-org", undefined, "test-workflow", {}, ruleDAO, pool)

    const idsRaw = pool.get("__relevant_rule_ids") as string
    const ids = JSON.parse(idsRaw)
    expect(ids).toContain("active-rule")
    expect(ids).not.toContain("retired-rule")
  })

  it("writes __knowledge_scope_filter with repoName and workflowName", async () => {
    const pool = new VarPool({})
    await precomputeRelevantRules("test-org", "octopus", "build", {}, ruleDAO, pool)

    const raw = pool.get("__knowledge_scope_filter") as string
    const filter = JSON.parse(raw)
    expect(filter.repoName).toBe("octopus")
    expect(filter.workflowName).toBe("build")
  })

  it("writes __knowledge_scope_filter with undefined repoName when not provided", async () => {
    const pool = new VarPool({})
    await precomputeRelevantRules("test-org", undefined, "build", {}, ruleDAO, pool)

    const raw = pool.get("__knowledge_scope_filter") as string
    const filter = JSON.parse(raw)
    expect(filter.repoName).toBeUndefined()
    expect(filter.workflowName).toBe("build")
  })

  it("writes __knowledge_rule_meta for each active rule", async () => {
    ruleDAO.insert({
      rule_id: "rule-1",
      file_name: "projects/octopus.md",
      text: "Project rule",
      scope: "project",
      source: "system",
      status: "active",
    })
    ruleDAO.insert({
      rule_id: "rule-2",
      file_name: "workflows/build.md",
      text: "Workflow rule",
      scope: "workflow",
      source: "system",
      status: "active",
    })

    const pool = new VarPool({})
    await precomputeRelevantRules("test-org", "octopus", "build", {}, ruleDAO, pool)

    const raw = pool.get("__knowledge_rule_meta") as string
    const meta = JSON.parse(raw)
    expect(meta["rule-1"]).toEqual({ fileName: "projects/octopus.md", scope: "project" })
    expect(meta["rule-2"]).toEqual({ fileName: "workflows/build.md", scope: "workflow" })
  })
})
