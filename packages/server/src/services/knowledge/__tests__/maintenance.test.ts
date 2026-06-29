import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import Database from "better-sqlite3"
import { PendingReviewDAO } from "../../../db/dao/pending-review-dao"
import { applySchema } from "../../../db/schema"
import { checkCompactThreshold } from "../maintenance"

describe("maintenance", () => {
  let db: Database.Database
  let pendingReviewDAO: PendingReviewDAO
  let tmpDir: string

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    pendingReviewDAO = new PendingReviewDAO(db)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maintenance-test-"))
  })

  afterEach(() => {
    db?.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("checkCompactThreshold", () => {
    it("creates pending item when file exceeds threshold", () => {
      // Create a file with many lines
      const filePath = path.join(tmpDir, "large.md")
      const lines = Array(150).fill("- Rule line").join("\n")
      fs.writeFileSync(filePath, lines)

      // Mock getKnowledgeDir to return tmpDir
      const originalEnv = process.env.OCTOPUS_KNOWLEDGE_DIR
      process.env.OCTOPUS_KNOWLEDGE_DIR = tmpDir

      try {
        checkCompactThreshold("test-org", "large.md", 100, pendingReviewDAO)

        const pending = pendingReviewDAO.listBySource("system")
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

    it("is idempotent - does not create duplicate pending items", () => {
      const filePath = path.join(tmpDir, "large.md")
      const lines = Array(150).fill("- Rule line").join("\n")
      fs.writeFileSync(filePath, lines)

      const originalEnv = process.env.OCTOPUS_KNOWLEDGE_DIR
      process.env.OCTOPUS_KNOWLEDGE_DIR = tmpDir

      try {
        checkCompactThreshold("test-org", "large.md", 100, pendingReviewDAO)
        checkCompactThreshold("test-org", "large.md", 100, pendingReviewDAO)

        const pending = pendingReviewDAO.listBySource("system")
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

    it("does not create pending item when file is under threshold", () => {
      const filePath = path.join(tmpDir, "small.md")
      const lines = Array(50).fill("- Rule line").join("\n")
      fs.writeFileSync(filePath, lines)

      const originalEnv = process.env.OCTOPUS_KNOWLEDGE_DIR
      process.env.OCTOPUS_KNOWLEDGE_DIR = tmpDir

      try {
        checkCompactThreshold("test-org", "small.md", 100, pendingReviewDAO)

        const pending = pendingReviewDAO.listBySource("system")
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
})
