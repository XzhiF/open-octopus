// packages/server/src/__tests__/task-dispatch-service.test.ts
//
// Focused tests for TaskDispatchService (ticket 03 / G1 bridge, server side).
// Verifies the restart-safe parent correlation: the child schedule's config carries
// a `parent_task_dispatch` marker (written at dispatch time), and resumeOnCompletion
// reads it from the DB (no in-memory closure) to call the parent-resume hook.
//
// The engine-level pause/resume (retryFrom with taskDispatchChildOutput) is covered
// by packages/engine/src/__tests__/task-dispatch-bridge.test.ts. The full server
// integration (real createFromSpec + scheduler-engine claiming a queued child) is
// beyond this ticket's verifiable scope; here we test the correlation + dispatch
// bookkeeping with an in-memory DB + stubbed dependencies.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { randomUUID } from "crypto"
import { applySchema } from "../db/schema"
import { SSEService } from "../services/sse"
import { TaskDispatchService } from "../services/scheduler/task-dispatch-service"
import type { SubunitSpec } from "@octopus/shared"

// getExecutionService is a module-level singleton lookup. Stub it so the dispatch
// path does not require the real ExecutionServiceRegistry (which needs init).
// Returns a stub service sufficient for the port's create+register+start calls.
vi.mock("../services/execution-service-registry", () => ({
  getExecutionService: () => ({
    service: {
      create: () => ({ id: "child-exec-1" }),
      start: () => Promise.resolve(undefined),
      registerExternalCallbacks: () => {},
      clearExternalCallbacks: () => {},
    },
    wsPath: "/tmp/e2e-tp-stub-ws",
  }),
}))

function makeSubunit(): SubunitSpec {
  return {
    name: "E2E_TP_subunit_a",
    workspace_spec: {
      org: "E2E_TP_org",
      branch_prefix: "e2e-tp-sub-a",
      projects: [{ name: "E2E_TP_project", source_path: "", group: "" }],
    },
    workflow_ref: "e2e-tp/simple-spec-workflow",
    input_values: {},
    skills: [],
  }
}

describe("TaskDispatchService — G1 parent-resume correlation", () => {
  let db: Database.Database
  let dbPath: string
  let service: TaskDispatchService
  let resumeSpy: ReturnType<typeof vi.fn>
  const ORG = "e2e-tp-org"
  const WORKSPACE_ID = "ws-coordinator-1"
  const WORKSPACE_PATH = path.join(os.tmpdir(), `e2e-tp-tds-${Date.now()}`)

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `e2e-tp-tds-db-${Date.now()}.db`)
    db = new Database(dbPath)
    applySchema(db)
    // FK enforcement disabled for this in-memory test: the dispatch path writes
    // schedule_executions.execution_id pointing at a child execution created by a
    // STUBBED ExecutionService (the stub returns a fake id without inserting a
    // row). Set AFTER applySchema — schema.sql re-enables FKs during db.exec.
    db.pragma("foreign_keys = OFF")

    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(WORKSPACE_ID, "e2e-tp-coordinator", ORG, WORKSPACE_PATH, now, now)

    // Stub WorkspaceService — only createFromSpec is used by the dispatch path.
    const workspaceServiceStub = {
      createFromSpec: vi.fn(() => ({ id: "ws-child-1" })),
    } as any

    service = new TaskDispatchService({
      db,
      workspaceId: WORKSPACE_ID,
      workspacePath: WORKSPACE_PATH,
      org: ORG,
      workspaceService: workspaceServiceStub,
      sse: new SSEService(),
    })
    resumeSpy = vi.fn().mockResolvedValue(undefined)
    service.setResumeParentCallback(resumeSpy)
  })

  afterEach(() => {
    db.close()
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)
    if (fs.existsSync(WORKSPACE_PATH)) fs.rmSync(WORKSPACE_PATH, { recursive: true, force: true })
  })

  /** Helper: insert a parent execution row (running) + a running task_dispatch node. */
  function seedRunningParent(parentExecId: string, nodeId: string): void {
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO executions (id, workspace_id, workflow_ref, workflow_name, org, status, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(parentExecId, WORKSPACE_ID, "composition-wf.yaml", "composition-wf", ORG, "running", now, now, now)
    db.prepare(
      "INSERT INTO node_executions (id, execution_id, node_id, node_type, status, started_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(`${parentExecId}-${nodeId}`, parentExecId, nodeId, "task_dispatch", "running", now)
  }

  /** Helper: read a schedule row's parsed config. */
  function readScheduleConfig(scheduleId: string): any {
    const row = db.prepare("SELECT config FROM schedules WHERE id = ?").get(scheduleId) as { config: string } | undefined
    return row ? JSON.parse(row.config) : null
  }

  it("dispatchChildSchedule creates a distinct child schedule carrying the parent_task_dispatch marker", async () => {
    const parentExecId = "exec-parent-1"
    const nodeId = "dispatch-node-1"
    seedRunningParent(parentExecId, nodeId)

    const handle = await service.dispatchChildSchedule(makeSubunit())

    // Distinct schedule_id returned (never reuses the parent's)
    expect(handle.schedule_id).toBeTruthy()
    expect(handle.schedule_id).not.toBe(parentExecId)

    // The child schedule row exists with the persisted parent correlation
    const config = readScheduleConfig(handle.schedule_id)
    expect(config.parent_task_dispatch).toEqual({
      execution_id: parentExecId,
      node_id: nodeId,
    })
    // Child config is a valid WorkflowConfig v3.0
    expect(config.schema_version).toBe("3.0")
    expect(config.type).toBe("workflow")
    expect(config.workflow_chain[0].workflow_ref).toBe("e2e-tp/simple-spec-workflow")
  })

  it("resumeOnCompletion reads the marker from the DB and calls the parent-resume hook (restart-safe)", async () => {
    const parentExecId = "exec-parent-2"
    const nodeId = "dispatch-node-2"
    seedRunningParent(parentExecId, nodeId)

    // Dispatch (creates the child schedule + marker), then simulate the child
    // completing by calling resumeOnCompletion with the child's output snapshot.
    const handle = await service.dispatchChildSchedule(makeSubunit())
    const childOutput = { result: "E2E_TP_synthesis_body", meta: { ok: true } }
    await service.resumeOnCompletion(handle, childOutput)

    // The parent-resume hook received the persisted parent correlation + raw output
    expect(resumeSpy).toHaveBeenCalledTimes(1)
    expect(resumeSpy).toHaveBeenCalledWith(parentExecId, nodeId, childOutput)
  })

  it("resumeOnCompletion works after a simulated restart (no in-memory closure)", async () => {
    const parentExecId = "exec-parent-3"
    const nodeId = "dispatch-node-3"
    seedRunningParent(parentExecId, nodeId)

    // Process A: dispatch (records the marker in the DB), then "die" (drop the
    // service instance — any in-memory closure capturing the parent link is lost).
    const handle = await service.dispatchChildSchedule(makeSubunit())

    // Process B: a brand-new service instance (only the DB survives). It must
    // still be able to resume because the correlation is persisted on the child.
    const workspaceServiceStub = { createFromSpec: vi.fn() } as any
    const restarted = new TaskDispatchService({
      db,
      workspaceId: WORKSPACE_ID,
      workspacePath: WORKSPACE_PATH,
      org: ORG,
      workspaceService: workspaceServiceStub,
      sse: new SSEService(),
    })
    const restartedSpy = vi.fn().mockResolvedValue(undefined)
    restarted.setResumeParentCallback(restartedSpy)

    await restarted.resumeOnCompletion(handle, { result: "E2E_TP_restarted_synth" })

    expect(restartedSpy).toHaveBeenCalledWith(parentExecId, nodeId, { result: "E2E_TP_restarted_synth" })
  })

  it("resumeOnCompletion throws when the child schedule has no parent marker", async () => {
    // Insert a bare child schedule with no parent_task_dispatch marker
    const scheduleId = randomUUID()
    db.prepare(
      `INSERT INTO schedules (id, org, name, cron_expression, timezone, config, job_type, status, created_at, updated_at, version, consecutive_failures, max_retain, enabled, notify_on_failure, parallel_policy, input_values) VALUES (?, ?, ?, NULL, 'UTC', '{}', 'workflow', 'done', ?, ?, 1, 0, 10, 1, 0, 'skip', '{}')`,
    ).run(scheduleId, ORG, "orphan-child", new Date().toISOString(), new Date().toISOString())

    await expect(
      service.resumeOnCompletion({ schedule_id: scheduleId }, { result: "x" }),
    ).rejects.toThrow(/parent_task_dispatch/)
    expect(resumeSpy).not.toHaveBeenCalled()
  })

  it("resumeOnCompletion throws when the resume callback is not wired", async () => {
    const unwired = new TaskDispatchService({
      db,
      workspaceId: WORKSPACE_ID,
      workspacePath: WORKSPACE_PATH,
      org: ORG,
      workspaceService: { createFromSpec: vi.fn() } as any,
      sse: new SSEService(),
    })
    const scheduleId = randomUUID()
    db.prepare(
      `INSERT INTO schedules (id, org, name, cron_expression, timezone, config, job_type, status, created_at, updated_at, version, consecutive_failures, max_retain, enabled, notify_on_failure, parallel_policy, input_values) VALUES (?, ?, ?, NULL, 'UTC', ?, 'workflow', 'done', ?, ?, 1, 0, 10, 1, 0, 'skip', '{}')`,
    ).run(
      scheduleId, ORG, "unwired-child",
      JSON.stringify({ parent_task_dispatch: { execution_id: "x", node_id: "y" } }),
      new Date().toISOString(), new Date().toISOString(),
    )

    await expect(
      unwired.resumeOnCompletion({ schedule_id: scheduleId }, { result: "x" }),
    ).rejects.toThrow(/resumeParent/)
  })
})
