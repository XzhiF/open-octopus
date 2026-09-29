import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../../../db/schema"
import { ArchiveDAO } from "../../../db/dao/archive-dao"
import { ExecutionDAO } from "../../../db/dao/execution-dao"
import { WorkspaceDAO } from "../../../db/dao/workspace-dao"
import { ArchiveService, ArchivePartialFailure, initArchiveService } from "../archive-service"
import { WorkspaceService } from "../../workspace"

function seedWorkspace(db: Database.Database, id: string, name = "test-ws", wsPath = "/tmp/test") {
  db.prepare(`
    INSERT INTO workspaces (id, name, org, description, status, path, source, source_schedule_id, created_at, updated_at)
    VALUES (?, ?, 'test-org', null, 'active', ?, 'user', null, datetime('now'), datetime('now'))
  `).run(id, name, wsPath)
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

// v48（billing NEW-r2）：llm_calls / node_token_usages 的 cost_usd 物理列已删，
// 钱由 llm_calls_costed 视图按 billing_price_config 现算 —— seed 只记事实列。
function seedLlmCall(db: Database.Database, execId: string, nodeExecId: string, model = "sonnet") {
  const id = `llm-${nodeExecId}-${model}`
  db.prepare(`
    INSERT INTO llm_calls (id, node_execution_id, execution_id, turn_index, call_index, timestamp, duration_ms, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
    VALUES (?, ?, ?, 0, 0, 1000, 500, ?, 100, 50, 20, 10)
  `).run(id, nodeExecId, execId, model)
}

function seedTokenUsage(db: Database.Database, nodeExecId: string, model = "sonnet") {
  const id = `tu-${nodeExecId}-${model}`
  db.prepare(`
    INSERT INTO node_token_usages (id, node_execution_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at)
    VALUES (?, ?, ?, 100, 50, 20, 10, datetime('now'))
  `).run(id, nodeExecId, model)
}

// input_unit_price=100/Mtok + 其余 0 → 每次 call 派生 cost = 100×100/1e6 = 0.01
function seedPrice(db: Database.Database, model: string) {
  db.prepare(`
    INSERT INTO billing_price_config (id, vendor, model_id, input_unit_price, output_unit_price,
      cache_write_unit_price, cache_read_unit_price, currency, valid_from, valid_to, created_at, updated_at)
    VALUES (?, 'v', ?, 100, 0, 0, 0, 'USD', NULL, NULL, datetime('now'), datetime('now'))
  `).run(`p-${model}`, model)
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
      seedTokenUsage(db, "ne-2", "opus")
      seedPrice(db, "sonnet")
      seedPrice(db, "opus")

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
      expect(row!.total_cost).toBeNull() // 全未定价 → NULL，不焊 0
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

  // ── archiveWorkspaceForDelete — 删除路径专用事务版（抛错，不吞） ────

  describe("archiveWorkspaceForDelete", () => {
    it("archives workspace with all executions in a transaction", async () => {
      seedWorkspace(db, "ws-1")
      seedExecution(db, "exec-1", "ws-1")
      seedExecution(db, "exec-2", "ws-1")
      seedNodeExecution(db, "ne-1", "exec-1")
      seedLlmCall(db, "exec-1", "ne-1")

      const result = await service.archiveWorkspaceForDelete("ws-1", workspaceDAO)
      expect(result.archived).toBe(true)
      expect(result.execution_count).toBe(2)

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

    it("rolls back on partial failure and PRESERVES source data (never returns success)", async () => {
      seedWorkspace(db, "ws-1")
      seedExecution(db, "exec-1", "ws-1")
      seedExecution(db, "exec-2", "ws-1")

      // Mock executionDAO that fails on exec-2
      const failingExecDAO = new ExecutionDAO(db)
      const origFindById = failingExecDAO.findById.bind(failingExecDAO)
      failingExecDAO.findById = (id: string) => {
        if (id === "exec-2") throw new Error("simulated read failure")
        return origFindById(id)
      }

      const failService = new ArchiveService(archiveDAO, failingExecDAO, db)

      // 事务版必须抛错（而不是吞成 {success:false}）—— 调用方靠异常中止删除
      await expect(failService.archiveWorkspaceForDelete("ws-1", workspaceDAO))
        .rejects.toBeInstanceOf(ArchivePartialFailure)

      // Transaction rolled back — no archive rows
      expect(archiveDAO.findByExecutionId("exec-1")).toBeNull()
      expect(archiveDAO.findByWorkspaceId("ws-1")).toBeNull()

      // 源数据完好 —— 「归档失败 → 不删数据」不变量的服务层锚点
      expect(executionDAO.findById("exec-1")).toBeDefined()
      expect(executionDAO.findById("exec-2")).toBeDefined()

      // archive_status set to 'archive_failed' post-rollback
      const ws = workspaceDAO.findById("ws-1")
      expect(ws!.archive_status).toBe("archive_failed")
    })

    it("throws instead of silent {archived:false} when workspace is missing", async () => {
      await expect(service.archiveWorkspaceForDelete("no-such-ws", workspaceDAO))
        .rejects.toThrow(/workspace_not_found/)
    })
  })

  // ── 删除不变量：WorkspaceService.delete 在归档失败时不得级联删除 ────

  describe("delete invariant — 归档失败 → 不删数据", () => {
    afterEach(() => {
      // 还原单例，避免污染其他用例
      initArchiveService(archiveDAO, executionDAO, db)
    })

    it("WorkspaceService.delete throws and keeps workspace rows + directory when archive fails", async () => {
      const fs = await import("fs")
      const os = await import("os")
      const path = await import("path")
      const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "octopus-ws-keep-"))

      seedWorkspace(db, "ws-1", "keep-me", wsDir)
      seedExecution(db, "exec-1", "ws-1")
      seedExecution(db, "exec-2", "ws-1")

      const failingExecDAO = new ExecutionDAO(db)
      const origFindById = failingExecDAO.findById.bind(failingExecDAO)
      failingExecDAO.findById = (id: string) => {
        if (id === "exec-2") throw new Error("simulated read failure")
        return origFindById(id)
      }
      initArchiveService(archiveDAO, failingExecDAO, db)

      const wsService = new WorkspaceService(workspaceDAO)
      await expect(wsService.delete("ws-1")).rejects.toThrow(/Archive partial failure/)

      // 级联删除未发生：workspaces / executions 行仍在
      expect(workspaceDAO.findById("ws-1")).toBeDefined()
      const execCount = (db.prepare("SELECT COUNT(*) as c FROM executions WHERE workspace_id = ?").get("ws-1") as { c: number }).c
      expect(execCount).toBe(2)

      // 物理目录未被删除
      expect(fs.existsSync(wsDir)).toBe(true)

      fs.rmSync(wsDir, { recursive: true, force: true })
    })
  })

  // ── archiveWorkspace — 对外全功能入口（4 参，吞错但返回 success 标志）──

  describe("archiveWorkspace (full entry)", () => {
    it("archives workspace with all executions", async () => {
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

      const wsArchive = archiveDAO.findByWorkspaceId("ws-1")
      expect(wsArchive).not.toBeNull()
      expect(wsArchive!.execution_count).toBe(2)
    })

    it("returns success:false for nonexistent workspace", async () => {
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
    })

    it("returns success:false (not a throw) when persistence fails", async () => {
      seedWorkspace(db, "ws-1")
      seedExecution(db, "exec-1", "ws-1")

      // Corrupt: delete the workspace_archive table to force insert failure
      db.exec("DROP TABLE IF EXISTS workspace_archive")

      const result = await service.archiveWorkspace("ws-1", "test-org", {
        extractExperiences: [],
        installSkills: [],
      })

      // Should fail but not throw
      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
    })
  })
})
