// packages/server/src/__tests__/chain-complete-status-race.test.ts
//
// goal-task-dev E2E T6 — status-mirror race fix.
//
// engine.ts:431 fires onComplete INSIDE run(); the server persists the final
// execution status only AFTER run() returns (ExecutionLifecycle). The chain
// callback used to re-read the DB unconditionally → stale 'running' → a
// SUCCESSFUL schedule/task finalized as 'failed'. Fix: prefer an already-final
// DB status; fall back to the engine-reported status (with the allSkipped→failed
// mirror rule); legacy behavior when neither is available.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import { WorkflowExecutor } from "../services/scheduler/executors/workflow-executor"
import { ScheduleConfigDAO, ScheduleRunDAO, ExecutionDAO } from "../db/dao"

const mockSSE = { emit: vi.fn() } as any
const mockWorkspaceService = { createFromSpec: vi.fn(), delete: vi.fn() } as any

const wsId = "gtd-race-ws"
const schedId = "gtd-race-sched"
const schedExecId = "gtd-race-se"
const execId = "gtd-race-exec"

describe("WorkflowExecutor.handleChainComplete — status mirror race (goal-task-dev T6)", () => {
  let db: Database.Database
  let executor: WorkflowExecutor

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    db.pragma("foreign_keys = OFF")
    db.prepare(
      `INSERT INTO workspaces (id, name, org, path, created_at, updated_at)
       VALUES (?, 'gtd-race-ws', 'gtd-race-org', '/tmp/gtd-race-ws', datetime('now'), datetime('now'))`,
    ).run(wsId)
    executor = new WorkflowExecutor(
      mockSSE,
      new ScheduleConfigDAO(db),
      new ScheduleRunDAO(db),
      new ExecutionDAO(db),
      mockWorkspaceService,
    )
    // Requirement schedule (task origin) → status tracked in `status` column + task mirror
    db.prepare(
      `INSERT INTO schedules (
        id, org, name, cron_expression, timezone, enabled, timeout_seconds, notify_on_failure,
        created_at, updated_at, job_type, config, parallel_policy, version,
        consecutive_failures, max_retain, status, origin_type, claimed_at
      ) VALUES (?, 'gtd-race-org', 'gtd-race-task', NULL, 'UTC', 1, 3600, 0,
        datetime('now'), datetime('now'), 'workflow', '{"type":"workflow","workflow_chain":[]}', 'skip', 1, 0, 10, 'claimed', 'task', ?)`,
    ).run(schedId, new Date().toISOString())
    db.prepare(
      `INSERT INTO schedule_executions (id, schedule_id, status, trigger_type, triggered_at,
        timezone_offset, timezone_iana, created_at, triggered_by)
       VALUES (?, ?, 'running', 'scheduled', datetime('now'), '+00:00', 'UTC', datetime('now'), 'scheduler')`,
    ).run(schedExecId, schedId)
    mockSSE.emit.mockClear()
  })

  afterEach(() => {
    db.close()
  })

  function seedExecution(status: string): void {
    db.prepare(
      `INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name,
        status, triggered_by, org, created_at, updated_at)
       VALUES (?, ?, '0', 0, 'task-dev', 'task-dev', ?, 'scheduler', 'gtd-race-org', datetime('now'), datetime('now'))`,
    ).run(execId, wsId, status)
  }

  function seedNode(nodeId: string, status: string): void {
    db.prepare(
      `INSERT INTO node_executions (id, execution_id, node_id, node_type, status)
       VALUES (?, ?, ?, 'agent', ?)`,
    ).run(`${execId}-${nodeId}`, execId, nodeId, status)
  }

  function complete(opts: { engineFinalStatus?: string }): void {
    const schedule = new ScheduleConfigDAO(db).findById(schedId)!
    ;(executor as any).handleChainComplete({
      executionId: execId,
      schedExecId,
      schedWsId: "sw-nonexistent", // → workspace cleanup skipped (composite-test precedent)
      scheduleId: schedId,
      triggeredAt: Date.now() - 1000,
      notifyOnFailure: false,
      schedule,
      maxRetain: 10,
      isRequirement: true,
      engineFinalStatus: opts.engineFinalStatus,
    })
  }

  const scheduleStatus = () =>
    (db.prepare("SELECT status FROM schedules WHERE id = ?").get(schedId) as { status: string }).status
  const schedExecStatus = () =>
    (db.prepare("SELECT status FROM schedule_executions WHERE id = ?").get(schedExecId) as { status: string }).status

  it("THE BUG: DB stale 'running' + engine 'completed' → chain finalizes COMPLETED (was: failed)", () => {
    seedExecution("running")
    seedNode("develop", "completed")
    seedNode("ship", "completed")

    complete({ engineFinalStatus: "completed" })

    expect(scheduleStatus()).toBe("done")
    expect(schedExecStatus()).toBe("completed")
    expect(mockSSE.emit).toHaveBeenCalledWith("taskpool", {
      event: "schedule_status",
      data: { schedule_id: schedId, status: "done" },
    })
  })

  it("engine 'completed' mirrors allSkipped→failed: 0 completed real nodes + skipped>0 → failed", () => {
    seedExecution("running")
    seedNode("develop", "skipped")
    seedNode("ship", "skipped")

    complete({ engineFinalStatus: "completed" })

    expect(scheduleStatus()).toBe("failed")
    expect(schedExecStatus()).toBe("failed")
  })

  it("allSkipped parity: zero node rows at all stays completed (lifecycle length>0 guard)", () => {
    seedExecution("running")

    complete({ engineFinalStatus: "completed" })

    expect(scheduleStatus()).toBe("done")
  })

  it("legacy: no engine status + stale 'running' DB → failed (pre-fix behavior preserved)", () => {
    seedExecution("running")
    seedNode("develop", "completed")

    complete({})

    expect(scheduleStatus()).toBe("failed")
  })

  it("DB already final 'completed' wins without engine arg (late/re-entry finalize)", () => {
    seedExecution("completed")
    seedNode("develop", "completed")

    complete({})

    expect(scheduleStatus()).toBe("done")
  })

  it("conflict: DB final 'failed' outranks engine 'completed' (post-persistence truth wins)", () => {
    seedExecution("failed")
    seedNode("develop", "failed")

    complete({ engineFinalStatus: "completed" })

    expect(scheduleStatus()).toBe("failed")
  })
})
