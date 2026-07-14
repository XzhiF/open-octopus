import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { applySchema } from "../../../db/schema"
import { ArchiveDAO } from "../../../db/dao/archive-dao"
import { ExecutionDAO } from "../../../db/dao/execution-dao"
import { WorkspaceDAO } from "../../../db/dao/workspace-dao"
import { ArchiveService } from "../archive-service"
import { WorkspaceService } from "../../workspace"
import { initArchiveService } from "../archive-service"

// ── Helpers ──────────────────────────────────────────────────────────────

function createTempWorkspace(prefix = "integ-test-"): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fs.mkdirSync(path.join(tmpDir, "state"), { recursive: true })
  fs.mkdirSync(path.join(tmpDir, "logs"), { recursive: true })
  fs.mkdirSync(path.join(tmpDir, "docs"), { recursive: true })
  fs.writeFileSync(path.join(tmpDir, "state", "executions.json"), '{"exec":"data"}')
  fs.writeFileSync(path.join(tmpDir, "logs", "node.jsonl"), '{"node":"bash"}')
  fs.writeFileSync(path.join(tmpDir, "docs", "README.md"), "# Test Workspace")
  return tmpDir
}

function seedWorkspace(db: Database.Database, id: string, wsPath: string, org = "test-org") {
  db.prepare(`
    INSERT INTO workspaces (id, name, org, description, status, path, source, source_schedule_id, created_at, updated_at)
    VALUES (?, ?, ?, null, 'active', ?, 'user', null, datetime('now'), datetime('now'))
  `).run(id, "test-ws", org, wsPath)
}

function seedExecution(db: Database.Database, id: string, wsId: string) {
  db.prepare(`
    INSERT INTO executions (id, workspace_id, org, workflow_ref, workflow_name, status, parent_id, created_at, updated_at)
    VALUES (?, ?, 'test-org', 'test.yaml', 'test-workflow', 'completed', '0', datetime('now'), datetime('now'))
  `).run(id, wsId)
}

function seedNodeExecution(db: Database.Database, id: string, execId: string) {
  db.prepare(`
    INSERT INTO node_executions (id, execution_id, node_id, node_type, status, started_at, completed_at, duration)
    VALUES (?, ?, 'node-1', 'bash', 'completed', datetime('now'), datetime('now'), 100)
  `).run(id, execId)
}

function seedTokenUsage(db: Database.Database, nodeExecId: string) {
  const id = `tu-${nodeExecId}`
  db.prepare(`
    INSERT INTO node_token_usages (id, node_execution_id, model, input_tokens, output_tokens, cost_usd, cache_read_tokens, cache_creation_tokens, created_at)
    VALUES (?, ?, 'sonnet', 100, 50, 0.01, 20, 10, datetime('now'))
  `).run(id, nodeExecId)
}

function seedLlmCall(db: Database.Database, execId: string, nodeExecId: string) {
  const id = `llm-${nodeExecId}`
  db.prepare(`
    INSERT INTO llm_calls (id, node_execution_id, execution_id, turn_index, call_index, timestamp, duration_ms, model, input_tokens, output_tokens, cost_usd, cache_read_tokens, cache_creation_tokens)
    VALUES (?, ?, ?, 0, 0, 1000, 500, 'sonnet', 100, 50, 0.01, 20, 10)
  `).run(id, nodeExecId, execId)
}

function cleanupDir(...dirs: string[]) {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

async function waitForDeletion(dirPath: string, maxMs = 2000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    if (!fs.existsSync(dirPath)) return true
    await new Promise(r => setTimeout(r, 50))
  }
  return !fs.existsSync(dirPath)
}

function expectedArchivePath(org: string, workspaceId: string): string {
  return path.join(os.homedir(), ".octopus", "orgs", org, "archives", workspaceId)
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("Archive Integration (T07)", () => {
  let db: Database.Database
  let archiveDAO: ArchiveDAO
  let executionDAO: ExecutionDAO
  let workspaceDAO: WorkspaceDAO
  let archiveService: ArchiveService
  let workspaceService: WorkspaceService
  const dirsToCleanup: string[] = []

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    archiveDAO = new ArchiveDAO(db)
    executionDAO = new ExecutionDAO(db)
    workspaceDAO = new WorkspaceDAO(db)
    archiveService = new ArchiveService(archiveDAO, executionDAO, db)
    // Init singleton so WorkspaceService.delete() can find it
    initArchiveService(archiveDAO, executionDAO, db)
    workspaceService = new WorkspaceService(workspaceDAO)
  })

  afterEach(() => {
    db?.close()
    cleanupDir(...dirsToCleanup)
    dirsToCleanup.length = 0
  })

  // ── A. Full archive lifecycle (P1.2) ──────────────────────────────────

  describe("A. Full archive lifecycle (P1.2)", () => {
    it("copies files to ~/.octopus/orgs/{org}/archives/{workspace_id}/ with correct structure", async () => {
      const wsPath = createTempWorkspace("integ-full-")
      dirsToCleanup.push(wsPath)
      const wsId = "ws-integ-full"
      const org = "test-org"
      seedWorkspace(db, wsId, wsPath, org)
      seedExecution(db, "exec-full-1", wsId)
      seedNodeExecution(db, "ne-full-1", "exec-full-1")
      seedTokenUsage(db, "ne-full-1")
      seedLlmCall(db, "exec-full-1", "ne-full-1")

      const result = await archiveService.archiveWorkspace(wsId, workspaceDAO, "full")
      expect(result.archived).toBe(true)

      // Verify archive path convention
      const archivePath = expectedArchivePath(org, wsId)
      dirsToCleanup.push(archivePath)

      const wsArchive = archiveDAO.findByWorkspaceId(wsId)
      expect(wsArchive).not.toBeNull()
      expect(wsArchive!.archive_mode).toBe("full")
      expect(wsArchive!.archive_path).toBe(archivePath)

      // Verify files at correct path
      expect(fs.existsSync(path.join(archivePath, "state", "executions.json"))).toBe(true)
      expect(fs.existsSync(path.join(archivePath, "logs", "node.jsonl"))).toBe(true)
      expect(fs.existsSync(path.join(archivePath, "docs", "README.md"))).toBe(true)

      // Verify content preserved
      expect(fs.readFileSync(path.join(archivePath, "state", "executions.json"), "utf-8")).toBe('{"exec":"data"}')
    })
  })

  // ── B. Full archive: workspace root deleted after delete ──────────────

  describe("B. Full archive: workspace root directory deleted", () => {
    it("workspace root directory is deleted after WorkspaceService.delete() with full mode", async () => {
      const wsPath = createTempWorkspace("integ-del-full-")
      dirsToCleanup.push(wsPath)
      const wsId = "ws-integ-del-full"
      const org = "test-org"
      seedWorkspace(db, wsId, wsPath, org)
      seedExecution(db, "exec-del-full", wsId)

      const deleted = await workspaceService.delete(wsId, "full")
      expect(deleted).toBe(true)

      // Wait for async directory deletion
      const wasDeleted = await waitForDeletion(wsPath)
      expect(wasDeleted).toBe(true)

      // Archive directory should still exist with files
      const archivePath = expectedArchivePath(org, wsId)
      dirsToCleanup.push(archivePath)
      expect(fs.existsSync(archivePath)).toBe(true)
      expect(fs.existsSync(path.join(archivePath, "state", "executions.json"))).toBe(true)
    })
  })

  // ── C. Cleanup archive lifecycle ──────────────────────────────────────

  describe("C. Cleanup archive lifecycle", () => {
    it("no archive directory created, DB row has archive_path=null, archive_mode='cleanup'", async () => {
      const wsPath = createTempWorkspace("integ-cleanup-")
      dirsToCleanup.push(wsPath)
      const wsId = "ws-integ-cleanup"
      const org = "test-org"
      seedWorkspace(db, wsId, wsPath, org)
      seedExecution(db, "exec-cleanup-1", wsId)
      seedNodeExecution(db, "ne-cleanup-1", "exec-cleanup-1")
      seedTokenUsage(db, "ne-cleanup-1")

      const result = await archiveService.archiveWorkspace(wsId, workspaceDAO, "cleanup")
      expect(result.archived).toBe(true)

      // No archive directory should exist
      const archivePath = expectedArchivePath(org, wsId)
      expect(fs.existsSync(archivePath)).toBe(false)

      // DB row correct
      const wsArchive = archiveDAO.findByWorkspaceId(wsId)
      expect(wsArchive).not.toBeNull()
      expect(wsArchive!.archive_mode).toBe("cleanup")
      expect(wsArchive!.archive_path).toBeNull()

      // execution_archive should still exist
      const execArchive = archiveDAO.findByExecutionId("exec-cleanup-1")
      expect(execArchive).not.toBeNull()
    })
  })

  // ── D. Cleanup archive: workspace root deleted ────────────────────────

  describe("D. Cleanup archive: workspace root directory deleted", () => {
    it("workspace root directory is deleted after delete with cleanup mode", async () => {
      const wsPath = createTempWorkspace("integ-del-cleanup-")
      dirsToCleanup.push(wsPath)
      const wsId = "ws-integ-del-cleanup"
      const org = "test-org"
      seedWorkspace(db, wsId, wsPath, org)
      seedExecution(db, "exec-del-cleanup", wsId)

      const deleted = await workspaceService.delete(wsId, "cleanup")
      expect(deleted).toBe(true)

      // Wait for async directory deletion
      const wasDeleted = await waitForDeletion(wsPath)
      expect(wasDeleted).toBe(true)

      // No archive directory should exist (cleanup mode)
      const archivePath = expectedArchivePath(org, wsId)
      expect(fs.existsSync(archivePath)).toBe(false)
    })
  })

  // ── E. Degraded archive (file copy failure) ───────────────────────────

  describe("E. Degraded archive", () => {
    it("file copy failure produces archive_path=null, archive_mode='full'", async () => {
      const wsId = "ws-integ-degraded"
      seedWorkspace(db, wsId, "/nonexistent/path/for/degraded/test", "test-org")
      seedExecution(db, "exec-degraded", wsId)
      seedNodeExecution(db, "ne-degraded", "exec-degraded")
      seedTokenUsage(db, "ne-degraded")

      const result = await archiveService.archiveWorkspace(wsId, workspaceDAO, "full")
      expect(result.archived).toBe(true) // Should still succeed

      const wsArchive = archiveDAO.findByWorkspaceId(wsId)
      expect(wsArchive).not.toBeNull()
      expect(wsArchive!.archive_mode).toBe("full")
      expect(wsArchive!.archive_path).toBeNull() // Degraded

      // execution_archive should still exist
      const execArchive = archiveDAO.findByExecutionId("exec-degraded")
      expect(execArchive).not.toBeNull()
    })
  })

  // ── F. Query by archive_mode ──────────────────────────────────────────

  describe("F. Query by archive_mode", () => {
    it("findByArchiveMode returns correct rows filtered by mode", async () => {
      const org = "test-org"

      // Create two workspaces: one full, one cleanup
      const wsPathFull = createTempWorkspace("integ-query-full-")
      dirsToCleanup.push(wsPathFull)
      seedWorkspace(db, "ws-query-full", wsPathFull, org)
      seedExecution(db, "exec-qf", "ws-query-full")

      const wsPathClean = createTempWorkspace("integ-query-clean-")
      dirsToCleanup.push(wsPathClean)
      seedWorkspace(db, "ws-query-clean", wsPathClean, org)
      seedExecution(db, "exec-qc", "ws-query-clean")

      // Archive them with different modes
      await archiveService.archiveWorkspace("ws-query-full", workspaceDAO, "full")
      await archiveService.archiveWorkspace("ws-query-clean", workspaceDAO, "cleanup")

      // Cleanup archive dirs
      const fullArchive = expectedArchivePath(org, "ws-query-full")
      dirsToCleanup.push(fullArchive)

      // Query by mode
      const cleanupRows = archiveDAO.findByArchiveMode(org, "cleanup")
      expect(cleanupRows.length).toBe(1)
      expect(cleanupRows[0].workspace_id).toBe("ws-query-clean")
      expect(cleanupRows[0].archive_mode).toBe("cleanup")
      expect(cleanupRows[0].archive_path).toBeNull()

      const fullRows = archiveDAO.findByArchiveMode(org, "full")
      expect(fullRows.length).toBe(1)
      expect(fullRows[0].workspace_id).toBe("ws-query-full")
      expect(fullRows[0].archive_mode).toBe("full")
      expect(fullRows[0].archive_path).not.toBeNull()
    })

    it("returns empty array when no rows match mode", () => {
      const rows = archiveDAO.findByArchiveMode("nonexistent-org", "cleanup")
      expect(rows).toEqual([])
    })
  })

  // ── G. Archive directory naming collision ─────────────────────────────

  describe("G. Archive directory naming collision", () => {
    it("re-archiving same workspace_id does not crash or duplicate DB row", async () => {
      const wsPath = createTempWorkspace("integ-collision-")
      dirsToCleanup.push(wsPath)
      const wsId = "ws-integ-collision"
      const org = "test-org"
      seedWorkspace(db, wsId, wsPath, org)
      seedExecution(db, "exec-coll-1", wsId)

      // First archive
      const r1 = await archiveService.archiveWorkspace(wsId, workspaceDAO, "full")
      expect(r1.archived).toBe(true)

      const archivePath = expectedArchivePath(org, wsId)
      dirsToCleanup.push(archivePath)

      // Archive directory should exist
      expect(fs.existsSync(archivePath)).toBe(true)

      // Second archive of same workspace_id — INSERT OR IGNORE prevents duplicate
      // Need to reset archive_status first so it can be re-archived
      workspaceDAO.setArchiveStatus(wsId, null)

      const r2 = await archiveService.archiveWorkspace(wsId, workspaceDAO, "full")
      // The workspace_archive row already exists, so INSERT OR IGNORE skips it
      // But the archive call itself should succeed without crash
      expect(r2.archived).toBe(true)

      // Only one row in workspace_archive for this workspace
      const rows = archiveDAO.findByArchiveMode(org, "full")
      const matchingRows = rows.filter(r => r.workspace_id === wsId)
      expect(matchingRows.length).toBe(1)

      // Archive directory still intact
      expect(fs.existsSync(archivePath)).toBe(true)
      expect(fs.existsSync(path.join(archivePath, "state", "executions.json"))).toBe(true)
    })
  })

  // ── H. Scheduler workspace with cleanup mode (full lifecycle) ─────────

  describe("H. Scheduler workspace with cleanup mode (full lifecycle)", () => {
    it("create → execute → archive → delete lifecycle works end-to-end", async () => {
      const wsPath = createTempWorkspace("integ-scheduler-")
      dirsToCleanup.push(wsPath)
      const wsId = "ws-integ-scheduler"
      const org = "test-org"

      // Create workspace in DB
      seedWorkspace(db, wsId, wsPath, org)

      // Seed executions (simulating scheduler runs)
      seedExecution(db, "exec-sched-1", wsId)
      seedNodeExecution(db, "ne-sched-1", "exec-sched-1")
      seedTokenUsage(db, "ne-sched-1")
      seedLlmCall(db, "exec-sched-1", "ne-sched-1")

      seedExecution(db, "exec-sched-2", wsId)
      seedNodeExecution(db, "ne-sched-2", "exec-sched-2")
      seedTokenUsage(db, "ne-sched-2")

      // Archive with cleanup mode
      const archiveResult = await archiveService.archiveWorkspace(wsId, workspaceDAO, "cleanup")
      expect(archiveResult.archived).toBe(true)
      expect(archiveResult.execution_count).toBe(2)

      // Verify no archive directory (cleanup mode)
      const archivePath = expectedArchivePath(org, wsId)
      expect(fs.existsSync(archivePath)).toBe(false)

      // Verify DB rows
      const wsArchive = archiveDAO.findByWorkspaceId(wsId)
      expect(wsArchive).not.toBeNull()
      expect(wsArchive!.archive_mode).toBe("cleanup")
      expect(wsArchive!.archive_path).toBeNull()
      expect(wsArchive!.execution_count).toBe(2)

      // Both executions archived
      expect(archiveDAO.findByExecutionId("exec-sched-1")).not.toBeNull()
      expect(archiveDAO.findByExecutionId("exec-sched-2")).not.toBeNull()

      // Delete workspace
      const deleted = await workspaceService.delete(wsId, "cleanup")
      expect(deleted).toBe(true)

      // Wait for async directory deletion
      const wasDeleted = await waitForDeletion(wsPath)
      expect(wasDeleted).toBe(true)

      // Query cleanup archives should return this workspace
      const cleanupRows = archiveDAO.findByArchiveMode(org, "cleanup")
      expect(cleanupRows.some(r => r.workspace_id === wsId)).toBe(true)
    })
  })
})
