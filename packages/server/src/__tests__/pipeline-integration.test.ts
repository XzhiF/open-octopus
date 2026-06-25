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
  dbPath = path.join(os.tmpdir(), `test-pipeline-${Date.now()}.db`)
  db = new Database(dbPath)
  db.pragma("foreign_keys = ON")
  applySchema(db)
})

afterEach(() => {
  db.close()
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)
})

describe("ExecutionService pipeline integration", () => {
  describe("recoverInterruptedExecutions with auto-resume", () => {
    it("marks running as pending_resume when auto-resume enabled", () => {
      const wsId = randomUUID()
      const now = new Date().toISOString()
      db.prepare(
        "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(wsId, "test-ws", "test-org", "/tmp/test-ws", now, now)

      const execId = randomUUID()
      const pipelineConfig = JSON.stringify({
        apiVersion: "octopus/v1",
        kind: "Pipeline",
        execution: { resume_on_interrupt: "auto", pending_resume_timeout: 600 },
      })
      db.prepare(
        "INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, pipeline_config, org, created_at, updated_at) VALUES (?, ?, '0', ?, ?, 'running', ?, ?, ?, ?)"
      ).run(execId, wsId, "test.yaml", "test", pipelineConfig, "test-org", now, now)

      ExecutionService.recoverInterruptedExecutions(db)

      const exec = db.prepare("SELECT status FROM executions WHERE id = ?").get(execId) as { status: string }
      expect(exec.status).toBe("pending_resume")
    })

    it("marks running as failed when auto-resume disabled", () => {
      const wsId = randomUUID()
      const now = new Date().toISOString()
      db.prepare(
        "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(wsId, "test-ws", "test-org", "/tmp/test-ws", now, now)

      const execId = randomUUID()
      const pipelineConfig = JSON.stringify({
        apiVersion: "octopus/v1",
        kind: "Pipeline",
        execution: { resume_on_interrupt: "manual", pending_resume_timeout: 600 },
      })
      db.prepare(
        "INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, pipeline_config, org, created_at, updated_at) VALUES (?, ?, '0', ?, ?, 'running', ?, ?, ?, ?)"
      ).run(execId, wsId, "test.yaml", "test", pipelineConfig, "test-org", now, now)

      ExecutionService.recoverInterruptedExecutions(db)

      const exec = db.prepare("SELECT status FROM executions WHERE id = ?").get(execId) as { status: string }
      expect(exec.status).toBe("failed")
    })

    it("expires stale pending_resume past pending_resume_timeout", () => {
      const wsId = randomUUID()
      const now = new Date().toISOString()
      db.prepare(
        "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(wsId, "test-ws", "test-org", "/tmp/test-ws", now, now)

      const execId = randomUUID()
      const pipelineConfig = JSON.stringify({
        apiVersion: "octopus/v1",
        kind: "Pipeline",
        execution: { resume_on_interrupt: "auto", pending_resume_timeout: 600 },
      })
      // Insert as pending_resume with updated_at 700 seconds ago (past 600s timeout)
      const staleTime = new Date(Date.now() - 700 * 1000).toISOString()
      db.prepare(
        "INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, pipeline_config, org, created_at, updated_at) VALUES (?, ?, '0', ?, ?, 'pending_resume', ?, ?, ?, ?)"
      ).run(execId, wsId, "test.yaml", "test", pipelineConfig, "test-org", staleTime, staleTime)

      ExecutionService.recoverInterruptedExecutions(db)

      const exec = db.prepare("SELECT status FROM executions WHERE id = ?").get(execId) as { status: string }
      expect(exec.status).toBe("failed")
    })
  })
})
