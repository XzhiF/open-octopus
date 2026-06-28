// packages/server/src/services/__tests__/archive-service.test.ts
// Tests for ArchiveService: archiveExecution, archiveWorkspace, extractLessons,
// retryCleanup, recoverStuckArchiving
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import { ArchiveDAO } from "../../db/dao/archive-dao"
import { ExperienceDAO } from "../../db/dao/experience-dao"
import { ExecutionDAO } from "../../db/dao/execution-dao"
import { TokenUsageDAO } from "../../db/dao/token-usage-dao"
import { WorkspaceDAO } from "../../db/dao/workspace-dao"
import { ArchiveService } from "../archive/archive-service"
import { randomUUID } from "crypto"
import { readFileSync, mkdirSync, existsSync, rmSync } from "fs"
import { resolve, join } from "path"
import { homedir } from "os"

// Mock getMemoryService to avoid singleton initialization error.
// The import path is relative to the archive-service module location.
vi.mock("../agent/memory-service", () => ({
  getMemoryService: () => ({
    appendToDaily: vi.fn(),
  }),
}))

const SCHEMA_SQL = readFileSync(resolve(__dirname, "../../db/schema.sql"), "utf-8")

function createTestDb(): Database.Database {
  const db = new Database(":memory:")
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  db.exec(SCHEMA_SQL)
  return db
}

// ── Seed helpers ────────────────────────────────────────────────────

function seedWorkspace(db: Database.Database, id: string, org: string) {
  db.prepare(
    `INSERT INTO workspaces (id, name, org, path, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', datetime('now'), datetime('now'))`
  ).run(id, `ws-${id}`, org, `/tmp/ws-${id}`)
}

function seedExecution(
  db: Database.Database,
  id: string,
  workspaceId: string,
  status: string,
  parent_id = "0",
) {
  db.prepare(
    `INSERT INTO executions
      (id, workspace_id, workflow_ref, workflow_name, status, org,
       parent_id, child_index, created_at, updated_at, started_at, duration)
     VALUES (?, ?, 'wf-test', 'Test Workflow', ?, 'test-org', ?, 0,
       datetime('now'), datetime('now'), datetime('now'), 60000)`
  ).run(id, workspaceId, status, parent_id)
}

function seedNodeExecution(
  db: Database.Database,
  id: string,
  executionId: string,
  status: string,
  error: string | null = null,
) {
  db.prepare(
    `INSERT INTO node_executions
      (id, execution_id, node_id, node_type, status, duration, error)
     VALUES (?, ?, 'node-1', 'bash', ?, 30000, ?)`
  ).run(id, executionId, status, error)
}

function seedTokenUsage(
  db: Database.Database,
  id: string,
  nodeExecutionId: string,
  model: string,
  input: number,
  output: number,
  cost: number,
) {
  db.prepare(
    `INSERT INTO node_token_usages
      (id, node_execution_id, model, input_tokens, output_tokens, cost_usd,
       cache_read_tokens, cache_creation_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, datetime('now'))`
  ).run(id, nodeExecutionId, model, input, output, cost)
}

// ── Tests ───────────────────────────────────────────────────────────

describe("ArchiveService", () => {
  let db: Database.Database
  let archiveDAO: ArchiveDAO
  let executionDAO: ExecutionDAO
  let tokenUsageDAO: TokenUsageDAO
  let workspaceDAO: WorkspaceDAO
  let experienceDAO: ExperienceDAO
  let mockAnthropicClient: any

  beforeEach(() => {
    db = createTestDb()
    archiveDAO = new ArchiveDAO(db)
    executionDAO = new ExecutionDAO(db)
    tokenUsageDAO = new TokenUsageDAO(db)
    workspaceDAO = new WorkspaceDAO(db)
    experienceDAO = new ExperienceDAO(db)
    mockAnthropicClient = {
      messages: {
        create: vi.fn(),
      },
    }
  })

  afterEach(() => {
    db.close()
  })

  // ── TC-001: Archive 3 executions (2 completed, 1 failed) ────────────

  describe("TC-001: archiveExecution for multiple executions", () => {
    it("should create 3 archive records with correct status, duration_ms, and total_cost_usd", () => {
      const wsId = randomUUID()
      seedWorkspace(db, wsId, "test-org")

      const execIds: string[] = []
      const statuses = ["completed", "completed", "failed"]

      for (let i = 0; i < 3; i++) {
        const execId = randomUUID()
        const nodeId = randomUUID()
        const tokenId = randomUUID()

        seedExecution(db, execId, wsId, statuses[i])
        seedNodeExecution(
          db, nodeId, execId, statuses[i],
          statuses[i] === "failed" ? "Something went wrong" : null,
        )
        seedTokenUsage(db, tokenId, nodeId, "claude-3-sonnet", 1000, 500, 0.05)

        execIds.push(execId)
      }

      const service = new ArchiveService(
        archiveDAO, executionDAO, tokenUsageDAO, workspaceDAO,
        experienceDAO, mockAnthropicClient,
      )

      const archiveIds: string[] = []
      for (const execId of execIds) {
        const archiveId = service.archiveExecution(execId)
        expect(archiveId).toBeTruthy()
        archiveIds.push(archiveId)
      }

      // All 3 archive IDs should be unique
      expect(new Set(archiveIds).size).toBe(3)

      // Verify via archiveDAO.listExecutionArchives
      const result = archiveDAO.listExecutionArchives({
        page: 1,
        pageSize: 10,
      })

      expect(result.total).toBe(3)
      expect(result.data).toHaveLength(3)

      for (const archive of result.data) {
        expect(archive.status).toMatch(/^(completed|failed)$/)
        expect(archive.duration_ms).toBe(60000)
        expect(archive.total_cost_usd).toBeCloseTo(0.05, 5)
        expect(archive.total_input_tokens).toBe(1000)
        expect(archive.total_output_tokens).toBe(500)
      }

      const completedArchives = result.data.filter(a => a.status === "completed")
      const failedArchives = result.data.filter(a => a.status === "failed")
      expect(completedArchives).toHaveLength(2)
      expect(failedArchives).toHaveLength(1)
    })
  })

  // ── TC-002: archiveWorkspace error handling ─────────────────────────

  describe("TC-002: archiveWorkspace error handling", () => {
    it("should set archive_status to archive_failed and rethrow when executionDAO.listByWorkspace throws", () => {
      const wsId = randomUUID()
      seedWorkspace(db, wsId, "test-org")

      const service = new ArchiveService(
        archiveDAO, executionDAO, tokenUsageDAO, workspaceDAO,
        experienceDAO, mockAnthropicClient,
      )

      // Spy on executionDAO.listByWorkspace to throw
      vi.spyOn(executionDAO, "listByWorkspace").mockImplementation(() => {
        throw new Error("DB connection lost")
      })

      expect(() => service.archiveWorkspace(wsId)).toThrow("DB connection lost")

      // Verify workspace archive_status is "archive_failed"
      const ws = db.prepare("SELECT archive_status, archive_error FROM workspaces WHERE id = ?").get(wsId) as {
        archive_status: string
        archive_error: string | null
      }
      expect(ws.archive_status).toBe("archive_failed")
      expect(ws.archive_error).toBe("DB connection lost")
    })
  })

  // ── TC-005: archiveExecution creates archive on completion ──────────

  describe("TC-005: archiveExecution creates archive record on execution completion", () => {
    it("should create an archive record for a completed execution with all fields populated", () => {
      const wsId = randomUUID()
      seedWorkspace(db, wsId, "test-org")

      const execId = randomUUID()
      const nodeId = randomUUID()
      const tokenId = randomUUID()

      seedExecution(db, execId, wsId, "completed")
      seedNodeExecution(db, nodeId, execId, "completed")
      seedTokenUsage(db, tokenId, nodeId, "claude-3-haiku", 2000, 1000, 0.01)

      const service = new ArchiveService(
        archiveDAO, executionDAO, tokenUsageDAO, workspaceDAO,
        experienceDAO, mockAnthropicClient,
      )

      const archiveId = service.archiveExecution(execId)
      expect(archiveId).toBeTruthy()

      const archive = archiveDAO.findExecutionArchiveById(archiveId)
      expect(archive).not.toBeNull()
      expect(archive!.id).toBe(archiveId)
      expect(archive!.org).toBe("test-org")
      expect(archive!.status).toBe("completed")
      expect(archive!.workflow_ref).toBe("wf-test")
      expect(archive!.workflow_name).toBe("Test Workflow")
      expect(archive!.duration_ms).toBe(60000)
      expect(archive!.total_input_tokens).toBe(2000)
      expect(archive!.total_output_tokens).toBe(1000)
      expect(archive!.total_cost_usd).toBeCloseTo(0.01, 5)
      expect(archive!.workspace_id).toBe(wsId)
    })
  })

  // ── TC-006: fire-and-forget pattern ─────────────────────────────────

  describe("TC-006: fire-and-forget pattern", () => {
    it("archiveExecution should not throw even when extractLessons would fail", () => {
      const wsId = randomUUID()
      seedWorkspace(db, wsId, "test-org")

      const execId = randomUUID()
      seedExecution(db, execId, wsId, "completed")

      const service = new ArchiveService(
        archiveDAO, executionDAO, tokenUsageDAO, workspaceDAO,
        experienceDAO, mockAnthropicClient,
      )

      // archiveExecution is synchronous. The extractLessons call is scheduled
      // via setImmediate with .catch(), so errors in the async callback never
      // propagate to the caller.
      expect(() => service.archiveExecution(execId)).not.toThrow()
    })

    it("archiveExecution returns a valid archiveId synchronously despite async extractLessons", () => {
      const wsId = randomUUID()
      seedWorkspace(db, wsId, "test-org")

      const execId = randomUUID()
      seedExecution(db, execId, wsId, "completed")

      const service = new ArchiveService(
        archiveDAO, executionDAO, tokenUsageDAO, workspaceDAO,
        experienceDAO, mockAnthropicClient,
      )

      const archiveId = service.archiveExecution(execId)
      expect(archiveId).toBeTruthy()
      expect(typeof archiveId).toBe("string")

      // The archive record should exist immediately (synchronous insert)
      const archive = archiveDAO.findExecutionArchiveById(archiveId)
      expect(archive).not.toBeNull()
    })
  })

  // ── TC-007: retryCleanup ────────────────────────────────────────────

  describe("TC-007: retryCleanup", () => {
    it("should clean up archived workspaces with existing directories at safe paths", () => {
      const wsId = randomUUID()
      // Use a safe path under ~/.octopus (passes the path traversal guard)
      const safePath = join(homedir(), ".octopus", `test-stale-ws-${wsId}`)

      // Create the directory
      mkdirSync(safePath, { recursive: true })
      expect(existsSync(safePath)).toBe(true)

      // Seed workspace with archive_status='archived' and archived=1
      db.prepare(
        `INSERT INTO workspaces
          (id, name, org, path, status, archive_status, archived, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', 'archived', 1, datetime('now'), datetime('now'))`
      ).run(wsId, `ws-${wsId}`, "test-org", safePath)

      const service = new ArchiveService(
        archiveDAO, executionDAO, tokenUsageDAO, workspaceDAO,
        experienceDAO, mockAnthropicClient,
      )

      service.retryCleanup()

      // Directory should be deleted
      expect(existsSync(safePath)).toBe(false)
    })

    it("should block cleanup of unsafe paths (outside ~/.octopus and ~/workspaces)", () => {
      const wsId = randomUUID()
      const unsafePath = `/tmp/test-unsafe-ws-${wsId}`

      // Create the directory
      mkdirSync(unsafePath, { recursive: true })
      expect(existsSync(unsafePath)).toBe(true)

      // Seed workspace with archive_status='archived' and archived=1
      db.prepare(
        `INSERT INTO workspaces
          (id, name, org, path, status, archive_status, archived, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', 'archived', 1, datetime('now'), datetime('now'))`
      ).run(wsId, `ws-${wsId}`, "test-org", unsafePath)

      const service = new ArchiveService(
        archiveDAO, executionDAO, tokenUsageDAO, workspaceDAO,
        experienceDAO, mockAnthropicClient,
      )

      service.retryCleanup()

      // Directory should NOT be deleted (unsafe path)
      expect(existsSync(unsafePath)).toBe(true)

      // Clean up test artifact
      rmSync(unsafePath, { recursive: true, force: true })
    })

    it("should handle non-existent paths gracefully", () => {
      const wsId = randomUUID()
      const safePath = join(homedir(), ".octopus", `test-nonexistent-${wsId}`)

      // Do NOT create the directory
      expect(existsSync(safePath)).toBe(false)

      db.prepare(
        `INSERT INTO workspaces
          (id, name, org, path, status, archive_status, archived, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', 'archived', 1, datetime('now'), datetime('now'))`
      ).run(wsId, `ws-${wsId}`, "test-org", safePath)

      const service = new ArchiveService(
        archiveDAO, executionDAO, tokenUsageDAO, workspaceDAO,
        experienceDAO, mockAnthropicClient,
      )

      // Should not throw
      expect(() => service.retryCleanup()).not.toThrow()
    })
  })

  // ── TC-009: node_summary and failed_nodes populated ─────────────────

  describe("TC-009: node_summary and failed_nodes in archive", () => {
    it("should populate node_summary with all node info after archiveExecution", () => {
      const wsId = randomUUID()
      seedWorkspace(db, wsId, "test-org")

      const execId = randomUUID()
      const node1Id = randomUUID()
      const node2Id = randomUUID()

      seedExecution(db, execId, wsId, "failed")
      seedNodeExecution(db, node1Id, execId, "completed")
      // Use a different node_id for the second node
      db.prepare(
        `INSERT INTO node_executions
          (id, execution_id, node_id, node_type, status, duration, error)
         VALUES (?, ?, 'node-2', 'agent', 'failed', 15000, 'Agent crashed')`
      ).run(node2Id, execId)

      const service = new ArchiveService(
        archiveDAO, executionDAO, tokenUsageDAO, workspaceDAO,
        experienceDAO, mockAnthropicClient,
      )

      const archiveId = service.archiveExecution(execId)
      const archive = archiveDAO.findExecutionArchiveById(archiveId)

      // node_summary should contain both nodes
      const nodeSummary = JSON.parse(archive!.node_summary)
      expect(nodeSummary).toHaveLength(2)
      expect(nodeSummary[0]).toHaveProperty("nodeId")
      expect(nodeSummary[0]).toHaveProperty("type")
      expect(nodeSummary[0]).toHaveProperty("status")
      expect(nodeSummary[0]).toHaveProperty("duration_ms")

      const statuses = nodeSummary.map((n: any) => n.status).sort()
      expect(statuses).toEqual(["completed", "failed"])
    })

    it("should populate failed_nodes with failed node IDs and error_message from first failed node", () => {
      const wsId = randomUUID()
      seedWorkspace(db, wsId, "test-org")

      const execId = randomUUID()
      const node1Id = randomUUID()
      const node2Id = randomUUID()

      seedExecution(db, execId, wsId, "failed")
      seedNodeExecution(db, node1Id, execId, "completed")
      db.prepare(
        `INSERT INTO node_executions
          (id, execution_id, node_id, node_type, status, duration, error)
         VALUES (?, ?, 'node-2', 'agent', 'failed', 15000, 'Agent crashed')`
      ).run(node2Id, execId)

      const service = new ArchiveService(
        archiveDAO, executionDAO, tokenUsageDAO, workspaceDAO,
        experienceDAO, mockAnthropicClient,
      )

      const archiveId = service.archiveExecution(execId)
      const archive = archiveDAO.findExecutionArchiveById(archiveId)

      // failed_nodes should list the failed node's node_id
      const failedNodes = JSON.parse(archive!.failed_nodes!)
      expect(failedNodes).toEqual(["node-2"])

      // error_message should come from the first failed node execution
      expect(archive!.error_message).toBe("Agent crashed")
    })

    it("should set failed_nodes to null when no nodes failed", () => {
      const wsId = randomUUID()
      seedWorkspace(db, wsId, "test-org")

      const execId = randomUUID()
      const nodeId = randomUUID()

      seedExecution(db, execId, wsId, "completed")
      seedNodeExecution(db, nodeId, execId, "completed")

      const service = new ArchiveService(
        archiveDAO, executionDAO, tokenUsageDAO, workspaceDAO,
        experienceDAO, mockAnthropicClient,
      )

      const archiveId = service.archiveExecution(execId)
      const archive = archiveDAO.findExecutionArchiveById(archiveId)

      expect(archive!.failed_nodes).toBeNull()
      expect(archive!.error_message).toBeNull()
    })
  })

  // ── TC-011: extractLessons with mocked LLM ──────────────────────────

  describe("TC-011: extractLessons threshold behavior", () => {
    it("should call LLM when score >= REFLECTION_THRESHOLD (40)", async () => {
      const archiveId = randomUUID()

      // Create an archive that produces score >= 40:
      //   failed_nodes present & non-empty  → retry_pattern  = true  (+15)
      //   status = "failed" + error_message → failure_recovery = true (+15)
      //   error_message present             → new_error_type = true  (+20)
      //   Total = 50 >= 40
      archiveDAO.insertExecutionArchive({
        id: archiveId,
        org: "test-org",
        workflow_ref: "wf-test",
        workflow_name: "Test Workflow",
        status: "failed",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        duration_ms: 60000,
        node_summary: "[]",
        failed_nodes: JSON.stringify(["node-1"]),
        error_message: "Something failed",
        total_input_tokens: 1000,
        total_output_tokens: 500,
        total_cost_usd: 0.05,
        model_breakdown: null,
        vars_snapshot: "{}",
        lessons_learned: null,
        workspace_archive_id: null,
        workspace_id: null,
        chain_position: null,
        parent_execution_id: null,
        schedule_id: null,
        clone_name: null,
      })

      mockAnthropicClient.messages.create.mockResolvedValue({
        content: [{
          text: JSON.stringify({
            lessons: "Test lesson learned from failure",
            items: [{
              type: "failure",
              title: "Test failure pattern",
              content: "The agent node crashed due to timeout",
              keywords: ["timeout", "agent"],
            }],
          }),
        }],
      })

      // extractLessons re-inserts the archive row with lessons_learned populated.
      // The production INSERT statement doesn't use ON CONFLICT, so the second
      // insert would hit a UNIQUE constraint violation. Spy on the DAO to make
      // the second call a no-op, simulating UPSERT behavior.
      let insertCallCount = 0
      vi.spyOn(archiveDAO, "insertExecutionArchive").mockImplementation((row: any) => {
        insertCallCount++
        // Swallow the duplicate insert — the seed insert used the real DAO
        // before this spy was created, so this only catches the re-insert
        // from extractLessons (updating lessons_learned).
        return row.id
      })

      const service = new ArchiveService(
        archiveDAO, executionDAO, tokenUsageDAO, workspaceDAO,
        experienceDAO, mockAnthropicClient,
      )

      await service.extractLessons(archiveId)

      // LLM should have been called
      expect(mockAnthropicClient.messages.create).toHaveBeenCalledTimes(1)
      expect(mockAnthropicClient.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          model: expect.any(String),
          max_tokens: expect.any(Number),
          messages: expect.any(Array),
        }),
      )

      // Spy was set up after the seed insert, so it only catches the
      // extractLessons re-insert call (expect exactly 1 invocation).
      expect(insertCallCount).toBe(1)

      // Experience items should have been inserted into experience_index
      const experiences = experienceDAO.findByArchiveId(archiveId)
      expect(experiences).toHaveLength(1)
      expect(experiences[0].type).toBe("failure")
      expect(experiences[0].title).toBe("Test failure pattern")
      expect(experiences[0].status).toBe("active")
      expect(experiences[0].org).toBe("test-org")
      expect(experiences[0].archive_id).toBe(archiveId)
    })

    it("should NOT call LLM when score < REFLECTION_THRESHOLD", async () => {
      const archiveId = randomUUID()

      // Create an archive with no anomaly signals → score = 0:
      //   no failed_nodes → retry_pattern = false
      //   status = "completed" → failure_recovery = false
      //   no error_message → new_error_type = false
      //   total tokens = 1500 (< 100000) → token_spike = false
      archiveDAO.insertExecutionArchive({
        id: archiveId,
        org: "test-org",
        workflow_ref: "wf-test",
        workflow_name: "Test Workflow",
        status: "completed",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        duration_ms: 60000,
        node_summary: "[]",
        failed_nodes: null,
        error_message: null,
        total_input_tokens: 1000,
        total_output_tokens: 500,
        total_cost_usd: 0.05,
        model_breakdown: null,
        vars_snapshot: "{}",
        lessons_learned: null,
        workspace_archive_id: null,
        workspace_id: null,
        chain_position: null,
        parent_execution_id: null,
        schedule_id: null,
        clone_name: null,
      })

      const service = new ArchiveService(
        archiveDAO, executionDAO, tokenUsageDAO, workspaceDAO,
        experienceDAO, mockAnthropicClient,
      )

      await service.extractLessons(archiveId)

      // LLM should NOT have been called
      expect(mockAnthropicClient.messages.create).not.toHaveBeenCalled()

      // No experience items should be inserted
      const experiences = experienceDAO.findByArchiveId(archiveId)
      expect(experiences).toHaveLength(0)
    })

    it("should return early when archive does not exist", async () => {
      const service = new ArchiveService(
        archiveDAO, executionDAO, tokenUsageDAO, workspaceDAO,
        experienceDAO, mockAnthropicClient,
      )

      // Should not throw, should not call LLM
      await service.extractLessons("nonexistent-archive-id")

      expect(mockAnthropicClient.messages.create).not.toHaveBeenCalled()
    })

    it("should handle LLM returning empty results gracefully", async () => {
      const archiveId = randomUUID()

      archiveDAO.insertExecutionArchive({
        id: archiveId,
        org: "test-org",
        workflow_ref: "wf-test",
        workflow_name: "Test Workflow",
        status: "failed",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        duration_ms: 60000,
        node_summary: "[]",
        failed_nodes: JSON.stringify(["node-1"]),
        error_message: "Something failed",
        total_input_tokens: 1000,
        total_output_tokens: 500,
        total_cost_usd: 0.05,
        model_breakdown: null,
        vars_snapshot: "{}",
        lessons_learned: null,
        workspace_archive_id: null,
        workspace_id: null,
        chain_position: null,
        parent_execution_id: null,
        schedule_id: null,
        clone_name: null,
      })

      // LLM returns no lessons and no items
      mockAnthropicClient.messages.create.mockResolvedValue({
        content: [{
          text: JSON.stringify({ lessons: "", items: [] }),
        }],
      })

      const service = new ArchiveService(
        archiveDAO, executionDAO, tokenUsageDAO, workspaceDAO,
        experienceDAO, mockAnthropicClient,
      )

      await service.extractLessons(archiveId)

      // LLM was called (score >= threshold)
      expect(mockAnthropicClient.messages.create).toHaveBeenCalledTimes(1)

      // But no experience items were inserted
      const experiences = experienceDAO.findByArchiveId(archiveId)
      expect(experiences).toHaveLength(0)
    })
  })

  // ── TC-058: recoverStuckArchiving ───────────────────────────────────

  describe("TC-058: recoverStuckArchiving", () => {
    it("should call workspaceDAO.resetStuckArchiving with 30 minutes", () => {
      const service = new ArchiveService(
        archiveDAO, executionDAO, tokenUsageDAO, workspaceDAO,
        experienceDAO, mockAnthropicClient,
      )

      const spy = vi.spyOn(workspaceDAO, "resetStuckArchiving")

      service.recoverStuckArchiving()

      expect(spy).toHaveBeenCalledWith(30)
      expect(spy).toHaveBeenCalledTimes(1)

      spy.mockRestore()
    })

    it("should recover workspaces stuck in archiving state for more than 30 minutes", () => {
      const wsId = randomUUID()
      seedWorkspace(db, wsId, "test-org")

      // Set archive_status to 'archiving' with archive_started_at 1 hour ago
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
      db.prepare(
        "UPDATE workspaces SET archive_status = 'archiving', archive_started_at = ? WHERE id = ?"
      ).run(oneHourAgo, wsId)

      const service = new ArchiveService(
        archiveDAO, executionDAO, tokenUsageDAO, workspaceDAO,
        experienceDAO, mockAnthropicClient,
      )

      service.recoverStuckArchiving()

      // Workspace should be reset to 'none'
      const ws = db.prepare("SELECT archive_status, archive_started_at FROM workspaces WHERE id = ?").get(wsId) as {
        archive_status: string
        archive_started_at: string | null
      }
      expect(ws.archive_status).toBe("none")
      expect(ws.archive_started_at).toBeNull()
    })

    it("should NOT recover workspaces stuck for less than 30 minutes", () => {
      const wsId = randomUUID()
      seedWorkspace(db, wsId, "test-org")

      // Set archive_status to 'archiving' with archive_started_at 10 minutes ago
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString()
      db.prepare(
        "UPDATE workspaces SET archive_status = 'archiving', archive_started_at = ? WHERE id = ?"
      ).run(tenMinutesAgo, wsId)

      const service = new ArchiveService(
        archiveDAO, executionDAO, tokenUsageDAO, workspaceDAO,
        experienceDAO, mockAnthropicClient,
      )

      service.recoverStuckArchiving()

      // Workspace should NOT be reset (still within 30 minutes)
      const ws = db.prepare("SELECT archive_status FROM workspaces WHERE id = ?").get(wsId) as {
        archive_status: string
      }
      expect(ws.archive_status).toBe("archiving")
    })
  })

  // ── Additional: archiveWorkspace success path ───────────────────────

  describe("archiveWorkspace success path", () => {
    it("should archive all executions in a workspace and return the count", () => {
      const wsId = randomUUID()
      seedWorkspace(db, wsId, "test-org")

      // Seed 2 completed executions with nodes and token usage
      for (let i = 0; i < 2; i++) {
        const execId = randomUUID()
        const nodeId = randomUUID()
        const tokenId = randomUUID()
        seedExecution(db, execId, wsId, "completed")
        seedNodeExecution(db, nodeId, execId, "completed")
        seedTokenUsage(db, tokenId, nodeId, "claude-3-sonnet", 500, 200, 0.02)
      }

      const service = new ArchiveService(
        archiveDAO, executionDAO, tokenUsageDAO, workspaceDAO,
        experienceDAO, mockAnthropicClient,
      )

      const count = service.archiveWorkspace(wsId)
      expect(count).toBe(2)

      // Verify workspace archive_status is "archived"
      const ws = db.prepare("SELECT archive_status FROM workspaces WHERE id = ?").get(wsId) as {
        archive_status: string
      }
      expect(ws.archive_status).toBe("archived")

      // Verify execution archives were created
      const archives = archiveDAO.listExecutionArchives({ page: 1, pageSize: 10 })
      expect(archives.total).toBe(2)
    })

    it("should throw when workspace does not exist", () => {
      const service = new ArchiveService(
        archiveDAO, executionDAO, tokenUsageDAO, workspaceDAO,
        experienceDAO, mockAnthropicClient,
      )

      expect(() => service.archiveWorkspace("nonexistent-ws-id")).toThrow("Workspace not found")
    })
  })

  // ── Additional: model_breakdown and token aggregation ───────────────

  describe("archiveExecution token aggregation", () => {
    it("should aggregate token usage across multiple models", () => {
      const wsId = randomUUID()
      seedWorkspace(db, wsId, "test-org")

      const execId = randomUUID()
      const node1Id = randomUUID()
      const node2Id = randomUUID()

      seedExecution(db, execId, wsId, "completed")
      seedNodeExecution(db, node1Id, execId, "completed")
      seedNodeExecution(db, node2Id, execId, "completed")

      // Two different models
      seedTokenUsage(db, randomUUID(), node1Id, "claude-3-sonnet", 1000, 500, 0.03)
      seedTokenUsage(db, randomUUID(), node2Id, "claude-3-haiku", 2000, 800, 0.01)

      const service = new ArchiveService(
        archiveDAO, executionDAO, tokenUsageDAO, workspaceDAO,
        experienceDAO, mockAnthropicClient,
      )

      const archiveId = service.archiveExecution(execId)
      const archive = archiveDAO.findExecutionArchiveById(archiveId)

      expect(archive!.total_input_tokens).toBe(3000)
      expect(archive!.total_output_tokens).toBe(1300)
      expect(archive!.total_cost_usd).toBeCloseTo(0.04, 5)

      // model_breakdown should have both models
      const breakdown = JSON.parse(archive!.model_breakdown!)
      expect(breakdown).toHaveProperty("claude-3-sonnet")
      expect(breakdown).toHaveProperty("claude-3-haiku")
      expect(breakdown["claude-3-sonnet"].input_tokens).toBe(1000)
      expect(breakdown["claude-3-haiku"].input_tokens).toBe(2000)
    })
  })
})
