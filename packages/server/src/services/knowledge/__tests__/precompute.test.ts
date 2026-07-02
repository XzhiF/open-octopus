import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import { precomputeRelevantRules } from "../precompute"
import { VarPool } from "@octopus/shared"
import { writeKnowledgeFile, appendToKnowledgeFile } from "../file-ops"

describe("precompute", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "precompute-test-"))
    process.env.OCTOPUS_KNOWLEDGE_DIR = tmpDir
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.OCTOPUS_KNOWLEDGE_DIR
  })

  it("sets __user_preference_text from effective user preference", async () => {
    writeKnowledgeFile(path.join(tmpDir, "user_preference.md"), "# Test Pref\n- Prefer tests")

    const pool = new VarPool({})
    await precomputeRelevantRules("test-org", [], "test-workflow", {}, pool)

    const prefText = pool.get("__user_preference_text") as string
    expect(prefText).toContain("Prefer tests")
  })

  it("writes rule cache and relevant IDs to pool", async () => {
    const filePath = path.join(tmpDir, "projects", "test.md")
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    appendToKnowledgeFile(filePath, "Always validate inputs", "rule-1", "system")
    appendToKnowledgeFile(filePath, "Use prepared statements", "rule-2", "system")

    const pool = new VarPool({})
    await precomputeRelevantRules("test-org", [], "test-workflow", {}, pool)

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
    await precomputeRelevantRules("test-org", [], "test-workflow", {}, pool)

    expect(pool.get("__knowledge_rule_cache")).toBeUndefined()
    expect(pool.get("__relevant_rule_ids")).toBeUndefined()
  })

  it("only includes active rules", async () => {
    const filePath = path.join(tmpDir, "projects", "test.md")
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    appendToKnowledgeFile(filePath, "Active rule", "active-rule", "system")
    appendToKnowledgeFile(filePath, "Retired rule", "retired-rule", "system")

    // Mark one rule as retired in the file
    const { markRuleRetired } = await import("../file-ops")
    markRuleRetired(filePath, "retired-rule")

    const pool = new VarPool({})
    await precomputeRelevantRules("test-org", [], "test-workflow", {}, pool)

    const idsRaw = pool.get("__relevant_rule_ids") as string
    const ids = JSON.parse(idsRaw)
    expect(ids).toContain("active-rule")
    expect(ids).not.toContain("retired-rule")
  })

  it("writes __knowledge_scope_filter with repoNames and workflowName", async () => {
    const pool = new VarPool({})
    await precomputeRelevantRules("test-org", ["octopus"], "build", {}, pool)

    const raw = pool.get("__knowledge_scope_filter") as string
    const filter = JSON.parse(raw)
    expect(filter.repoNames).toEqual(["octopus"])
    expect(filter.workflowName).toBe("build")
  })

  it("writes __knowledge_scope_filter with multiple repoNames", async () => {
    const pool = new VarPool({})
    await precomputeRelevantRules("test-org", ["octopus", "my-app"], "build", {}, pool)

    const raw = pool.get("__knowledge_scope_filter") as string
    const filter = JSON.parse(raw)
    expect(filter.repoNames).toEqual(["octopus", "my-app"])
    expect(filter.workflowName).toBe("build")
  })

  it("writes __knowledge_scope_filter with empty repoNames when not provided", async () => {
    const pool = new VarPool({})
    await precomputeRelevantRules("test-org", [], "build", {}, pool)

    const raw = pool.get("__knowledge_scope_filter") as string
    const filter = JSON.parse(raw)
    expect(filter.repoNames).toEqual([])
    expect(filter.workflowName).toBe("build")
  })

  it("writes __knowledge_rule_meta for each active rule", async () => {
    const projPath = path.join(tmpDir, "projects", "octopus.md")
    fs.mkdirSync(path.dirname(projPath), { recursive: true })
    appendToKnowledgeFile(projPath, "Project rule", "rule-1", "system")

    const wfPath = path.join(tmpDir, "workflows", "build.md")
    fs.mkdirSync(path.dirname(wfPath), { recursive: true })
    appendToKnowledgeFile(wfPath, "Workflow rule", "rule-2", "system")

    const pool = new VarPool({})
    await precomputeRelevantRules("test-org", ["octopus"], "build", {}, pool)

    const raw = pool.get("__knowledge_rule_meta") as string
    const meta = JSON.parse(raw)
    expect(meta["rule-1"]).toEqual({ fileName: "projects/octopus.md", scope: "project" })
    expect(meta["rule-2"]).toEqual({ fileName: "workflows/build.md", scope: "workflow" })
  })
})
