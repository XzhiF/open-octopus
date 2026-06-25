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
  dbPath = path.join(os.tmpdir(), `test-hooks-${Date.now()}.db`)
  db = new Database(dbPath)
  db.pragma("foreign_keys = ON")
  applySchema(db)
})

afterEach(() => {
  db.close()
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)
})

describe("ExecutionService hooks DB schema", () => {
  it("marks running executions as failed (existing behavior preserved)", () => {
    const wsId = randomUUID()
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(wsId, "test-ws", "test-org", "/tmp/test-ws", now, now)

    const execId = randomUUID()
    db.prepare(
      "INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, org, created_at, updated_at) VALUES (?, ?, '0', ?, ?, 'running', ?, ?, ?)"
    ).run(execId, wsId, "test.yaml", "test", "test-org", now, now)

    ExecutionService.recoverInterruptedExecutions(db)

    const exec = db.prepare("SELECT status FROM executions WHERE id = ?").get(execId) as { status: string }
    expect(exec.status).toBe("failed")
  })

  it("retry_count column exists and defaults to 0", () => {
    const wsId = randomUUID()
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(wsId, "test-ws", "test-org", "/tmp/test-ws", now, now)

    const execId = randomUUID()
    db.prepare(
      "INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, org, created_at, updated_at) VALUES (?, ?, '0', ?, ?, 'pending', ?, ?, ?)"
    ).run(execId, wsId, "test.yaml", "test", "test-org", now, now)

    const row = db.prepare("SELECT retry_count, pending_hooks FROM executions WHERE id = ?").get(execId) as { retry_count: number; pending_hooks: string }
    expect(row.retry_count).toBe(0)
    expect(row.pending_hooks).toBe("[]")
  })
})
