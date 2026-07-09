import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../../../db/schema"
import { ArchiveDAO } from "../../../db/dao/archive-dao"
import { ExecutionDAO } from "../../../db/dao/execution-dao"
import { WorkspaceDAO } from "../../../db/dao/workspace-dao"
import { ArchiveService, ArchivePartialFailure } from "../archive-service"

function seedWorkspace(db: Database.Database, id: string, name = "test-ws") {
  db.prepare(`
    INSERT INTO workspaces (id, name, org, description, status, path, source, source_schedule_id, created_at, updated_at)
    VALUES (?, ?, 'test-org', null, 'active', '/tmp/test', 'user', null, datetime('now'), datetime('now'))
  `).run(id, name)
}

function seedExecution(db: Database.Database, id: string, wsId: string, status = "completed") {
  db.prepare(`
    INSERT INTO executions (id, workspace_id, org, workflow_ref, workflow_name, status, parent_id, created_at, updated_at)
    VALUES (?, ?, 'test-org', 'test.yaml', 'test-workflow', ?, '0', datetime('now'), datetime('now'))
  `).run(id, wsId, status)
}

function seedNodeExecution(db: Database.Database, id: string, execId: string, status = "completed") {
  db.prepare(`
    INSERT INTO node_executions (id, execution_id, node_id, node_type, status, started_at, completed_at, duration)
    VALUES (?, ?, 'node-1', 'bash', ?, datetime('now'), datetime('now'), 100)
  `).run(id, execId, status)
}

function seedLlmCall(db: Database.Database, execId: string, nodeExecId: string, model = "sonnet") {
  const id = `llm-${nodeExecId}-${model}`
  db.prepare(`
    INSERT INTO llm_calls (id, node_execution_id, execution_id, turn_index, call_index, timestamp, duration_ms, model, input_tokens, output_tokens, cost_usd, cache_read_tokens, cache_creation_tokens)
    VALUES (?, ?, ?, 0, 0, 1000, 500, ?, 100, 50, 0.01, 20, 10)
  `).run(id, nodeExecId, execId, model)
}

function seedTokenUsage(db: Database.Database, nodeExecId: string, model = "sonnet") {
  const id = `tu-${nodeExecId}-${model}`
  db.prepare(`
    INSERT INTO node_token_usages (id, node_execution_id, model, input_tokens, output_tokens, cost_usd, cache_read_tokens, cache_creation_tokens, created_at)
    VALUES (?, ?, ?, 100, 50, 0.01, 20, 10, datetime('now'))
  `).run(id, nodeExecId, model)
}

describe("ArchiveService", () => {
  let db: Database.Database
  let archiveDAO: ArchiveDAO
  let executionDAO: ExecutionDAO
  let workspaceDAO: WorkspaceDAO
  let service: ArchiveService

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    archiveDAO = new ArchiveDAO(db)
    executionDAO = new ExecutionDAO(db)
    workspaceDAO = new WorkspaceDAO(db)
    service = new ArchiveService(archiveDAO, executionDAO, db)
  })

  afterEach(() => {
    db?.close()
  })

  // ── archiveExecution ──────────────────────────────────────────────

  describe("archiveExecution", () => {
    it("archives an execution with aggregated metrics", async () => {
      seedWorkspace(db, "ws-1")
      seedExecution(db, "exec-1", "ws-1")
      seedNodeExecution(db, "ne-1", "exec-1", "completed")
      seedNodeExecution(db, "ne-2", "exec-1", "failed")
      seedLlmCall(db, "exec-1", "ne-1", "sonnet")
      seedLlmCall(db, "exec-1", "ne-2", "opus")
      seedTokenUsage(db, "ne-1", "sonnet")

      const result = await service.archiveExecution("exec-1")
      expect(result.archived).toBe(true)

      const row = archiveDAO.findByExecutionId("exec-1")
      expect(row).not.toBeNull()
      expect(row!.workspace_id).toBe("ws-1")
      expect(row!.node_count).toBe(2)
      expect(row!.success_rate).toBe(0.5)
      expect(row!.total_cost).toBeCloseTo(0.02)

      const modelBreakdown = JSON.parse(row!.model_breakdown!)
      expect(modelBreakdown["sonnet"]).toBeDefined()
      expect(modelBreakdown["opus"]).toBeDefined()
    })

    it("returns not_found for nonexistent execution", async () => {
      const result = await service.archiveExecution("no-such-id")
      expect(result.archived).toBe(false)
      expect(result.reason).toBe("execution_not_found")
    })

    it("is idempotent — second call succeeds without duplicate", async () => {
      seedWorkspace(db, "ws-1")
      seedExecution(db, "exec-1", "ws-1")

      const r1 = await service.archiveExecution("exec-1")
      expect(r1.archived).toBe(true)

      const r2 = await service.archiveExecution("exec-1")
      expect(r2.archived).toBe(false) // duplicate detected
      expect(r2.reason).toBe("already_archived")

      expect(archiveDAO.countByWorkspace("ws-1")).toBe(1)
    })

    it("handles execution with no nodes", async () => {
      seedWorkspace(db, "ws-1")
      seedExecution(db, "exec-1", "ws-1")

      const result = await service.archiveExecution("exec-1")
      expect(result.archived).toBe(true)

      const row = archiveDAO.findByExecutionId("exec-1")
      expect(row!.node_count).toBe(0)
      expect(row!.success_rate).toBe(0)
    })

    it("captures chain info (parent/children)", async () => {
      seedWorkspace(db, "ws-1")
      seedExecution(db, "parent-1", "ws-1")
      // Manually insert a child with parent_id
      db.prepare(`
        INSERT INTO executions (id, workspace_id, org, workflow_ref, workflow_name, status, parent_id, created_at, updated_at)
        VALUES ('child-1', 'ws-1', 'test-org', 'test.yaml', 'test-workflow', 'completed', 'parent-1', datetime('now'), datetime('now'))
      `).run()

      const result = await service.archiveExecution("parent-1")
      expect(result.archived).toBe(true)

      const row = archiveDAO.findByExecutionId("parent-1")
      const chainInfo = JSON.parse(row!.chain_info!)
      expect(chainInfo.child_execution_ids).toContain("child-1")
      expect(chainInfo.parent_execution_id).toBeNull() // parent_id='0' → null
    })
  })

  // ── archiveWorkspace ──────────────────────────────────────────────

  describe("archiveWorkspace", () => {
    it("archives workspace with all executions in a transaction", async () => {
      seedWorkspace(db, "ws-1")
      seedExecution(db, "exec-1", "ws-1")
      seedExecution(db, "exec-2", "ws-1")
      seedNodeExecution(db, "ne-1", "exec-1")
      seedLlmCall(db, "exec-1", "ne-1")

      const result = await service.archiveWorkspace("ws-1", "test-org", {
        extractExperiences: [],
        installSkills: [],
      })
      expect(result.success).toBe(true)
      expect(result.archivedExecutions).toBe(2)

      // Both executions archived
      expect(archiveDAO.findByExecutionId("exec-1")).not.toBeNull()
      expect(archiveDAO.findByExecutionId("exec-2")).not.toBeNull()

      // Workspace archive row exists
      const wsArchive = archiveDAO.findByWorkspaceId("ws-1")
      expect(wsArchive).not.toBeNull()
      expect(wsArchive!.execution_count).toBe(2)

      // Archive status set to 'archived'
      const ws = workspaceDAO.findById("ws-1")
      expect(ws!.archive_status).toBe("archived")
    })

    it("returns not found for nonexistent workspace", async () => {
      const result = await service.archiveWorkspace("no-such-ws", "test-org", {
        extractExperiences: [],
        installSkills: [],
      })
      expect(result.success).toBe(false)
      expect(result.archivedExecutions).toBe(0)
      expect(result.error).toBe("workspace_not_found")
    })

    it("handles empty workspace (no executions)", async () => {
      seedWorkspace(db, "ws-1")

      const result = await service.archiveWorkspace("ws-1", "test-org", {
        extractExperiences: [],
        installSkills: [],
      })
      expect(result.success).toBe(true)
      expect(result.archivedExecutions).toBe(0)

      const wsArchive = archiveDAO.findByWorkspaceId("ws-1")
      expect(wsArchive).not.toBeNull()
      expect(wsArchive!.execution_count).toBe(0)
      expect(wsArchive!.total_cost).toBe(0)
    })

    it("sets archive_status to 'archive_failed' on failure rollback", async () => {
      seedWorkspace(db, "ws-1")
      seedExecution(db, "exec-1", "ws-1")

      // Corrupt: delete the execution_archive table to force insert failure
      db.exec("DROP TABLE IF EXISTS execution_archive")

      const result = await service.archiveWorkspace("ws-1", "test-org", {
        extractExperiences: [],
        installSkills: [],
      })

      // Should fail but not throw
      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
    })

    it("rolls back on partial failure (ArchivePartialFailure)", async () => {
      seedWorkspace(db, "ws-1")
      seedExecution(db, "exec-1", "ws-1")
      seedExecution(db, "exec-2", "ws-1")

      // Create a service with a mock executionDAO that fails on exec-2
      const failingExecDAO = new ExecutionDAO(db)
      const origFindById = failingExecDAO.findById.bind(failingExecDAO)
      let callCount = 0
      failingExecDAO.findById = (id: string) => {
        callCount++
        if (id === "exec-2") throw new Error("simulated read failure")
        return origFindById(id)
      }

      const failService = new ArchiveService(archiveDAO, failingExecDAO, db)

      const result = await failService.archiveWorkspace("ws-1", "test-org", {
        extractExperiences: [],
        installSkills: [],
      })

      // Should fail but not throw
      expect(result.success).toBe(false)

      // Transaction rolled back — no archive rows
      expect(archiveDAO.findByExecutionId("exec-1")).toBeNull()
      expect(archiveDAO.findByWorkspaceId("ws-1")).toBeNull()

      // archive_status set to 'archive_failed' post-rollback
      const ws = workspaceDAO.findById("ws-1")
      expect(ws!.archive_status).toBe("archive_failed")
    })
  })
})
