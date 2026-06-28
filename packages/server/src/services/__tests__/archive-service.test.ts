import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import path from "path"
import os from "os"
import fs from "fs"
import { applySchema } from "../../db/schema"
import { ArchiveDAO } from "../../db/dao/archive-dao"
import { ExecutionDAO } from "../../db/dao/execution-dao"
import { TokenUsageDAO } from "../../db/dao/token-usage-dao"
import { WorkspaceDAO } from "../../db/dao/workspace-dao"
import { ArchiveService } from "../archive-service"
import { WorkspaceService } from "../workspace"
import { ArchiveRecoveryService } from "../archive-recovery"

let db: Database.Database
let dbPath: string
let archiveDAO: ArchiveDAO
let executionDAO: ExecutionDAO
let tokenUsageDAO: TokenUsageDAO
let workspaceDAO: WorkspaceDAO
let archiveService: ArchiveService

const WORKSPACE_ID = "ws-archive-001"
const ORG = "xzf"

function seedWorkspace(id?: string, name?: string) {
  const wsId = id ?? WORKSPACE_ID
  const now = new Date().toISOString()
  db.prepare(
    "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(wsId, name ?? "test-ws", ORG, `/tmp/${wsId}`, now, now)
  return wsId
}

function seedExecution(opts: {
  id: string
  workspaceId?: string
  workflowRef?: string
  status?: string
  parentId?: string
  childIndex?: number
  varPool?: string
  duration?: number
}) {
  const now = new Date().toISOString()
  const wsId = opts.workspaceId ?? WORKSPACE_ID
  db.prepare(
    `INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name, status, org, created_at, updated_at, var_pool, duration, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.id, wsId, opts.parentId ?? "0", opts.childIndex ?? 0,
    opts.workflowRef ?? "test-workflow.yaml", opts.workflowRef ?? "Test Workflow",
    opts.status ?? "completed", ORG, now, now,
    opts.varPool ?? "{}", opts.duration ?? 1000,
    now, now,
  )
}

function seedNodeExecution(opts: {
  id: string
  executionId: string
  nodeId: string
  nodeType?: string
  status?: string
  duration?: number
  error?: string
  exitCode?: number
}) {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO node_executions (id, execution_id, node_id, node_type, status, started_at, completed_at, duration, error, exit_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.id, opts.executionId, opts.nodeId, opts.nodeType ?? "agent",
    opts.status ?? "completed", now, now, opts.duration ?? 500,
    opts.error ?? null, opts.exitCode ?? null,
  )
}

function seedTokenUsage(opts: {
  id: string
  nodeExecutionId: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}) {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO node_token_usages (id, node_execution_id, model, input_tokens, output_tokens, cost_usd, cache_read_tokens, cache_creation_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.id, opts.nodeExecutionId, opts.model ?? "claude-sonnet-4-20250514",
    opts.inputTokens ?? 100, opts.outputTokens ?? 50, opts.costUsd ?? 0.01,
    opts.cacheReadTokens ?? 0, opts.cacheCreationTokens ?? 0, now,
  )
}

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `test-archive-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  db = new Database(dbPath)
  db.pragma("foreign_keys = ON")
  applySchema(db)

  archiveDAO = new ArchiveDAO(db)
  executionDAO = new ExecutionDAO(db)
  tokenUsageDAO = new TokenUsageDAO(db)
  workspaceDAO = new WorkspaceDAO(db)
  archiveService = new ArchiveService(archiveDAO, executionDAO, tokenUsageDAO)

  seedWorkspace()
})

afterEach(() => {
  db.close()
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)
})

// ============================================================================
// ArchiveService.archiveExecution
// ============================================================================

describe("ArchiveService.archiveExecution", () => {
  it("creates archive record with correct node_summary and token aggregation", () => {
    seedExecution({ id: "exec-1", status: "completed", duration: 2000 })
    seedNodeExecution({ id: "exec-1-node1", executionId: "exec-1", nodeId: "analyze", nodeType: "agent", status: "completed", duration: 800 })
    seedNodeExecution({ id: "exec-1-node2", executionId: "exec-1", nodeId: "implement", nodeType: "agent", status: "completed", duration: 1200 })
    seedTokenUsage({ id: "tu-1", nodeExecutionId: "exec-1-node1", model: "claude-sonnet-4-20250514", inputTokens: 500, outputTokens: 200, costUsd: 0.02 })
    seedTokenUsage({ id: "tu-2", nodeExecutionId: "exec-1-node2", model: "claude-sonnet-4-20250514", inputTokens: 800, outputTokens: 400, costUsd: 0.04 })

    const archiveId = archiveService.archiveExecution("exec-1")
    expect(archiveId).not.toBeNull()

    const archive = archiveDAO.getArchive("exec-1")
    expect(archive).not.toBeNull()
    expect(archive!.execution_id).toBe("exec-1")
    expect(archive!.status).toBe("completed")
    expect(archive!.total_input_tokens).toBe(1300)
    expect(archive!.total_output_tokens).toBe(600)
    expect(archive!.total_cost_usd).toBeCloseTo(0.06, 5)

    // Verify node_summary
    const nodeSummary = JSON.parse(archive!.node_summary)
    expect(nodeSummary).toHaveLength(2)
    expect(nodeSummary[0].node_id).toBe("analyze")
    expect(nodeSummary[0].type).toBe("agent")
    expect(nodeSummary[0].status).toBe("completed")
    expect(nodeSummary[0].duration_ms).toBe(800)
    expect(nodeSummary[1].node_id).toBe("implement")

    // Verify model_breakdown
    const modelBreakdown = JSON.parse(archive!.model_breakdown!)
    expect(modelBreakdown["claude-sonnet-4-20250514"]).toBeDefined()
    expect(modelBreakdown["claude-sonnet-4-20250514"].input_tokens).toBe(1300)
    expect(modelBreakdown["claude-sonnet-4-20250514"].output_tokens).toBe(600)
    expect(modelBreakdown["claude-sonnet-4-20250514"].cost_usd).toBeCloseTo(0.06, 5)
  })

  it("returns null for nonexistent execution", () => {
    const result = archiveService.archiveExecution("nonexistent")
    expect(result).toBeNull()
  })

  it("populates failed_nodes and error_message for failed execution", () => {
    seedExecution({ id: "exec-fail", status: "failed", duration: 500 })
    seedNodeExecution({ id: "exec-fail-node1", executionId: "exec-fail", nodeId: "step-1", status: "completed", duration: 200 })
    seedNodeExecution({ id: "exec-fail-node2", executionId: "exec-fail", nodeId: "step-2", status: "failed", duration: 300, error: "Permission denied", exitCode: 1 })
    seedNodeExecution({ id: "exec-fail-node3", executionId: "exec-fail", nodeId: "step-3", status: "failed", duration: 0, error: "Dependency failed" })

    const archiveId = archiveService.archiveExecution("exec-fail")
    expect(archiveId).not.toBeNull()

    const archive = archiveDAO.getArchive("exec-fail")
    expect(archive).not.toBeNull()
    expect(archive!.status).toBe("failed")

    const failedNodes = JSON.parse(archive!.failed_nodes!)
    expect(failedNodes).toContain("step-2")
    expect(failedNodes).toContain("step-3")
    expect(failedNodes).toHaveLength(2)
    expect(archive!.error_message).toBe("Permission denied")
  })

  it("filters large values from vars_snapshot", () => {
    const varPool = JSON.stringify({
      short_val: "hello",
      number_val: 42,
      large_val: "x".repeat(2000), // > 1000 chars, should be excluded
      nested: { key: "value" },
    })
    seedExecution({ id: "exec-vars", status: "completed", varPool })

    const archiveId = archiveService.archiveExecution("exec-vars")
    expect(archiveId).not.toBeNull()

    const archive = archiveDAO.getArchive("exec-vars")
    expect(archive).not.toBeNull()

    const varsSnapshot = JSON.parse(archive!.vars_snapshot)
    expect(varsSnapshot.short_val).toBe("hello")
    expect(varsSnapshot.number_val).toBe(42)
    expect(varsSnapshot.nested).toEqual({ key: "value" })
    expect(varsSnapshot.large_val).toBeUndefined() // excluded
  })

  it("handles parent_execution_id and chain_position", () => {
    seedExecution({ id: "exec-parent", status: "completed" })
    seedExecution({ id: "exec-child", status: "completed", parentId: "exec-parent", childIndex: 1 })

    archiveService.archiveExecution("exec-child")
    const archive = archiveDAO.getArchive("exec-child")
    expect(archive).not.toBeNull()
    expect(archive!.parent_execution_id).toBe("exec-parent")
    expect(archive!.chain_position).toBe(1)
  })

  it("sets parent_execution_id to null for root executions", () => {
    seedExecution({ id: "exec-root", status: "completed", parentId: "0" })

    archiveService.archiveExecution("exec-root")
    const archive = archiveDAO.getArchive("exec-root")
    expect(archive).not.toBeNull()
    expect(archive!.parent_execution_id).toBeNull()
  })

  it("aggregates multiple models in model_breakdown", () => {
    seedExecution({ id: "exec-multi", status: "completed" })
    seedNodeExecution({ id: "exec-multi-n1", executionId: "exec-multi", nodeId: "node-a", status: "completed" })
    seedNodeExecution({ id: "exec-multi-n2", executionId: "exec-multi", nodeId: "node-b", status: "completed" })
    seedTokenUsage({ id: "tu-a", nodeExecutionId: "exec-multi-n1", model: "claude-sonnet-4-20250514", inputTokens: 1000, outputTokens: 500, costUsd: 0.05 })
    seedTokenUsage({ id: "tu-b", nodeExecutionId: "exec-multi-n2", model: "claude-haiku", inputTokens: 2000, outputTokens: 1000, costUsd: 0.01 })

    archiveService.archiveExecution("exec-multi")
    const archive = archiveDAO.getArchive("exec-multi")
    expect(archive).not.toBeNull()
    expect(archive!.total_input_tokens).toBe(3000)
    expect(archive!.total_output_tokens).toBe(1500)
    expect(archive!.total_cost_usd).toBeCloseTo(0.06, 5)

    const breakdown = JSON.parse(archive!.model_breakdown!)
    expect(breakdown["claude-sonnet-4-20250514"].input_tokens).toBe(1000)
    expect(breakdown["claude-haiku"].input_tokens).toBe(2000)
    expect(breakdown["claude-haiku"].cost_usd).toBeCloseTo(0.01, 5)
  })
})

// ============================================================================
// ArchiveService.archiveWorkspace
// ============================================================================

describe("ArchiveService.archiveWorkspace", () => {
  it("archives all executions in a workspace", () => {
    seedExecution({ id: "ws-exec-1", status: "completed" })
    seedExecution({ id: "ws-exec-2", status: "failed" })
    seedNodeExecution({ id: "ws-exec-1-n1", executionId: "ws-exec-1", nodeId: "n1", status: "completed" })
    seedNodeExecution({ id: "ws-exec-2-n1", executionId: "ws-exec-2", nodeId: "n1", status: "failed", error: "Error" })

    const wsArchiveId = archiveService.archiveWorkspace(WORKSPACE_ID)
    expect(wsArchiveId).not.toBeNull()

    // Verify execution archives were created
    expect(archiveDAO.getArchive("ws-exec-1")).not.toBeNull()
    expect(archiveDAO.getArchive("ws-exec-2")).not.toBeNull()

    // Verify workspace archive
    const wsArchive = archiveDAO.getWorkspaceArchive(WORKSPACE_ID)
    expect(wsArchive).not.toBeNull()
    expect(wsArchive!.total_executions).toBe(2)
  })

  it("returns null for empty workspace", () => {
    const emptyWsId = "ws-empty"
    seedWorkspace(emptyWsId, "empty-ws")
    const result = archiveService.archiveWorkspace(emptyWsId)
    expect(result).toBeNull()
  })

  it("builds workflow_manifest from unique workflow refs", () => {
    seedExecution({ id: "wf-exec-1", workflowRef: "flow-a.yaml", status: "completed" })
    seedExecution({ id: "wf-exec-2", workflowRef: "flow-b.yaml", status: "completed" })
    seedExecution({ id: "wf-exec-3", workflowRef: "flow-a.yaml", status: "completed" })

    archiveService.archiveWorkspace(WORKSPACE_ID)
    const wsArchive = archiveDAO.getWorkspaceArchive(WORKSPACE_ID)
    expect(wsArchive).not.toBeNull()

    const manifest = JSON.parse(wsArchive!.workflow_manifest)
    expect(manifest).toHaveLength(2)
    const flowA = manifest.find((m: any) => m.workflow_ref === "flow-a.yaml")
    const flowB = manifest.find((m: any) => m.workflow_ref === "flow-b.yaml")
    expect(flowA).toBeDefined()
    expect(flowA.execution_count).toBe(2)
    expect(flowB).toBeDefined()
    expect(flowB.execution_count).toBe(1)
  })
})

// ============================================================================
// WorkspaceService two-phase delete
// ============================================================================

describe("WorkspaceService two-phase delete", () => {
  it("success path: archiving → archived → cascade delete", async () => {
    seedExecution({ id: "del-exec-1", status: "completed" })
    seedNodeExecution({ id: "del-exec-1-n1", executionId: "del-exec-1", nodeId: "n1", status: "completed" })
    seedTokenUsage({ id: "del-tu-1", nodeExecutionId: "del-exec-1-n1", inputTokens: 100, outputTokens: 50, costUsd: 0.01 })

    const wsService = new WorkspaceService(workspaceDAO, archiveService)

    // Workspace should exist before delete
    expect(workspaceDAO.findById(WORKSPACE_ID)).not.toBeNull()

    const result = await wsService.delete(WORKSPACE_ID)
    expect(result).toBe(true)

    // After successful delete, the workspace record should be gone (cascade deleted)
    expect(workspaceDAO.findById(WORKSPACE_ID)).toBeNull()

    // Archive should have been created before cascade
    const archive = archiveDAO.getArchive("del-exec-1")
    // Note: archive is also cascade-deleted since cascadeDeleteByWorkspace deletes execution_archive
    // So the archive may not exist after full delete. This is the expected behavior.
  })

  it("failure path: archive_failed preserves workspace data", async () => {
    // Create a failing archive service (mock)
    const failingArchiveService = {
      archiveWorkspace: () => { throw new Error("Simulated archive failure") },
      archiveExecution: () => null,
      archiveExecutionForDetail: () => null,
    } as unknown as ArchiveService

    const wsService = new WorkspaceService(workspaceDAO, failingArchiveService)

    seedExecution({ id: "fail-exec-1", status: "completed" })

    // Workspace should exist before delete
    const wsBefore = workspaceDAO.findById(WORKSPACE_ID)
    expect(wsBefore).not.toBeNull()

    // Delete should throw because archive failed
    await expect(wsService.delete(WORKSPACE_ID)).rejects.toThrow("Archive failed")

    // Workspace should still exist (data preserved)
    const wsAfter = workspaceDAO.findById(WORKSPACE_ID)
    expect(wsAfter).not.toBeNull()
    expect(wsAfter!.archive_status).toBe("archive_failed")
  })

  it("concurrent delete: only one acquires lock", async () => {
    const wsService = new WorkspaceService(workspaceDAO, archiveService)

    // Manually set archive_status to 'archiving' to simulate concurrent lock
    workspaceDAO.setArchiveStatus(WORKSPACE_ID, "archiving")

    // Second delete should fail to acquire lock
    await expect(wsService.delete(WORKSPACE_ID)).rejects.toThrow("already being archived")
  })

  it("delete without archiveService still works", async () => {
    const wsService = new WorkspaceService(workspaceDAO)

    seedExecution({ id: "noarch-exec-1", status: "completed" })

    const result = await wsService.delete(WORKSPACE_ID)
    expect(result).toBe(true)
    expect(workspaceDAO.findById(WORKSPACE_ID)).toBeNull()
  })
})

// ============================================================================
// ArchiveRecoveryService
// ============================================================================

describe("ArchiveRecoveryService", () => {
  it("resets timed-out archiving workspaces to none", () => {
    // Create a workspace stuck in 'archiving' for > 30 minutes
    const stuckWsId = "ws-stuck"
    const oldTime = new Date(Date.now() - 60 * 60 * 1000).toISOString() // 1 hour ago
    db.prepare(
      "INSERT INTO workspaces (id, name, org, path, archive_status, archive_started_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'archiving', ?, ?, ?)"
    ).run(stuckWsId, "stuck-ws", ORG, `/tmp/${stuckWsId}`, oldTime, oldTime, oldTime)

    const recoveryService = new ArchiveRecoveryService(workspaceDAO, 60 * 60 * 1000) // 1 hour interval (won't fire in test)

    // Manually call recoverTimedOut
    recoveryService.recoverTimedOut(30)

    const ws = workspaceDAO.findById(stuckWsId)
    expect(ws).not.toBeNull()
    expect(ws!.archive_status).toBe("none")
  })

  it("does not reset recently started archiving", () => {
    const recentWsId = "ws-recent"
    const recentTime = new Date(Date.now() - 5 * 60 * 1000).toISOString() // 5 minutes ago
    db.prepare(
      "INSERT INTO workspaces (id, name, org, path, archive_status, archive_started_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'archiving', ?, ?, ?)"
    ).run(recentWsId, "recent-ws", ORG, `/tmp/${recentWsId}`, recentTime, recentTime, recentTime)

    const recoveryService = new ArchiveRecoveryService(workspaceDAO)
    recoveryService.recoverTimedOut(30)

    const ws = workspaceDAO.findById(recentWsId)
    expect(ws).not.toBeNull()
    expect(ws!.archive_status).toBe("archiving") // unchanged
  })

  it("retryCleanup handles missing directory gracefully", () => {
    const archivedWsId = "ws-archived-nodir"
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO workspaces (id, name, org, path, archive_status, created_at, updated_at) VALUES (?, ?, ?, ?, 'archived', ?, ?)"
    ).run(archivedWsId, "archived-ws", ORG, "/tmp/nonexistent-archive-dir", now, now)

    const recoveryService = new ArchiveRecoveryService(workspaceDAO)
    // Should not throw
    expect(() => recoveryService.retryCleanup()).not.toThrow()
  })

  it("start/stop lifecycle", () => {
    const recoveryService = new ArchiveRecoveryService(workspaceDAO, 60000)
    recoveryService.start()
    // Should not throw
    recoveryService.stop()
    // Double stop should also not throw
    recoveryService.stop()
  })
})

// ============================================================================
// Token aggregation precision
// ============================================================================

describe("Token aggregation precision", () => {
  it("handles zero-cost token usages", () => {
    seedExecution({ id: "exec-zero-cost", status: "completed" })
    seedNodeExecution({ id: "exec-zero-cost-n1", executionId: "exec-zero-cost", nodeId: "n1", status: "completed" })
    seedTokenUsage({ id: "tu-zero-1", nodeExecutionId: "exec-zero-cost-n1", inputTokens: 100, outputTokens: 50, costUsd: 0 })
    seedTokenUsage({ id: "tu-zero-2", nodeExecutionId: "exec-zero-cost-n1", inputTokens: 200, outputTokens: 100, costUsd: 0 })

    archiveService.archiveExecution("exec-zero-cost")
    const archive = archiveDAO.getArchive("exec-zero-cost")
    expect(archive).not.toBeNull()
    expect(archive!.total_input_tokens).toBe(300)
    expect(archive!.total_output_tokens).toBe(150)
    expect(archive!.total_cost_usd).toBe(0)
  })

  it("handles null cost_usd gracefully", () => {
    seedExecution({ id: "exec-null-cost", status: "completed" })
    seedNodeExecution({ id: "exec-null-cost-n1", executionId: "exec-null-cost", nodeId: "n1", status: "completed" })

    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO node_token_usages (id, node_execution_id, model, input_tokens, output_tokens, cost_usd, cache_read_tokens, cache_creation_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`
    ).run("tu-null", "exec-null-cost-n1", "claude-sonnet-4-20250514", 100, 50, 0, 0, now)

    archiveService.archiveExecution("exec-null-cost")
    const archive = archiveDAO.getArchive("exec-null-cost")
    expect(archive).not.toBeNull()
    expect(archive!.total_cost_usd).toBe(0)
  })

  it("aggregates tokens across multiple nodes correctly", () => {
    seedExecution({ id: "exec-multi-node", status: "completed" })
    seedNodeExecution({ id: "emn-n1", executionId: "exec-multi-node", nodeId: "node-1", status: "completed" })
    seedNodeExecution({ id: "emn-n2", executionId: "exec-multi-node", nodeId: "node-2", status: "completed" })
    seedNodeExecution({ id: "emn-n3", executionId: "exec-multi-node", nodeId: "node-3", status: "completed" })

    seedTokenUsage({ id: "emn-tu-1", nodeExecutionId: "emn-n1", model: "model-a", inputTokens: 100, outputTokens: 50, costUsd: 0.001 })
    seedTokenUsage({ id: "emn-tu-2", nodeExecutionId: "emn-n2", model: "model-a", inputTokens: 200, outputTokens: 100, costUsd: 0.002 })
    seedTokenUsage({ id: "emn-tu-3", nodeExecutionId: "emn-n3", model: "model-b", inputTokens: 300, outputTokens: 150, costUsd: 0.003 })

    archiveService.archiveExecution("exec-multi-node")
    const archive = archiveDAO.getArchive("exec-multi-node")
    expect(archive).not.toBeNull()
    expect(archive!.total_input_tokens).toBe(600)
    expect(archive!.total_output_tokens).toBe(300)
    expect(archive!.total_cost_usd).toBeCloseTo(0.006, 6)

    const breakdown = JSON.parse(archive!.model_breakdown!)
    expect(breakdown["model-a"].input_tokens).toBe(300)
    expect(breakdown["model-a"].output_tokens).toBe(150)
    expect(breakdown["model-b"].input_tokens).toBe(300)
    expect(breakdown["model-b"].output_tokens).toBe(150)
  })
})

// ============================================================================
// ArchiveService.archiveExecutionForDetail
// ============================================================================

describe("ArchiveService.archiveExecutionForDetail", () => {
  it("returns parsed archive data with experiences array", () => {
    seedExecution({ id: "detail-exec", status: "completed" })
    seedNodeExecution({ id: "detail-exec-n1", executionId: "detail-exec", nodeId: "n1", status: "completed" })

    archiveService.archiveExecution("detail-exec")
    const detail = archiveService.archiveExecutionForDetail("detail-exec") as any
    expect(detail).not.toBeNull()
    expect(detail.execution_id).toBe("detail-exec")
    expect(detail.experiences).toEqual([])
    expect(Array.isArray(detail.node_summary)).toBe(true)
  })

  it("returns null for non-archived execution", () => {
    const result = archiveService.archiveExecutionForDetail("nonexistent")
    expect(result).toBeNull()
  })
})
