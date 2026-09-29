// P1 B2：pending_review 已迁 postgres.js（BasePgDAO）—— 本文件造数/读断言全部走 PG。
// 每文件一座随机测试库（beforeAll 建 / afterAll DROP），用例间 TRUNCATE 清表。
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import { PendingReviewDAO } from "../../../db/dao/pending-review-dao"
import { describePg, setupRegisteredPgSchema, type PgFixture } from "../../../db/pg/__tests__/dao-fixture"
import {
  checkCompactThreshold,
  mergeCloneKnowledge,
  compactKnowledgeFile,
} from "../maintenance"
import { appendToKnowledgeFile, readKnowledgeFile } from "../file-ops"

describePg("maintenance", () => {
  let pg: PgFixture | null = null
  let pendingReviewDAO: PendingReviewDAO
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maintenance-test-"))
  })

  afterEach(() => {
    delete process.env.OCTOPUS_KNOWLEDGE_DIR
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("checkCompactThreshold", () => {
    it("creates pending item when file exceeds threshold", async () => {
      // Create a file with many lines
      const filePath = path.join(tmpDir, "large.md")
      const lines = Array(150).fill("- Rule line").join("\n")
      fs.writeFileSync(filePath, lines)

      // Mock getKnowledgeDir to return tmpDir
      const originalEnv = process.env.OCTOPUS_KNOWLEDGE_DIR
      process.env.OCTOPUS_KNOWLEDGE_DIR = tmpDir

      try {
        await checkCompactThreshold("test-org", "large.md", 100, pendingReviewDAO)

        const pending = await pendingReviewDAO.listBySource("system")
        expect(pending.length).toBeGreaterThanOrEqual(1)
        const thresholdItem = pending.find(p => p.source_ref === "compact-threshold:large.md")
        expect(thresholdItem).toBeDefined()
        expect(thresholdItem?.content).toContain("150 lines")
      } finally {
        if (originalEnv) {
          process.env.OCTOPUS_KNOWLEDGE_DIR = originalEnv
        } else {
          delete process.env.OCTOPUS_KNOWLEDGE_DIR
        }
      }
    })

    it("is idempotent - does not create duplicate pending items", async () => {
      const filePath = path.join(tmpDir, "large.md")
      const lines = Array(150).fill("- Rule line").join("\n")
      fs.writeFileSync(filePath, lines)

      const originalEnv = process.env.OCTOPUS_KNOWLEDGE_DIR
      process.env.OCTOPUS_KNOWLEDGE_DIR = tmpDir

      try {
        await checkCompactThreshold("test-org", "large.md", 100, pendingReviewDAO)
        await checkCompactThreshold("test-org", "large.md", 100, pendingReviewDAO)

        const pending = await pendingReviewDAO.listBySource("system")
        const thresholdItems = pending.filter(p => p.source_ref === "compact-threshold:large.md")
        expect(thresholdItems).toHaveLength(1)
      } finally {
        if (originalEnv) {
          process.env.OCTOPUS_KNOWLEDGE_DIR = originalEnv
        } else {
          delete process.env.OCTOPUS_KNOWLEDGE_DIR
        }
      }
    })

    it("does not create pending item when file is under threshold", async () => {
      const filePath = path.join(tmpDir, "small.md")
      const lines = Array(50).fill("- Rule line").join("\n")
      fs.writeFileSync(filePath, lines)

      const originalEnv = process.env.OCTOPUS_KNOWLEDGE_DIR
      process.env.OCTOPUS_KNOWLEDGE_DIR = tmpDir

      try {
        await checkCompactThreshold("test-org", "small.md", 100, pendingReviewDAO)

        const pending = await pendingReviewDAO.listBySource("system")
        const thresholdItems = pending.filter(p => p.source_ref === "compact-threshold:small.md")
        expect(thresholdItems).toHaveLength(0)
      } finally {
        if (originalEnv) {
          process.env.OCTOPUS_KNOWLEDGE_DIR = originalEnv
        } else {
          delete process.env.OCTOPUS_KNOWLEDGE_DIR
        }
      }
    })
  })

  // =========================================================================
  // TC-026: mergeCloneKnowledge
  // =========================================================================
  describe("mergeCloneKnowledge (TC-026)", () => {
    it("creates clone_merge items from workspace_archive clone items", async () => {
      // Insert items that look like they came from a clone execution
      await pendingReviewDAO.insert({
        id: "clone-rule-001",
        type: "rule",
        source: "workspace_archive",
        source_ref: "clone:abc-123:exec-001",
        source_label: "Clone execution",
        content: "Always use TypeScript strict mode",
        target_file: "octopus.md",
        scope: "project",
        conflicts: null,
        confidence: 0.8,
        auto_approve: 0,
        status: "pending",
        user_notes: null,
      })

      await pendingReviewDAO.insert({
        id: "clone-rule-002",
        type: "rule",
        source: "workspace_archive",
        source_ref: "clone:abc-123:exec-002",
        source_label: "Clone execution 2",
        content: "Use connection pooling",
        target_file: "octopus.md",
        scope: "project",
        conflicts: null,
        confidence: 0.7,
        auto_approve: 0,
        status: "pending",
        user_notes: null,
      })

      // Also insert a non-clone item that should NOT be merged
      await pendingReviewDAO.insert({
        id: "normal-rule-001",
        type: "rule",
        source: "workspace_archive",
        source_ref: "exec-normal",
        source_label: "Normal execution",
        content: "Normal rule",
        target_file: "octopus.md",
        scope: "project",
        conflicts: null,
        confidence: 0.8,
        auto_approve: 0,
        status: "pending",
        user_notes: null,
      })

      const merged = await mergeCloneKnowledge("abc-123", pendingReviewDAO)
      expect(merged).toBe(2)

      // Verify clone_merge items were created
      const cloneMergeItems = await pendingReviewDAO.listBySource("clone_merge")
      expect(cloneMergeItems).toHaveLength(2)
      expect(cloneMergeItems[0].source).toBe("clone_merge")
      expect(cloneMergeItems.some(i => i.content === "Always use TypeScript strict mode")).toBe(true)
      expect(cloneMergeItems.some(i => i.content === "Use connection pooling")).toBe(true)
    })

    it("returns 0 when no clone items found", async () => {
      const merged = await mergeCloneKnowledge("nonexistent-clone", pendingReviewDAO)
      expect(merged).toBe(0)
    })
  })

  // =========================================================================
  // compactKnowledgeFile
  // =========================================================================
  describe("compactKnowledgeFile", () => {
    it("creates pending item for compact review", async () => {
      process.env.OCTOPUS_KNOWLEDGE_DIR = tmpDir

      const filePath = path.join(tmpDir, "compact-test.md")
      appendToKnowledgeFile(filePath, "Rule A", "compact-a", "system")
      appendToKnowledgeFile(filePath, "Rule B", "compact-b", "system")

      const result = await compactKnowledgeFile("test-org", "compact-test.md", pendingReviewDAO)
      expect(result.originalLineCount).toBeGreaterThan(0)
      expect(result.pendingItemId).toBeDefined()

      // Pending item should exist
      const pending = await pendingReviewDAO.getById(result.pendingItemId)
      expect(pending).toBeDefined()
      expect(pending?.source_ref).toBe("compact:compact-test.md")

      delete process.env.OCTOPUS_KNOWLEDGE_DIR
    })

    it("throws NOT_FOUND for nonexistent file", async () => {
      process.env.OCTOPUS_KNOWLEDGE_DIR = tmpDir
      await expect(
        compactKnowledgeFile("test-org", "nonexistent.md", pendingReviewDAO),
      ).rejects.toThrow("NOT_FOUND")
      delete process.env.OCTOPUS_KNOWLEDGE_DIR
    })
  })
})
