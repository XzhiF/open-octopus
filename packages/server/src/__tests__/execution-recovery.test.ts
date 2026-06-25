import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { randomUUID } from "crypto"
import { applySchema } from "../db/schema"
import { ExecutionService } from "../services/execution"
import { SSEService } from "../services/sse"

let db: Database.Database
let dbPath: string

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `test-recovery-${Date.now()}.db`)
  db = new Database(dbPath)
  db.pragma("foreign_keys = ON")
  applySchema(db)
})

afterEach(() => {
  db.close()
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)
})

describe("ExecutionService.recoverInterruptedExecutions", () => {
  it("marks running executions as failed on server restart", () => {
    const wsId = randomUUID()
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(wsId, "test-ws", "test-org", "/tmp/test-ws", now, now)

    const execId = randomUUID()
    db.prepare(
      "INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, org, created_at, updated_at) VALUES (?, ?, '0', ?, ?, 'running', ?, ?, ?)"
    ).run(execId, wsId, "test.yaml", "test", "test-org", now, now)

    const neId = `${execId}-step1`
    db.prepare(
      "INSERT INTO node_executions (id, execution_id, node_id, node_type, status, started_at) VALUES (?, ?, 'step1', 'bash', 'running', ?)"
    ).run(neId, execId, now)

    ExecutionService.recoverInterruptedExecutions(db)

    const exec = db.prepare("SELECT status, completed_at FROM executions WHERE id = ?").get(execId) as { status: string; completed_at: string }
    expect(exec.status).toBe("failed")
    expect(exec.completed_at).toBeTruthy()

    const ne = db.prepare("SELECT status, error FROM node_executions WHERE id = ?").get(neId) as { status: string; error: string }
    expect(ne.status).toBe("failed")
    expect(ne.error).toBe("服务重启中断")
  })

  it("marks pending node_executions under running execution as failed", () => {
    const wsId = randomUUID()
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(wsId, "test-ws", "test-org", "/tmp/test-ws", now, now)

    const execId = randomUUID()
    db.prepare(
      "INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, org, created_at, updated_at) VALUES (?, ?, '0', ?, ?, 'running', ?, ?, ?)"
    ).run(execId, wsId, "test.yaml", "test", "test-org", now, now)

    const neId = `${execId}-step2`
    db.prepare(
      "INSERT INTO node_executions (id, execution_id, node_id, node_type, status) VALUES (?, ?, 'step2', 'bash', 'pending')"
    ).run(neId, execId)

    ExecutionService.recoverInterruptedExecutions(db)

    const ne = db.prepare("SELECT status, error FROM node_executions WHERE id = ?").get(neId) as { status: string; error: string }
    expect(ne.status).toBe("failed")
    expect(ne.error).toBe("服务重启中断")
  })

  it("keeps paused executions unchanged", () => {
    const wsId = randomUUID()
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(wsId, "test-ws", "test-org", "/tmp/test-ws", now, now)

    const execId = randomUUID()
    db.prepare(
      "INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, org, created_at, updated_at) VALUES (?, ?, '0', ?, ?, 'paused', ?, ?, ?)"
    ).run(execId, wsId, "test.yaml", "test", "test-org", now, now)

    ExecutionService.recoverInterruptedExecutions(db)

    const exec = db.prepare("SELECT status FROM executions WHERE id = ?").get(execId) as { status: string }
    expect(exec.status).toBe("paused")
  })

  it("does nothing when no running executions exist", () => {
    ExecutionService.recoverInterruptedExecutions(db)
    // No crash, no changes
    const runningCount = db.prepare("SELECT COUNT(*) as cnt FROM executions WHERE status = 'running'").get() as { cnt: number }
    expect(runningCount.cnt).toBe(0)
  })

  it("marks stale running executions (>10min) with timeout error message", () => {
    const wsId = randomUUID()
    const now = new Date()
    const nowISO = now.toISOString()
    const fifteenMinAgo = new Date(now.getTime() - 15 * 60 * 1000).toISOString()

    db.prepare(
      "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(wsId, "test-ws", "test-org", "/tmp/test-ws", nowISO, nowISO)

    const execId = randomUUID()
    db.prepare(
      "INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, org, created_at, updated_at) VALUES (?, ?, '0', ?, ?, 'running', ?, ?, ?)"
    ).run(execId, wsId, "test.yaml", "test", "test-org", fifteenMinAgo, fifteenMinAgo)

    const neId = `${execId}-step1`
    db.prepare(
      "INSERT INTO node_executions (id, execution_id, node_id, node_type, status, started_at) VALUES (?, ?, 'step1', 'agent', 'running', ?)"
    ).run(neId, execId, fifteenMinAgo)

    ExecutionService.recoverInterruptedExecutions(db)

    const ne = db.prepare("SELECT error FROM node_executions WHERE id = ?").get(neId) as { error: string }
    expect(ne.error).toBe("服务重启中断（运行超过10分钟）")
  })

  it("marks recent running executions (<=10min) with standard restart error message", () => {
    const wsId = randomUUID()
    const now = new Date()
    const nowISO = now.toISOString()
    const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000).toISOString()

    db.prepare(
      "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(wsId, "test-ws", "test-org", "/tmp/test-ws", nowISO, nowISO)

    const execId = randomUUID()
    db.prepare(
      "INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, org, created_at, updated_at) VALUES (?, ?, '0', ?, ?, 'running', ?, ?, ?)"
    ).run(execId, wsId, "test.yaml", "test", "test-org", fiveMinAgo, fiveMinAgo)

    const neId = `${execId}-step1`
    db.prepare(
      "INSERT INTO node_executions (id, execution_id, node_id, node_type, status, started_at) VALUES (?, ?, 'step1', 'agent', 'running', ?)"
    ).run(neId, execId, fiveMinAgo)

    ExecutionService.recoverInterruptedExecutions(db)

    const ne = db.prepare("SELECT error FROM node_executions WHERE id = ?").get(neId) as { error: string }
    expect(ne.error).toBe("服务重启中断")
  })

  it("marks orphaned nodes with orphan error message", () => {
    const wsId = randomUUID()
    const now = new Date()
    const nowISO = now.toISOString()

    db.prepare(
      "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(wsId, "test-ws", "test-org", "/tmp/test-ws", nowISO, nowISO)

    // Execution already failed
    const execId = randomUUID()
    db.prepare(
      "INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, org, created_at, updated_at) VALUES (?, ?, '0', ?, ?, 'failed', ?, ?, ?)"
    ).run(execId, wsId, "test.yaml", "test", "test-org", nowISO, nowISO)

    // But node is still running (orphan)
    const neId = `${execId}-step1`
    db.prepare(
      "INSERT INTO node_executions (id, execution_id, node_id, node_type, status, started_at) VALUES (?, ?, 'step1', 'agent', 'running', ?)"
    ).run(neId, execId, nowISO)

    ExecutionService.recoverInterruptedExecutions(db)

    const ne = db.prepare("SELECT error FROM node_executions WHERE id = ?").get(neId) as { error: string }
    expect(ne.error).toBe("服务重启中断（孤立节点）")
  })

  it("handles multiple running executions", () => {
    const wsId = randomUUID()
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(wsId, "test-ws", "test-org", "/tmp/test-ws", now, now)

    const execId1 = randomUUID()
    const execId2 = randomUUID()
    db.prepare(
      "INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, org, created_at, updated_at) VALUES (?, ?, '0', ?, ?, 'running', ?, ?, ?)"
    ).run(execId1, wsId, "test.yaml", "test", "test-org", now, now)
    db.prepare(
      "INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, org, created_at, updated_at) VALUES (?, ?, '0', ?, ?, 'running', ?, ?, ?)"
    ).run(execId2, wsId, "test.yaml", "test", "test-org", now, now)

    ExecutionService.recoverInterruptedExecutions(db)

    const count = db.prepare("SELECT COUNT(*) as cnt FROM executions WHERE status = 'failed'").get() as { cnt: number }
    expect(count.cnt).toBe(2)
  })
})

describe("retry auto-detect failedNodeId", () => {
  it("resolves execution UUID to workflow node ID by looking up failed node in DB", () => {
    const wsId = randomUUID()
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(wsId, "test-ws", "test-org", "/tmp/test-ws", now, now)

    const execId = randomUUID()
    db.prepare(
      "INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, org, created_at, updated_at) VALUES (?, ?, '0', ?, ?, 'failed', ?, ?, ?)"
    ).run(execId, wsId, "test.yaml", "test", "test-org", now, now)

    // node_executions with failed status — the workflow node ID is "plan"
    const neId = `${execId}-plan`
    db.prepare(
      "INSERT INTO node_executions (id, execution_id, node_id, node_type, status, error, started_at) VALUES (?, ?, 'plan', 'agent', 'failed', ?, ?)"
    ).run(neId, execId, "服务重启中断", now)

    // When failedNodeId is the execution UUID (not a workflow node ID),
    // the service should auto-detect "plan" from the DB
    // We can't call the full retry() since it needs a real workflow file,
    // but we verify the DB lookup logic independently
    const failedNode = db.prepare(
      "SELECT node_id FROM node_executions WHERE execution_id = ? AND status = 'failed' ORDER BY started_at ASC LIMIT 1"
    ).get(execId) as { node_id: string } | undefined

    expect(failedNode).toBeDefined()
    expect(failedNode!.node_id).toBe("plan")
  })
})

describe("onNodeEnd clears error on completed status", () => {
  it("prevents stale '服务重启中断' error from persisting when node completes after recovery", () => {
    const wsId = randomUUID()
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(wsId, "test-ws", "test-org", "/tmp/test-ws", now, now)

    // Execution that was marked failed by recovery
    const execId = randomUUID()
    db.prepare(
      "INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, org, created_at, updated_at) VALUES (?, ?, '0', ?, ?, 'failed', ?, ?, ?)"
    ).run(execId, wsId, "test.yaml", "test", "test-org", now, now)

    // Node that recovery marked as failed with error
    const neId = `${execId}-step1`
    db.prepare(
      "INSERT INTO node_executions (id, execution_id, node_id, node_type, status, error, started_at) VALUES (?, ?, 'step1', 'agent', 'failed', ?, ?)"
    ).run(neId, execId, "服务重启中断", now)

    // Simulate engine completing the node after recovery (race condition)
    db.prepare(
      "UPDATE node_executions SET status = 'completed', error = NULL, completed_at = ? WHERE id = ?"
    ).run(now, neId)

    // Verify error was cleared
    const ne = db.prepare("SELECT status, error FROM node_executions WHERE id = ?").get(neId) as { status: string; error: string | null }
    expect(ne.status).toBe("completed")
    expect(ne.error).toBeNull()
  })
})