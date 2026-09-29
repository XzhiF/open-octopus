// P1 B2：pending_review 已迁 postgres.js（BasePgDAO）—— 本文件造数/读断言全部走 PG。
// 每文件一座随机测试库（beforeAll 建 / afterAll  DROP），用例间 TRUNCATE 清表；
// 不再需要 SQLite（本域只碰 pending_review 一张表 + 知识文件）。
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import { PendingReviewDAO } from "../../../db/dao/pending-review-dao"
import { describePg, setupRegisteredPgSchema, type PgFixture } from "../../../db/pg/__tests__/dao-fixture"
import { ReviewService } from "../review"
import { readKnowledgeFile } from "../file-ops"

describePg("review", () => {
  let pg: PgFixture | null = null
  let pendingReviewDAO: PendingReviewDAO
  let reviewService: ReviewService
  let tmpDir: string

  beforeAll(async () => {
    pg = await setupRegisteredPgSchema()
  })

  afterAll(async () => {
    await pg?.close()
    pg = null
  })

  beforeEach(async () => {
    await pg!.truncate("pending_review")
    pendingReviewDAO = new PendingReviewDAO(pg!.sql)
    reviewService = new ReviewService(pendingReviewDAO)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-test-"))
    process.env.OCTOPUS_KNOWLEDGE_DIR = tmpDir
  })

  afterEach(() => {
    delete process.env.OCTOPUS_KNOWLEDGE_DIR
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function insertPendingRule(overrides: Partial<Parameters<typeof pendingReviewDAO.insert>[0]> = {}) {
    const id = overrides.id ?? "rule-pending-001"
    await pendingReviewDAO.insert({
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
    it("writes rule to org knowledge directory, not global", async () => {
      const id = await insertPendingRule()

      const result = await reviewService.approveItem(id, "test-org")
      expect(result.ok).toBe(true)
      expect(result.ruleId).toBeDefined()

      // Verify file written to tmpDir (which simulates org-level dir via OCTOPUS_KNOWLEDGE_DIR)
      const filePath = path.join(tmpDir, "projects", "octopus.md")
      const content = readKnowledgeFile(filePath)
      expect(content).toContain("Always validate inputs")
      expect(content).toContain(result.ruleId)

      // Verify pending status updated
      const pending = await pendingReviewDAO.getById(id)
      expect(pending?.status).toBe("approved")
    })

    it("is idempotent — approving twice returns same ruleId", async () => {
      const id = await insertPendingRule()

      await reviewService.approveItem(id, "test-org") // first approval
      const second = await reviewService.approveItem(id, "test-org")
      expect(second.ok).toBe(true)
      expect(second.ruleId).toBe(id) // Already approved, returns original id
    })

    it("throws NOT_FOUND for nonexistent item", async () => {
      await expect(reviewService.approveItem("nonexistent", "test-org")).rejects.toThrow("NOT_FOUND")
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
    it("rejects with optional user notes", async () => {
      const id = await insertPendingRule()
      const result = await reviewService.rejectItem(id, "Not applicable")
      expect(result.ok).toBe(true)

      const pending = await pendingReviewDAO.getById(id)
      expect(pending?.status).toBe("rejected")
      expect(pending?.user_notes).toBe("Not applicable")
    })
  })

  describe("deferItem", () => {
    it("defers a pending item", async () => {
      const id = await insertPendingRule()
      const result = await reviewService.deferItem(id)
      expect(result.ok).toBe(true)

      const pending = await pendingReviewDAO.getById(id)
      expect(pending?.status).toBe("deferred")
    })
  })

  describe("batchApprove", () => {
    it("approves multiple items and reports results", async () => {
      const id1 = await insertPendingRule({ id: "batch-1" })
      const id2 = await insertPendingRule({ id: "batch-2" })

      const result = await reviewService.batchApprove([id1, id2, "nonexistent"], "test-org")
      expect(result.succeeded).toBe(2)
      expect(result.failed).toBe(1)
      expect(result.details).toHaveLength(3)
    })
  })

  describe("getPendingSummary", () => {
    it("returns rule count", async () => {
      await insertPendingRule({ id: "r1" })
      await insertPendingRule({ id: "r2" })

      const summary = await reviewService.getPendingSummary()
      expect(summary.rules).toBe(2)
    })
  })
})
