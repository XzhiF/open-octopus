import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import Database from "better-sqlite3"
import { PendingReviewDAO } from "../../../db/dao/pending-review-dao"
import { applySchema } from "../../../db/schema"
import { ReviewService } from "../review"
import { readKnowledgeFile } from "../file-ops"

describe("review", () => {
  let db: Database.Database
  let pendingReviewDAO: PendingReviewDAO
  let reviewService: ReviewService
  let tmpDir: string

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    pendingReviewDAO = new PendingReviewDAO(db)
    reviewService = new ReviewService(pendingReviewDAO)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-test-"))
    process.env.OCTOPUS_KNOWLEDGE_DIR = tmpDir
  })

  afterEach(() => {
    db?.close()
    delete process.env.OCTOPUS_KNOWLEDGE_DIR
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function insertPendingRule(overrides: Partial<Parameters<typeof pendingReviewDAO.insert>[0]> = {}) {
    const id = overrides.id ?? "rule-pending-001"
    pendingReviewDAO.insert({
      id,
      type: "rule",
      source: "workspace_archive",
      source_ref: "exec-001",
      source_label: "Test rule",
      content: "Always validate inputs",
      target_file: "projects/octopus.md",
      scope: "project",
      conflicts: null,
      confidence: 0.8,
      auto_approve: 0,
      status: "pending",
      user_notes: null,
      ...overrides,
    })
    return id
  }

  // =========================================================================
  // TC-002: approveItem writes to Org-level knowledge directory
  // =========================================================================
  describe("approveItem (TC-002)", () => {
    it("writes rule to org knowledge directory, not global", () => {
      const id = insertPendingRule()

      const result = reviewService.approveItem(id, "test-org")
      expect(result.ok).toBe(true)
      expect(result.ruleId).toBeDefined()

      // Verify file written to tmpDir (which simulates org-level dir via OCTOPUS_KNOWLEDGE_DIR)
      const filePath = path.join(tmpDir, "projects", "octopus.md")
      const content = readKnowledgeFile(filePath)
      expect(content).toContain("Always validate inputs")
      expect(content).toContain(result.ruleId)

      // Verify pending status updated
      const pending = pendingReviewDAO.getById(id)
      expect(pending?.status).toBe("approved")
    })

    it("is idempotent — approving twice returns same ruleId", () => {
      const id = insertPendingRule()

      const first = reviewService.approveItem(id, "test-org")
      const second = reviewService.approveItem(id, "test-org")
      expect(second.ok).toBe(true)
      expect(second.ruleId).toBe(id) // Already approved, returns original id
    })

    it("throws NOT_FOUND for nonexistent item", () => {
      expect(() => reviewService.approveItem("nonexistent", "test-org")).toThrow("NOT_FOUND")
    })
  })

  // =========================================================================
  // TC-021: resolveReviewStrategy — 4 strategy routes
  // =========================================================================
  describe("resolveReviewStrategy (TC-021)", () => {
    it("returns 'auto_approve' for recurring_pitfall source", () => {
      expect(reviewService.resolveReviewStrategy("recurring_pitfall")).toBe("auto_approve")
    })

    it("returns 'inline' for agent_conversation source", () => {
      expect(reviewService.resolveReviewStrategy("agent_conversation")).toBe("inline")
    })

    it("returns 'background' for scheduler source", () => {
      expect(reviewService.resolveReviewStrategy("scheduler")).toBe("background")
    })

    it("returns 'auto' for workspace_archive (default)", () => {
      expect(reviewService.resolveReviewStrategy("workspace_archive")).toBe("auto")
    })

    it("respects agentConfig.review_strategy override", () => {
      expect(
        reviewService.resolveReviewStrategy("workspace_archive", { review_strategy: "manual" }),
      ).toBe("manual")
    })

    it("recurring_pitfall overrides agentConfig", () => {
      expect(
        reviewService.resolveReviewStrategy("recurring_pitfall", { review_strategy: "manual" }),
      ).toBe("auto_approve")
    })
  })

  // =========================================================================
  // Additional review operations
  // =========================================================================
  describe("rejectItem", () => {
    it("rejects with optional user notes", () => {
      const id = insertPendingRule()
      const result = reviewService.rejectItem(id, "Not applicable")
      expect(result.ok).toBe(true)

      const pending = pendingReviewDAO.getById(id)
      expect(pending?.status).toBe("rejected")
      expect(pending?.user_notes).toBe("Not applicable")
    })
  })

  describe("deferItem", () => {
    it("defers a pending item", () => {
      const id = insertPendingRule()
      const result = reviewService.deferItem(id)
      expect(result.ok).toBe(true)

      const pending = pendingReviewDAO.getById(id)
      expect(pending?.status).toBe("deferred")
    })
  })

  describe("batchApprove", () => {
    it("approves multiple items and reports results", () => {
      const id1 = insertPendingRule({ id: "batch-1" })
      const id2 = insertPendingRule({ id: "batch-2" })

      const result = reviewService.batchApprove([id1, id2, "nonexistent"], "test-org")
      expect(result.succeeded).toBe(2)
      expect(result.failed).toBe(1)
      expect(result.details).toHaveLength(3)
    })
  })

  describe("getPendingSummary", () => {
    it("returns counts by type", () => {
      insertPendingRule({ id: "r1" })
      insertPendingRule({ id: "r2" })
      pendingReviewDAO.insert({
        id: "s1",
        type: "skill",
        source: "workspace_archive",
        source_ref: "ws-1",
        source_label: "Skill proposal",
        content: "Skill content",
        target_file: "skills/test/SKILL.md",
        scope: "project",
        conflicts: null,
        confidence: 0.7,
        auto_approve: 0,
        status: "pending",
        user_notes: null,
      })

      const summary = reviewService.getPendingSummary()
      expect(summary.rules).toBe(2)
      expect(summary.skills).toBe(1)
    })
  })

  // =========================================================================
  // Skill approval via ReviewService (TC-017 partial)
  // =========================================================================
  describe("approveItem — skill type", () => {
    it("writes SKILL.md to skills directory", () => {
      pendingReviewDAO.insert({
        id: "skill-001",
        type: "skill",
        source: "workspace_archive",
        source_ref: "ws-1",
        source_label: "Skill proposal",
        content: "# My Skill\n\nSkill content here",
        target_file: "skills/octo-test-skill/SKILL.md",
        scope: "project",
        conflicts: null,
        confidence: 0.8,
        auto_approve: 0,
        status: "pending",
        user_notes: null,
      })

      const result = reviewService.approveItem("skill-001", "test-org")
      expect(result.ok).toBe(true)

      // Verify SKILL.md was written
      // getKnowledgeDir returns tmpDir, so skills dir is tmpDir/../skills/octo-test-skill/
      const skillPath = path.join(tmpDir, "..", "skills", "octo-test-skill", "SKILL.md")
      const content = fs.readFileSync(skillPath, "utf-8")
      expect(content).toContain("# My Skill")

      // Verify status updated
      const pending = pendingReviewDAO.getById("skill-001")
      expect(pending?.status).toBe("approved")
    })
  })
})
