import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import Database from "better-sqlite3"
import { PendingReviewDAO } from "../../../db/dao/pending-review-dao"
import { applySchema } from "../../../db/schema"
import { ReviewService } from "../review"

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
  // TC-002: 知识中心票 08 —— 审核双写 append 轨剔除（approve 结案不写旧文件）
  // TC-002b: 知识中心票 09 —— 审批链 wiki 通道全删（rule/wiki-edit/wiki-split
  // 不再分发策展执行器；approve 对任何 type 一律只结案状态）。
  // pending_review 表本体保留：skill 草案等非 wiki 用途仍走结案流转（spec「审批废除」）。
  // =========================================================================
  describe("approveItem (TC-002)", () => {
    it("approve 只结案状态，不再追加任何旧知识文件（P2 硬废）", async () => {
      const id = insertPendingRule()

      const result = await reviewService.approveItem(id, "test-org")
      expect(result.ok).toBe(true)
      expect(result.id).toBe(id)

      // 旧 append 轨道已物理删除：OCTOPUS_KNOWLEDGE_DIR 目录保持零文件零子目录
      // （与 main 差异 = 审核通过不再写 org knowledge —— org 库零读者的终态）
      const filePath = path.join(tmpDir, "projects", "octopus.md")
      expect(fs.existsSync(filePath)).toBe(false)
      expect(fs.readdirSync(tmpDir)).toEqual([])

      // Verify pending status updated
      const pending = pendingReviewDAO.getById(id)
      expect(pending?.status).toBe("approved")
    })

    it("is idempotent — approving twice returns same id", async () => {
      const id = insertPendingRule()

      await reviewService.approveItem(id, "test-org")
      const second = await reviewService.approveItem(id, "test-org")
      expect(second.ok).toBe(true)
      expect(second.id).toBe(id) // Already approved, returns original id
    })

    it("throws NOT_FOUND for nonexistent item", async () => {
      await expect(reviewService.approveItem("nonexistent", "test-org")).rejects.toThrow("NOT_FOUND")
    })

    // 票09：审批链 server 全删——wiki 型行不再抛 NO_WIKI_*_APPLIER、不再进
    // curate/split 分发；approve = 结案（表本体留给 skill 草案等非 wiki 用途）。
    it("wiki-split 行 approve 只结案，不再要求拆分执行器（票09 审批链废除）", async () => {
      const id = insertPendingRule({
        id: "wiki-split-xzf-dev-some-entry",
        type: "wiki-split",
        scope: "wiki",
        target_file: "projects/some-entry.md",
      })

      const result = await reviewService.approveItem(id, "xzf-dev")
      expect(result.ok).toBe(true)
      expect(pendingReviewDAO.getById(id)?.status).toBe("approved")
      // 审批链删除后 approve 零写盘：知识目录仍为空（无 curate/split 副作用）
      expect(fs.readdirSync(tmpDir)).toEqual([])
    })

    it("wiki-edit 行 approve 同样只结案零写盘（票09 审批链废除）", async () => {
      const id = insertPendingRule({
        id: "wiki-edit-xzf-dev-another-entry",
        type: "wiki-edit",
        scope: "wiki",
        target_file: "projects/another-entry.md",
      })

      await reviewService.approveItem(id, "xzf-dev")
      expect(pendingReviewDAO.getById(id)?.status).toBe("approved")
      expect(fs.readdirSync(tmpDir)).toEqual([])
    })

    it("user_preference 目标行 approve 也不再走策展拒写（写权保护由人工直接编辑承接）", async () => {
      const id = insertPendingRule({
        id: "pref-rule-20261013-wiki",
        type: "rule",
        scope: "wiki",
        target_file: "user_preference.md",
      })

      await reviewService.approveItem(id, "xzf-dev")
      expect(pendingReviewDAO.getById(id)?.status).toBe("approved")
      expect(fs.readdirSync(tmpDir)).toEqual([])
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
    it("approves multiple items and reports results", async () => {
      const id1 = insertPendingRule({ id: "batch-1" })
      const id2 = insertPendingRule({ id: "batch-2" })

      const result = await reviewService.batchApprove([id1, id2, "nonexistent"], "test-org")
      expect(result.succeeded).toBe(2)
      expect(result.failed).toBe(1)
      expect(result.details).toHaveLength(3)
    })
  })

  describe("getPendingSummary", () => {
    it("returns rule count", () => {
      insertPendingRule({ id: "r1" })
      insertPendingRule({ id: "r2" })

      const summary = reviewService.getPendingSummary()
      expect(summary.rules).toBe(2)
    })
  })
})
