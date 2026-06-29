import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { KnowledgeRuleDAO } from "../knowledge-rule-dao"
import { applySchema } from "../../schema"

describe("KnowledgeRuleDAO", () => {
  let db: Database.Database
  let dao: KnowledgeRuleDAO

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    dao = new KnowledgeRuleDAO(db)
  })

  afterEach(() => {
    db?.close()
  })

  it("inserts and retrieves a rule", () => {
    dao.insert({
      rule_id: "test-20260629-abcd",
      file_name: "octopus.md",
      text: "Always validate inputs",
      scope: "project",
      source: "system",
      status: "active",
    })

    const rule = dao.getById("test-20260629-abcd")
    expect(rule).toBeDefined()
    expect(rule?.text).toBe("Always validate inputs")
    expect(rule?.status).toBe("active")
  })

  it("lists active rules", () => {
    dao.insert({
      rule_id: "rule-1",
      file_name: "test.md",
      text: "Active rule",
      scope: "project",
      source: "system",
      status: "active",
    })
    dao.insert({
      rule_id: "rule-2",
      file_name: "test.md",
      text: "Retired rule",
      scope: "project",
      source: "system",
      status: "retired",
    })

    const active = dao.listActive()
    expect(active).toHaveLength(1)
    expect(active[0].rule_id).toBe("rule-1")
  })

  it("updates rule status", () => {
    dao.insert({
      rule_id: "rule-1",
      file_name: "test.md",
      text: "Test rule",
      scope: "project",
      source: "system",
      status: "active",
    })

    dao.updateStatus("rule-1", "retired")
    const rule = dao.getById("rule-1")
    expect(rule?.status).toBe("retired")
  })

  it("lists rules by scope", () => {
    dao.insert({
      rule_id: "rule-1",
      file_name: "test.md",
      text: "Project rule",
      scope: "project",
      source: "system",
      status: "active",
    })
    dao.insert({
      rule_id: "rule-2",
      file_name: "test.md",
      text: "Workflow rule",
      scope: "workflow",
      source: "system",
      status: "active",
    })

    const projectRules = dao.listByScope("project")
    expect(projectRules).toHaveLength(1)
    expect(projectRules[0].text).toBe("Project rule")
  })

  it("searches rules by text", () => {
    dao.insert({
      rule_id: "rule-1",
      file_name: "test.md",
      text: "Always validate user inputs",
      scope: "project",
      source: "system",
      status: "active",
    })
    dao.insert({
      rule_id: "rule-2",
      file_name: "test.md",
      text: "Use prepared statements",
      scope: "project",
      source: "system",
      status: "active",
    })

    const results = dao.searchByText("validate")
    expect(results).toHaveLength(1)
    expect(results[0].rule_id).toBe("rule-1")
  })
})
