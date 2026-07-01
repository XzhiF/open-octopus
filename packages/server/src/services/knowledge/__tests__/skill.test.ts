import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import Database from "better-sqlite3"
import { PendingReviewDAO } from "../../../db/dao/pending-review-dao"
import { applySchema } from "../../../db/schema"
import { proposeSkillFromWorkspace, approveSkill } from "../skill"
import type { ProposedSkill } from "@octopus/shared"

describe("skill", () => {
  let db: Database.Database
  let pendingReviewDAO: PendingReviewDAO
  let tmpDir: string

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    pendingReviewDAO = new PendingReviewDAO(db)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-test-"))
    process.env.OCTOPUS_KNOWLEDGE_DIR = tmpDir
  })

  afterEach(() => {
    db?.close()
    delete process.env.OCTOPUS_KNOWLEDGE_DIR
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // =========================================================================
  // TC-015: proposeSkillFromWorkspace
  // =========================================================================
  describe("proposeSkillFromWorkspace (TC-015)", () => {
    it("returns null when LLM is placeholder (callHaiku returns empty)", async () => {
      // callHaiku is a placeholder → returns "" → function returns null
      const result = await proposeSkillFromWorkspace(
        "ws-001", "test-org", pendingReviewDAO, "Execution summary",
      )
      expect(result).toBeNull()
    })

    it("returns null when no execution summary provided", async () => {
      const result = await proposeSkillFromWorkspace(
        "ws-001", "test-org", pendingReviewDAO,
      )
      expect(result).toBeNull()
    })

    it("does not insert pending item when returning null", async () => {
      await proposeSkillFromWorkspace(
        "ws-001", "test-org", pendingReviewDAO, "summary",
      )

      const count = pendingReviewDAO.countPending()
      expect(count).toBe(0)
    })

    it("proposes skill when LLM returns valid JSON (happy path)", async () => {
      const mockLlm = async () =>
        JSON.stringify({
          skillName: "octo-test-automation",
          category: "testing",
          content: "# Test Automation Skill\n\nAutomate test writing.",
          confidence: 0.85,
        })

      const result = await proposeSkillFromWorkspace(
        "ws-001", "test-org", pendingReviewDAO,
        "Executed 50 test suites with recurring patterns in test setup",
        mockLlm,
      )

      expect(result).not.toBeNull()
      expect(result!.skillName).toBe("octo-test-automation")
      expect(result!.category).toBe("testing")
      expect(result!.confidence).toBe(0.85)
      expect(result!.source).toBe("workspace_archive")

      // Verify pending item was inserted with complete fields
      const items = pendingReviewDAO.listBySource("workspace_archive")
      expect(items).toHaveLength(1)
      const item = items[0]
      expect(item.type).toBe("skill")
      expect(item.status).toBe("pending")
      expect(item.target_file).toBe("skills/octo-test-automation/SKILL.md")
      expect(item.content).toContain("# Test Automation Skill")
      expect(item.confidence).toBe(0.85)
      expect(item.scope).toBe("project")
    })
  })

  // =========================================================================
  // TC-017: approveSkill — writes SKILL.md
  // =========================================================================
  describe("approveSkill (TC-017)", () => {
    it("writes SKILL.md to org skills directory", () => {
      // Insert a pending skill item first
      pendingReviewDAO.insert({
        id: "skill-test-001",
        type: "skill",
        source: "workspace_archive",
        source_ref: "ws-001",
        source_label: "Test skill",
        content: "# Test Skill\n\nThis is a test skill.",
        target_file: "skills/octo-test-skill/SKILL.md",
        scope: "project",
        conflicts: null,
        confidence: 0.8,
        auto_approve: 0,
        status: "pending",
        user_notes: null,
      })

      const proposed: ProposedSkill = {
        id: "skill-test-001",
        skillName: "octo-test-skill",
        category: "development",
        source: "workspace_archive",
        sourceRef: "ws-001",
        content: "# Test Skill\n\nThis is a test skill.",
        confidence: 0.8,
        status: "pending",
      }

      const result = approveSkill(proposed, "test-org", pendingReviewDAO)
      expect(result.ok).toBe(true)

      // Verify SKILL.md exists in the skills directory
      // getKnowledgeDir returns tmpDir, skills dir is tmpDir/../skills/
      const skillDir = path.join(tmpDir, "..", "skills", "octo-test-skill")
      const skillPath = path.join(skillDir, "SKILL.md")
      expect(fs.existsSync(skillPath)).toBe(true)

      const content = fs.readFileSync(skillPath, "utf-8")
      expect(content).toContain("# Test Skill")
      expect(content).toContain("This is a test skill.")

      // Verify pending status updated to approved
      const pending = pendingReviewDAO.getById("skill-test-001")
      expect(pending?.status).toBe("approved")
    })

    it("creates nested skill directories", () => {
      const proposed: ProposedSkill = {
        id: "skill-nested-001",
        skillName: "octo-nested-skill",
        category: "testing",
        source: "workspace_archive",
        sourceRef: "ws-002",
        content: "# Nested Skill",
        confidence: 0.7,
        status: "pending",
      }

      pendingReviewDAO.insert({
        id: "skill-nested-001",
        type: "skill",
        source: "workspace_archive",
        source_ref: "ws-002",
        source_label: "Nested skill",
        content: "# Nested Skill",
        target_file: "skills/octo-nested-skill/SKILL.md",
        scope: "project",
        conflicts: null,
        confidence: 0.7,
        auto_approve: 0,
        status: "pending",
        user_notes: null,
      })

      const result = approveSkill(proposed, "test-org", pendingReviewDAO)
      expect(result.ok).toBe(true)

      const skillPath = path.join(tmpDir, "..", "skills", "octo-nested-skill", "SKILL.md")
      expect(fs.existsSync(skillPath)).toBe(true)
    })
  })
})
