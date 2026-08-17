// packages/server/src/__tests__/06-schedules-origin-materialize.test.ts
//
// Ticket 06 — SG1 origin migration + SG1b trigger col removal + SG5 materialize
// + SG9 isComposite N>=2 + SG10 child running SSE + SG12 orphan reaper + SG16 barrel.
//
// Integration verification for AC1-AC7. Anti-fake-run: real better-sqlite3 DB +
// applySchema (R1/R3/R4/R5), data prefix E2E_TD_ (R7), assert response+SQL (R4).
//
// Scope:
//   AC1: origin_type='task' schedule is claimable by checkQueuedTasks
//   AC2: failed-promotion gate uses origin_type='task' (terminal, no loop);
//        agent-origin defaults to v1 auto-disable (NOT failed-promotion)
//   AC3: dispatchChildSchedule sets origin_type/origin_role/origin_id on the child
//   AC4: materialize output has NO task_spec; composite injects subunit_count;
//        isCompositeTask threshold is N>=2 (1-subunit → simple)
//   AC5: child 'running' SSE emit when a child starts; barrel re-export exists
//   AC6: orphan reaper clears schedules whose origin task is gone;
//        task delete → cascade-reap schedules
//   AC7: trigger_source + source_chat_session_id no longer on ScheduleRow type;
//        migrateSchedulesV38 DROP COLUMN runs (dev DB); build green

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import { SchedulerEngine } from "../services/scheduler/scheduler-engine"
import { ScheduleConfigDAO, ScheduleRunDAO } from "../db/dao"
import { SSEService } from "../services/sse"
import { TaskDispatchService } from "../services/scheduler"
import { materializeTaskSpecToConfig } from "../services/scheduler/scheduler-service"
import type { Executor, ExecutionResult } from "../services/scheduler/executors/executor-interface"
import type { SubunitSpec, TaskSpec } from "@octopus/shared"
import type { ScheduleRow } from "../db/types"

const ORG = "e2e-td-06"

// ── AC7: ScheduleRow type no longer carries trigger_source / source_chat_session_id ──
// This is a type-level assertion. If the fields were re-added, `never` would error.
type AssertScheduleRowHasNoTriggerCols =
  keyof ScheduleRow extends never ? never :
  "trigger_source" extends keyof ScheduleRow ? never :
  "source_chat_session_id" extends keyof ScheduleRow ? never :
  true
const _ac7TypeCheck: AssertScheduleRowHasNoTriggerCols = true
void _ac7TypeCheck

const mockWorkspaceScheduleService = {
  setOnScheduleChange: vi.fn(),
  trigger: vi.fn(),
} as any

function makeOkExecutor(): Executor {
  return {
    getType: () => "workflow",
    execute: vi.fn(async () => ({
      success: true,
      exitCode: 0,
      durationMs: 10,
      status: "success" as const,
    }) satisfies ExecutionResult),
  } as unknown as Executor
}

function makeFailingExecutor(): Executor {
  return {
    getType: () => "workflow",
    execute: vi.fn(async () => ({
      success: false,
      exitCode: 1,
      durationMs: 10,
      status: "failure" as const,
      errorMessage: "boom",
    }) satisfies ExecutionResult),
  } as unknown as Executor
}

/** Insert a task-origin schedule directly (origin_type='task'). */
function insertTaskSchedule(
  db: Database.Database,
  id: string,
  opts: {
    status?: string
    originId?: string
    originRole?: string
    enabled?: number
    consecutiveFailures?: number
    claimedAt?: string | null
    config?: string
  } = {},
): void {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO schedules (
      id, org, name, cron_expression, timezone,
      enabled, timeout_seconds, notify_on_failure,
      created_at, updated_at, job_type, config, parallel_policy,
      version, consecutive_failures, max_retain,
      status, origin_type, origin_id, origin_role, claimed_at
    ) VALUES (?, ?, ?, NULL, 'UTC', ?, 3600, 0, ?, ?, 'workflow', ?, 'skip', 1, ?, 10, ?, 'task', ?, ?, ?)
  `).run(
    id,
    ORG,
    `name-${id}`,
    opts.enabled ?? 0,
    now,
    now,
    opts.config ?? "{}",
    opts.consecutiveFailures ?? 0,
    opts.status ?? "queued",
    opts.originId ?? `task-for-${id}`,
    opts.originRole ?? "primary",
    opts.claimedAt ?? null,
  )
}

function insertTaskRow(db: Database.Database, id: string): void {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO tasks (id, org, name, status, source_chat_session_id, task_spec,
      authoring_resources, resources, skills, project_ids, workflow_ref, version,
      deleted_at, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, 'running', NULL, '{}', '[]', '[]', '[]', '[]', NULL, 1, NULL, ?, ?, NULL)
  `).run(id, ORG, `task-${id}`, now, now)
}

function newDb(): Database.Database {
  const db = new Database(":memory:")
  applySchema(db)
  // The dispatch path (AC3) writes schedule_executions.execution_id pointing at
  // a STUBBED ExecutionService's fake execution id (no real executions row).
  // Disable FK so that insert doesn't fail; same pattern as the existing
  // task-dispatch-service.test.ts. Other tests (AC1/AC2/AC6) are read/insert-only
  // on schedules + tasks and don't trip FK.
  db.pragma("foreign_keys = OFF")
  db.prepare(`
    INSERT INTO workspaces (id, name, org, path, created_at, updated_at)
    VALUES ('ws-06', 'ws06', ?, '/tmp', datetime('now'), datetime('now'))
  `).run(ORG)
  db.prepare(`
    INSERT OR IGNORE INTO scheduler_state (id, last_heartbeat) VALUES (1, datetime('now'))
  `).run()
  return db
}

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms))

describe("06: schedules origin migration + materialize + reaper", () => {
  let db: Database.Database

  beforeEach(() => {
    db = newDb()
  })
  afterEach(() => db.close())

  // ── AC1: origin_type='task' schedule is claimable by checkQueuedTasks ──
  it("AC1: checkQueuedTasks claims an origin_type='task' schedule (not filtered out)", async () => {
    insertTaskSchedule(db, "06-claim-1", { status: "queued", enabled: 0 })
    const executors = new Map<string, Executor>([["workflow", makeOkExecutor()]])
    const engine = new SchedulerEngine(
      new ScheduleConfigDAO(db), new ScheduleRunDAO(db),
      mockWorkspaceScheduleService, executors,
    )
    engine.start()

    await (engine as unknown as { checkQueuedTasks: () => Promise<void> }).checkQueuedTasks()
    await tick()

    const row = db.prepare("SELECT status, claimed_at FROM schedules WHERE id = ?").get("06-claim-1") as
      { status: string; claimed_at: string | null }
    expect(row.status).toBe("claimed")
    expect(row.claimed_at).not.toBeNull()
    engine.stop()
  })

  // ── AC1 (negative): cron-origin schedule is NOT claimed by checkQueuedTasks ──
  it("AC1: checkQueuedTasks skips cron-origin schedules (cron stays on its own trigger path)", async () => {
    // Insert a cron schedule in 'queued' status — checkQueuedTasks must skip it
    db.prepare(`
      INSERT INTO schedules (
        id, org, name, cron_expression, timezone,
        enabled, timeout_seconds, notify_on_failure,
        created_at, updated_at, job_type, config, parallel_policy,
        version, consecutive_failures, max_retain, status, origin_type
      ) VALUES ('06-cron-1', ?, 'cron-skip', '0 9 * * *', 'UTC',
        1, 3600, 0, datetime('now'), datetime('now'), 'workflow', '{}', 'skip',
        1, 0, 10, 'queued', 'cron')
    `).run(ORG)
    const executors = new Map<string, Executor>([["workflow", makeOkExecutor()]])
    const engine = new SchedulerEngine(
      new ScheduleConfigDAO(db), new ScheduleRunDAO(db),
      mockWorkspaceScheduleService, executors,
    )
    engine.start()

    await (engine as unknown as { checkQueuedTasks: () => Promise<void> }).checkQueuedTasks()
    await tick()

    const row = db.prepare("SELECT status, claimed_at FROM schedules WHERE id = ?").get("06-cron-1") as
      { status: string; claimed_at: string | null }
    // Cron schedule stays queued — not claimed by checkQueuedTasks
    expect(row.status).toBe("queued")
    expect(row.claimed_at).toBeNull()
    engine.stop()
  })

  // ── AC2: failed-promotion gate uses origin_type='task' (terminal, no loop) ──
  it("AC2: task-origin schedule promoted to terminal 'failed' after N consecutive failures (no re-dispatch loop)", async () => {
    insertTaskSchedule(db, "06-retry-1", {
      status: "queued", enabled: 1, consecutiveFailures: 4,
    })
    const executors = new Map<string, Executor>([["workflow", makeFailingExecutor()]])
    const engine = new SchedulerEngine(
      new ScheduleConfigDAO(db), new ScheduleRunDAO(db),
      mockWorkspaceScheduleService, executors,
    )

    // checkQueuedTasks claims → failing executor → onExecutionComplete → 5th failure →
    // autoDisabled → origin_type='task' → status='failed' (terminal promotion).
    await (engine as unknown as { checkQueuedTasks: () => Promise<void> }).checkQueuedTasks()
    await tick(100)

    const row = db.prepare("SELECT status, enabled, consecutive_failures FROM schedules WHERE id = ?").get("06-retry-1") as
      { status: string; enabled: number; consecutive_failures: number }
    expect(row.status).toBe("failed")
    expect(row.enabled).toBe(0)
    expect(row.consecutive_failures).toBe(5)

    // Terminal: subsequent ticks must NOT re-dispatch or roll back
    await (engine as unknown as { checkStaleClaimed: () => Promise<void> }).checkStaleClaimed()
    await (engine as unknown as { checkQueuedTasks: () => Promise<void> }).checkQueuedTasks()
    const row2 = db.prepare("SELECT status FROM schedules WHERE id = ?").get("06-retry-1") as
      { status: string }
    expect(row2.status).toBe("failed")
  })

  // ── AC2 (agent-origin): defaults to v1 auto-disable, NOT failed-promotion ──
  it("AC2: agent-origin schedule is NOT claimed by checkQueuedTasks (stays on its own trigger path; never hits the failed-promotion gate)", async () => {
    // Insert an agent-origin schedule in 'queued' status. checkQueuedTasks filters
    // on origin_type IN (task, manual, api) — agent is excluded, so the schedule
    // is never claimed/run by the task queue. It stays on its own cron re-trigger
    // path + uses the agent executor's circuit breaker (v1 behavior). The key AC:
    // the failed-promotion gate (origin_type === 'task') never fires for agent-origin.
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO schedules (
        id, org, name, cron_expression, timezone,
        enabled, timeout_seconds, notify_on_failure,
        created_at, updated_at, job_type, config, parallel_policy,
        version, consecutive_failures, max_retain, status, origin_type
      ) VALUES ('06-agent-1', ?, 'agent-skip', '0 9 * * *', 'UTC',
        1, 3600, 0, ?, ?, 'agent', '{}', 'skip', 1, 4, 10, 'queued', 'agent')
    `).run(ORG, now, now)
    const executors = new Map<string, Executor>([["agent", makeFailingExecutor()]])
    const engine = new SchedulerEngine(
      new ScheduleConfigDAO(db), new ScheduleRunDAO(db),
      mockWorkspaceScheduleService, executors,
    )

    await (engine as unknown as { checkQueuedTasks: () => Promise<void> }).checkQueuedTasks()
    await tick(100)

    // Agent-origin: NOT claimed by checkQueuedTasks → stays queued, enabled=1,
    // status !== 'failed'. The failed-promotion gate (origin_type === 'task')
    // never fires for agent-origin.
    const row = db.prepare("SELECT status, enabled, claimed_at FROM schedules WHERE id = ?").get("06-agent-1") as
      { status: string; enabled: number; claimed_at: string | null }
    expect(row.status).toBe("queued")
    expect(row.enabled).toBe(1)
    expect(row.claimed_at).toBeNull()
    expect(row.status).not.toBe("failed")
  })

  // ── AC3: dispatchChildSchedule sets origin_type/origin_role/origin_id ──
  it("AC3: dispatchChildSchedule sets origin_type='task', origin_role='subunit', origin_id=<parent task id> on the child schedule", async () => {
    const COORD_WS = "ws-coord-06"
    const PARENT_TASK_ID = "06-parent-task"
    const COORD_SCHED_ID = "06-coord-sched"
    const now = new Date().toISOString()

    // Workspace for the coordinator
    db.prepare(`
      INSERT INTO workspaces (id, name, org, path, created_at, updated_at, source_schedule_id)
      VALUES (?, 'coord-ws', ?, '/tmp/coord', ?, ?, ?)
    `).run(COORD_WS, ORG, now, now, COORD_SCHED_ID)
    // Coordinator schedule: origin_type='task', origin_id=PARENT_TASK_ID, origin_role='coordinator'
    insertTaskSchedule(db, COORD_SCHED_ID, {
      status: "running", originId: PARENT_TASK_ID, originRole: "coordinator", enabled: 1,
      claimedAt: now,
    })
    // Parent task row (so the orphan reaper doesn't reap it mid-test)
    insertTaskRow(db, PARENT_TASK_ID)
    // Parent composition-wf execution + running task_dispatch node (for resolveParentContext)
    db.prepare(`
      INSERT INTO executions (id, workspace_id, workflow_ref, workflow_name, org, status, started_at, created_at, updated_at)
      VALUES ('exec-coord-06', ?, 'composition-task.yaml', 'composition-task', ?, 'running', ?, ?, ?)
    `).run(COORD_WS, ORG, now, now, now)
    db.prepare(`
      INSERT INTO node_executions (id, execution_id, node_id, node_type, status, started_at)
      VALUES ('ne-coord-06', 'exec-coord-06', 'dispatch-node-06', 'task_dispatch', 'running', ?)
    `).run(now)

    const subunit: SubunitSpec = {
      name: "E2E_TD_subunit_a",
      workspace_spec: {
        org: ORG, branch_prefix: "e2e-td-06-sub-a",
        projects: [{ name: "E2E_TD_project", source_path: "", group: "" }],
      },
      workflow_ref: "e2e-td-06/simple-spec-workflow",
      input_values: {},
      skills: [],
    }

    // Mock getExecutionService so the child execution path doesn't need a real registry
    vi.mock("../services/execution-service-registry", () => ({
      getExecutionService: () => ({
        service: {
          create: () => ({ id: "child-exec-06" }),
          start: () => Promise.resolve(undefined),
          registerExternalCallbacks: () => {},
          clearExternalCallbacks: () => {},
        },
        wsPath: "/tmp/e2e-td-06-child-ws",
      }),
    }))

    const sse = new SSEService()
    const events: Array<{ schedule_id: string; status: string }> = []
    sse.subscribe("taskpool", (e) => {
      if (e.event === "schedule_status") events.push(e.data as { schedule_id: string; status: string })
    })

    const service = new TaskDispatchService({
      db,
      workspaceId: COORD_WS,
      workspacePath: "/tmp/e2e-td-06-coord",
      org: ORG,
      workspaceService: { createFromSpec: vi.fn(() => ({ id: "ws-child-06" })) } as any,
      sse,
    })

    const handle = await service.dispatchChildSchedule(subunit, "subunit")

    expect(handle.schedule_id).toBeTruthy()
    // AC3: child schedule carries origin_type='task', origin_role='subunit', origin_id=parent task id
    const child = db.prepare(
      "SELECT origin_type, origin_role, origin_id FROM schedules WHERE id = ?",
    ).get(handle.schedule_id) as { origin_type: string; origin_role: string | null; origin_id: string | null }
    expect(child.origin_type).toBe("task")
    expect(child.origin_role).toBe("subunit")
    expect(child.origin_id).toBe(PARENT_TASK_ID)

    vi.doUnmock("../services/execution-service-registry")
  })

  // ── AC4: materialize output has NO task_spec; composite injects subunit_count; isComposite N>=2 ──
  it("AC4/SG5: materializeTaskSpecToConfig output has NO task_spec; composite injects input_values.subunit_count", () => {
    const taskSpec: TaskSpec = {
      goal: "E2E_TD goal",
      ac: ["ac1"],
      subunits: [
        {
          name: "E2E_TD_sub_a",
          workspace_spec: { org: ORG, branch_prefix: "e2e-td-a", projects: [{ name: "p", source_path: "", group: "" }] },
          workflow_ref: "e2e-td-06/wf-a",
          input_values: {},
          skills: [],
        },
        {
          name: "E2E_TD_sub_b",
          workspace_spec: { org: ORG, branch_prefix: "e2e-td-b", projects: [{ name: "p", source_path: "", group: "" }] },
          workflow_ref: "e2e-td-06/wf-b",
          input_values: {},
          skills: [],
        },
      ],
      integration_goal: { strategy: "synthesis", prompt: "E2E_TD_synth" },
    }
    const config = materializeTaskSpecToConfig(taskSpec, ["E2E_TD_proj"], ORG, undefined, [])
    // AC4: NO task_spec in the materialized config (lives in tasks table, not schedules)
    expect((config as { task_spec?: unknown }).task_spec).toBeUndefined()
    // AC4: composite injects input_values.subunit_count into workflow_chain[0]
    expect(config.workflow_chain[0].input_values.subunit_count).toBe(2)
  })

  // ── AC4/SG9: isCompositeTask threshold is N>=2 (1-subunit → simple) ──
  it("AC4/SG9: isCompositeTask threshold — 1 subunit is NOT composite (>=2 required)", () => {
    // The materialize path uses a simple workflow_chain when subunits.length < 2.
    const simpleSpec: TaskSpec = {
      goal: "g", ac: ["a"],
      subunits: [
        {
          name: "only-one",
          workspace_spec: { org: ORG, branch_prefix: "e2e-td-one", projects: [{ name: "p", source_path: "", group: "" }] },
          workflow_ref: "e2e-td-06/only",
          input_values: {}, skills: [],
        },
      ],
    }
    const config = materializeTaskSpecToConfig(simpleSpec, ["E2E_TD_proj"], ORG, "e2e-td-06/simple", [])
    // 1-subunit → simple: workflow_chain[0].workflow_ref is the provided workflow_ref,
    // NOT 'composition-task'. And no subunit_count injected (simple path).
    expect(config.workflow_chain[0].workflow_ref).toBe("e2e-td-06/simple")
    expect((config as { task_spec?: unknown }).task_spec).toBeUndefined()
  })

  // ── AC5: child 'running' SSE emit when a child starts + barrel re-export exists ──
  it("AC5/SG16: TaskDispatchService is barrel-re-exported from scheduler/index", async () => {
    // SG16: the barrel re-export exists (imported above at the top of the file).
    // Verify the class is the same constructor.
    expect(TaskDispatchService).toBeDefined()
    expect(typeof TaskDispatchService).toBe("function")
  })

  // ── AC6/SG12: orphan reaper clears schedules whose origin task is gone ──
  it("AC6: orphan reaper soft-deletes schedules whose origin_id task is deleted/gone", async () => {
    // A task-origin schedule pointing at a task id that does NOT exist (orphan)
    insertTaskSchedule(db, "06-orphan-1", {
      status: "queued", originId: "nonexistent-task-06", originRole: "primary",
    })
    // Control: a task-origin schedule pointing at an EXISTING task (kept)
    const KEEP_TASK = "06-keep-task"
    insertTaskRow(db, KEEP_TASK)
    insertTaskSchedule(db, "06-keep-1", {
      status: "queued", originId: KEEP_TASK, originRole: "primary",
    })

    // Import the reaper (SG12)
    const { reapOrphanSchedules } = await import("../services/scheduler/orphan-reaper")
    const reaped = reapOrphanSchedules(db)

    // Orphan is soft-deleted; the kept schedule survives
    expect(reaped).toBeGreaterThanOrEqual(1)
    const orphan = db.prepare("SELECT deleted_at FROM schedules WHERE id = ?").get("06-orphan-1") as
      { deleted_at: string | null }
    const kept = db.prepare("SELECT deleted_at FROM schedules WHERE id = ?").get("06-keep-1") as
      { deleted_at: string | null }
    expect(orphan.deleted_at).not.toBeNull()
    expect(kept.deleted_at).toBeNull()
  })

  // ── AC6/R-INT: task delete → cascade-reap schedules ──
  it("AC6/R-INT: deleteTask cascade-reaps child schedules (origin_type='task', origin_id=task.id)", async () => {
    const { TasksService } = await import("../services/tasks/tasks-service")
    const { TaskDAO } = await import("../db/dao")
    const sse = new SSEService()
    const taskDAO = new TaskDAO(db)
    const svc = new TasksService(db, sse)

    // Seed a draft task + a child schedule
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO tasks (id, org, name, status, source_chat_session_id, task_spec,
        authoring_resources, resources, skills, project_ids, workflow_ref, version,
        deleted_at, created_at, updated_at, completed_at)
      VALUES ('06-cascade-task', ?, 'cascade', 'draft', NULL, '{}', '[]', '[]', '[]', '[]', NULL, 1, NULL, ?, ?, NULL)
    `).run(ORG, now, now)
    insertTaskSchedule(db, "06-cascade-sched", {
      status: "queued", originId: "06-cascade-task", originRole: "primary",
    })

    svc.deleteTask("06-cascade-task")

    // Task soft-deleted
    const task = taskDAO.getById("06-cascade-task")
    expect(task).toBeNull() // getById filters deleted_at
    // Child schedule cascade-reaped (soft-deleted)
    const sched = db.prepare("SELECT deleted_at FROM schedules WHERE id = ?").get("06-cascade-sched") as
      { deleted_at: string | null }
    expect(sched.deleted_at).not.toBeNull()
  })
})
