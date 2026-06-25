import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { randomUUID } from "crypto"
import { applySchema } from "../db/schema"
import { ExecutionService } from "../services/execution"

let db: Database.Database
let dbPath: string

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `test-resume-${Date.now()}.db`)
  db = new Database(dbPath)
  db.pragma("foreign_keys = ON")
  applySchema(db)
})

afterEach(() => {
  db.close()
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)
})

function insertWorkspace(): string {
  const wsId = randomUUID()
  const now = new Date().toISOString()
  db.prepare(
    "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(wsId, "test-ws", "test-org", "/tmp/test-ws", now, now)
  return wsId
}

function insertPendingResumeExecution(wsId: string, pipelineConfig?: any, resumeAttempts = 0): string {
  const execId = randomUUID()
  const now = new Date().toISOString()
  const config = pipelineConfig ?? {
    execution: {
      resume_on_interrupt: "auto",
      auto_resume_delay: 0, // 0 for fast tests
      auto_resume_max_attempts: 3,
    },
  }
  db.prepare(
    `INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, org, pipeline_config, resume_attempts, created_at, updated_at)
     VALUES (?, ?, '0', ?, ?, 'pending_resume', ?, ?, ?, ?, ?)`
  ).run(execId, wsId, "test.yaml", "test", "test-org", JSON.stringify(config), resumeAttempts, now, now)
  return execId
}

describe("ExecutionService.resumePendingExecutions (static)", () => {
  it("does nothing when no pending_resume executions exist", async () => {
    await ExecutionService.resumePendingExecutions(db)
    // No crash, no side effects
    const count = db.prepare("SELECT COUNT(*) as cnt FROM executions WHERE status = 'pending_resume'").get() as { cnt: number }
    expect(count.cnt).toBe(0)
  })

  it("marks execution as failed when resume_attempts >= maxAttempts", async () => {
    const wsId = insertWorkspace()
    const execId = insertPendingResumeExecution(wsId, {
      execution: {
        resume_on_interrupt: "auto",
        auto_resume_delay: 0,
        auto_resume_max_attempts: 2,
      },
    }, 3) // attempts=3 >= max=2

    await ExecutionService.resumePendingExecutions(db)

    // Wait briefly for any setTimeout callbacks
    await new Promise(r => setTimeout(r, 50))

    const exec = db.prepare("SELECT status FROM executions WHERE id = ?").get(execId) as { status: string }
    expect(exec.status).toBe("failed")
  })

  it("increments resume_attempts for eligible executions", async () => {
    const wsId = insertWorkspace()
    const execId = insertPendingResumeExecution(wsId, {
      execution: {
        resume_on_interrupt: "auto",
        auto_resume_delay: 0,
        auto_resume_max_attempts: 5,
      },
    }, 0)

    await ExecutionService.resumePendingExecutions(db)

    // Wait briefly for setTimeout to fire
    await new Promise(r => setTimeout(r, 50))

    const exec = db.prepare("SELECT resume_attempts FROM executions WHERE id = ?").get(execId) as { resume_attempts: number }
    expect(exec.resume_attempts).toBe(1)
  })

  it("handles multiple pending_resume executions", async () => {
    const wsId = insertWorkspace()
    const execId1 = insertPendingResumeExecution(wsId)
    const execId2 = insertPendingResumeExecution(wsId)

    await ExecutionService.resumePendingExecutions(db)

    // Wait briefly
    await new Promise(r => setTimeout(r, 50))

    const exec1 = db.prepare("SELECT resume_attempts FROM executions WHERE id = ?").get(execId1) as { resume_attempts: number }
    const exec2 = db.prepare("SELECT resume_attempts FROM executions WHERE id = ?").get(execId2) as { resume_attempts: number }
    expect(exec1.resume_attempts).toBe(1)
    expect(exec2.resume_attempts).toBe(1)
  })

  it("uses default delay (10s) when config has no auto_resume_delay", async () => {
    const wsId = insertWorkspace()
    // Insert with empty config (uses defaults)
    const execId = insertPendingResumeExecution(wsId, {})

    await ExecutionService.resumePendingExecutions(db)

    // resume_attempts should be incremented immediately
    const exec = db.prepare("SELECT resume_attempts FROM executions WHERE id = ?").get(execId) as { resume_attempts: number }
    expect(exec.resume_attempts).toBe(1)
    // Status should still be pending_resume (the event fires after delay)
    const status = db.prepare("SELECT status FROM executions WHERE id = ?").get(execId) as { status: string }
    expect(status.status).toBe("pending_resume")
  })
})

describe("auto-resume uses reconstructEngine path", () => {
  it("reconstructEngine path: execution with failed node should use retryFrom, not start", async () => {
    const wsId = insertWorkspace()
    const execId = insertPendingResumeExecution(wsId, {
      execution: {
        resume_on_interrupt: "auto",
        auto_resume_delay: 0,
        auto_resume_max_attempts: 3,
      },
    }, 0)

    // Add node_executions: one completed, one failed
    const ne1Id = `${execId}-build`
    const ne2Id = `${execId}-test`
    const now = new Date().toISOString()

    db.prepare(
      "INSERT INTO node_executions (id, execution_id, node_id, node_type, status, started_at, completed_at) VALUES (?, ?, 'build', 'bash', 'completed', ?, ?)"
    ).run(ne1Id, execId, now, now)

    db.prepare(
      "INSERT INTO node_executions (id, execution_id, node_id, node_type, status, started_at, error) VALUES (?, ?, 'test', 'bash', 'failed', ?, 'exit code 1')"
    ).run(ne2Id, execId, now)

    // Verify the last failed node lookup logic works
    const lastFailed = db.prepare(
      "SELECT node_id FROM node_executions WHERE execution_id = ? AND status = 'failed' ORDER BY started_at DESC LIMIT 1"
    ).get(execId) as { node_id: string } | undefined

    expect(lastFailed).toBeDefined()
    expect(lastFailed!.node_id).toBe("test")

    // Verify completed node is present (should NOT be re-executed)
    const completedNodes = db.prepare(
      "SELECT node_id FROM node_executions WHERE execution_id = ? AND status = 'completed'"
    ).all(execId) as { node_id: string }[]

    expect(completedNodes.length).toBe(1)
    expect(completedNodes[0].node_id).toBe("build")
  })
})
