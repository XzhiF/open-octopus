import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import Database from "better-sqlite3"
import { KnowledgeEffectivenessDAO } from "../../../db/dao/knowledge-effectiveness-dao"
import { applySchema } from "../../../db/schema"
import {
  computeEffectivenessUpdates,
  applyEffectivenessUpdates,
  trackEffectiveness,
  retireStaleRules,
  restoreRule,
} from "../effectiveness"
import {
  appendToKnowledgeFile,
  readKnowledgeFile,
  markRuleRetired,
  unmarkRuleRetired,
  findRuleById,
} from "../file-ops"

describe("effectiveness", () => {
  let db: Database.Database
  let effectivenessDAO: KnowledgeEffectivenessDAO
  let tmpDir: string

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    effectivenessDAO = new KnowledgeEffectivenessDAO(db)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "effectiveness-test-"))
    process.env.OCTOPUS_KNOWLEDGE_DIR = tmpDir
  })

  afterEach(() => {
    db?.close()
    delete process.env.OCTOPUS_KNOWLEDGE_DIR
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("computeEffectivenessUpdates", () => {
    it("marks rule as helpful when no keyword overlap", () => {
      const updates = computeEffectivenessUpdates(
        ["rule-1"],
        "Error: connection timeout",
        new Map([["rule-1", "Always use TypeScript"]]),
      )
      expect(updates).toHaveLength(1)
      expect(updates[0].ruleId).toBe("rule-1")
      expect(updates[0].helpful).toBe(true)
    })

    it("marks rule as not helpful when high keyword overlap", () => {
      const updates = computeEffectivenessUpdates(
        ["rule-1"],
        "Error: TypeScript compilation failed with type error",
        new Map([["rule-1", "Always use TypeScript for type safety"]]),
      )
      expect(updates).toHaveLength(1)
      expect(updates[0].helpful).toBe(false)
    })

    it("handles empty injected IDs", () => {
      const updates = computeEffectivenessUpdates([], "some error", new Map())
      expect(updates).toHaveLength(0)
    })
  })

  describe("applyEffectivenessUpdates", () => {
    it("increments counters correctly", () => {
      applyEffectivenessUpdates(effectivenessDAO, [
        { ruleId: "rule-1", helpful: true },
        { ruleId: "rule-1", helpful: false },
        { ruleId: "rule-2", helpful: true },
      ])

      const row1 = effectivenessDAO.getByRuleId("rule-1")
      expect(row1?.injected_count).toBe(2)
      expect(row1?.helpful_count).toBe(1)
      expect(row1?.not_helpful_count).toBe(1)

      const row2 = effectivenessDAO.getByRuleId("rule-2")
      expect(row2?.injected_count).toBe(1)
      expect(row2?.helpful_count).toBe(1)
    })
  })

  describe("trackEffectiveness", () => {
    it("tracks effectiveness from execution result", () => {
      const filePath = path.join(tmpDir, "projects", "test.md")
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      appendToKnowledgeFile(filePath, "Always validate inputs", "rule-1", "system")

      const execResult = {
        id: "exec-1",
        status: "completed",
        nodes: {
          "node-1": { status: "completed", exitCode: 0, lastOutput: "Success" },
        },
        poolSnapshot: {
          __injected_rule_ids: JSON.stringify(["rule-1"]),
        },
      }

      const tracked = trackEffectiveness(execResult, effectivenessDAO, "test-org")
      expect(tracked).toBe(1)

      const row = effectivenessDAO.getByRuleId("rule-1")
      expect(row?.injected_count).toBe(1)
    })

    it("returns 0 when no injected rules", () => {
      const execResult = {
        id: "exec-1",
        status: "completed",
        nodes: {},
        poolSnapshot: {},
      }

      const tracked = trackEffectiveness(execResult, effectivenessDAO, "test-org")
      expect(tracked).toBe(0)
    })
  })

  describe("retireStaleRules", () => {
    it("retires rules with low confidence", () => {
      const filePath = path.join(tmpDir, "projects", "test.md")
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      appendToKnowledgeFile(filePath, "Bad rule", "stale-rule", "system")

      // Simulate 3 injections, all not helpful (confidence = 0)
      for (let i = 0; i < 3; i++) {
        effectivenessDAO.incrementInjected("stale-rule")
        effectivenessDAO.incrementNotHelpful("stale-rule")
      }

      const retired = retireStaleRules(effectivenessDAO, "test-org", 3, 0.2, 0)
      expect(retired).toBe(1)

      const rule = findRuleById("test-org", "stale-rule")
      expect(rule?.retired).toBe(true)
    })
  })

  // TC-041: File-level retirement and restore assertions
  describe("file-level retirement/restore (TC-041)", () => {
    it("retireStaleRules marks knowledge file with <!-- retired -->", () => {
      // Create knowledge file with a rule (must be in projects/ subdirectory)
      const filePath = path.join(tmpDir, "projects", "test.md")
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      appendToKnowledgeFile(filePath, "Stale rule text", "stale-file-001", "system")

      // Simulate low confidence
      for (let i = 0; i < 3; i++) {
        effectivenessDAO.incrementInjected("stale-file-001")
        effectivenessDAO.incrementNotHelpful("stale-file-001")
      }

      // Retire with org parameter to trigger file-level marking
      const retired = retireStaleRules(effectivenessDAO, "test-org", 3, 0.2, 0)
      expect(retired).toBe(1)

      // File should contain <!-- retired --> annotation
      const content = readKnowledgeFile(filePath)
      expect(content).toContain("<!-- retired -->")
    })

    it("restoreRule reactivates file status", () => {
      const filePath = path.join(tmpDir, "projects", "test.md")
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      appendToKnowledgeFile(filePath, "Rule to restore", "restore-file-001", "system")
      markRuleRetired(filePath, "restore-file-001")

      const result = restoreRule("restore-file-001", "test-org")
      expect(result.ok).toBe(true)

      const rule = findRuleById("test-org", "restore-file-001")
      expect(rule?.retired).toBe(false)
    })

    it("markRuleRetired and unmarkRuleRetired toggle file annotation", () => {
      const filePath = path.join(tmpDir, "toggle.md")
      appendToKnowledgeFile(filePath, "Toggle rule", "toggle-001", "system")

      // Retire in file
      markRuleRetired(filePath, "toggle-001")
      let content = readKnowledgeFile(filePath)
      expect(content).toContain("<!-- retired -->")

      // Restore in file
      unmarkRuleRetired(filePath, "toggle-001")
      content = readKnowledgeFile(filePath)
      expect(content).not.toContain("<!-- retired -->")
    })
  })

  describe("restoreRule", () => {
    it("restores a retired rule", () => {
      const filePath = path.join(tmpDir, "projects", "test.md")
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      appendToKnowledgeFile(filePath, "Test rule", "rule-1", "system")
      markRuleRetired(filePath, "rule-1")

      const result = restoreRule("rule-1", "test-org")
      expect(result.ok).toBe(true)

      const rule = findRuleById("test-org", "rule-1")
      expect(rule?.retired).toBe(false)
    })

    it("throws when rule not found or not retired", () => {
      expect(() => restoreRule("nonexistent", "test-org")).toThrow("NOT_FOUND")
    })
  })
})
