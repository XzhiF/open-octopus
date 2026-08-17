// packages/server/src/__tests__/composite-dispatch.test.ts
//
// Ticket 04 — server composite dispatch runtime (coordinator-ws + composition wf +
// parent aggregation). Verifies the SERVER-side dispatch path: a composite config
// (task_spec.subunits present) is dispatched by materializing a coordinator-ws with
// NO projects and running the composition-task workflow_ref, feeding subunits as
// input_values. Parent schedule status = 'running' while the composition wf runs;
// 'done' when it completes with no failed children; 'failed' if any child failed.
//
// The engine-level pause/resume (Loop + task_dispatch inner node + moa) is owned by
// tickets 02/03 and covered by packages/engine/src/__tests__/task-dispatch*.test.ts.
// Here, getExecutionService is mocked so the composition wf "completes" in a
// controlled way — this test asserts the SERVER dispatch decision + coordinator-ws
// materialization + parent-status wiring, not the engine's loop semantics.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import { WorkflowExecutor } from "../services/scheduler/executors/workflow-executor"
import { ScheduleConfigDAO, ScheduleRunDAO, ExecutionDAO } from "../db/dao"
import type { SchedulerJob, WorkflowConfig, SubunitSpec } from "@octopus/shared"

const COMPOSITION_WF_REF = "composition-task"

// ── Mock getExecutionService ──────────────────────────────────────────
// The coordinator-ws's ExecutionService is stubbed so the composition wf does not
// actually run through the engine (which would need Loop+task_dispatch support —
// a 02/engine concern). createSpy captures the workflow_ref + input_values the
// dispatch path passes so we can assert the composite materialization shape.
const createSpy = vi.fn(() => ({ id: "exec-comp-1" }))
const startSpy = vi.fn(async () => undefined)
const registerCallbacksSpy = vi.fn()
const clearCallbacksSpy = vi.fn()
vi.mock("../services/execution-service-registry", () => ({
  getExecutionService: vi.fn(() => ({
    service: {
      create: createSpy,
      start: startSpy,
      registerExternalCallbacks: registerCallbacksSpy,
      clearExternalCallbacks: clearCallbacksSpy,
    },
    wsPath: "/tmp/e2e-tp-composite-ws",
  })),
}))

function makeSubunit(name: string): SubunitSpec {
  return {
    name,
    workspace_spec: {
      org: "e2e-tp-org",
      branch_prefix: `e2e-tp-${name}`,
      projects: [{ name: "E2E_TP_project", source_path: "", group: "" }],
    },
    workflow_ref: "e2e-tp/simple-spec-workflow",
    input_values: {},
    skills: [],
  }
}

/** MINIMAL composite config shape ticket 04 wires for runtime dispatch (G9). The
 *  workspace_spec carries a placeholder project for schema validity, but the
 *  coordinator-ws is materialized with NO projects (orchestration only — spec D4). */
function makeCompositeConfig(subunits: SubunitSpec[]): WorkflowConfig {
  return {
    schema_version: "3.0",
    type: "workflow",
    workspace_spec: {
      org: "e2e-tp-org",
      branch_prefix: "e2e-tp-coordinator",
      projects: [{ name: "E2E_TP_coordinator", source_path: "", group: "" }],
    },
    workflow_chain: [{ workflow_ref: COMPOSITION_WF_REF, input_values: {} }],
    max_retain: 10,
    task_spec: {
      goal: "E2E_TP_composite_goal",
      ac: ["E2E_TP_ac_1"],
      subunits,
      integration_goal: { strategy: "synthesis", prompt: "E2E_TP_synthesis_prompt" },
    },
  }
}

function buildCompositeJob(scheduleId: string, config: WorkflowConfig): SchedulerJob {
  return {
    id: scheduleId,
    name: "e2e-tp-composite-task",
    job_type: "workflow",
    cron_expression: null,
    timezone: "UTC",
    enabled: true,
    org: "e2e-tp-org",
    config,
    parallel_policy: "skip",
    timeout_seconds: 3600,
    notify_on_failure: false,
    version: 1,
    consecutive_failures: 0,
    next_trigger_at: null,
    deleted_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: "claimed",
    trigger_source: "requirement",
    source_chat_session_id: null,
    claimed_at: new Date().toISOString(),
  }
}

describe("WorkflowExecutor composite dispatch (ticket 04)", () => {
  let db: Database.Database
  let executor: WorkflowExecutor
  const wsId = "e2e-tp-ws"
  const schedId = "e2e-tp-sched"
  const schedExecId = "e2e-tp-se"
  const mockSSE = { emit: vi.fn() } as any
  // Stub WorkspaceService — only createFromSpec + delete are used by the dispatch path.
  const createFromSpecSpy = vi.fn(() => ({ id: "e2e-tp-coord-ws" }))
  const mockWorkspaceService = { createFromSpec: createFromSpecSpy, delete: vi.fn() } as any

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    db.pragma("foreign_keys = OFF")
    db.prepare(
      `INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, 'e2e-tp-ws', 'e2e-tp-org', '/tmp/e2e-tp-ws', datetime('now'), datetime('now'))`,
    ).run(wsId)
    executor = new WorkflowExecutor(
      mockSSE,
      new ScheduleConfigDAO(db),
      new ScheduleRunDAO(db),
      new ExecutionDAO(db),
      mockWorkspaceService,
    )
    createSpy.mockClear()
    startSpy.mockClear()
    registerCallbacksSpy.mockClear()
    createFromSpecSpy.mockClear()
    mockSSE.emit.mockClear()
  })

  afterEach(() => {
    db.close()
  })

  function seedCompositeSchedule(config: WorkflowConfig): void {
    db.prepare(
      `INSERT INTO schedules (
        id, org, name, cron_expression, timezone, enabled, timeout_seconds, notify_on_failure,
        created_at, updated_at, job_type, config, parallel_policy, version,
        consecutive_failures, max_retain, status, trigger_source, claimed_at
      ) VALUES (?, 'e2e-tp-org', 'e2e-tp-composite-task', NULL, 'UTC', 1, 3600, 0,
        datetime('now'), datetime('now'), 'workflow', ?, 'skip', 1, 0, 10, 'claimed', 'requirement', ?)`,
    ).run(schedId, JSON.stringify(config), new Date().toISOString())
  }

  function seedScheduleExecution(): void {
    db.prepare(
      `INSERT INTO schedule_executions (
        id, schedule_id, status, trigger_type, triggered_at, timezone_offset,
        timezone_iana, created_at, triggered_by
      ) VALUES (?, ?, 'triggered', 'scheduled', datetime('now'), '+00:00', 'UTC', datetime('now'), 'scheduler')`,
    ).run(schedExecId, schedId)
  }

  // ── AC: composite dispatch → coordinator-ws + composition-task workflow + parent running ──
  it("dispatches a composite config by materializing a coordinator-ws (NO projects) + composition-task workflow_ref + subunits as input_values", async () => {
    const subunits = [makeSubunit("a"), makeSubunit("b"), makeSubunit("c")]
    const config = makeCompositeConfig(subunits)
    seedCompositeSchedule(config)
    seedScheduleExecution()

    const result = await executor.execute(buildCompositeJob(schedId, config), schedExecId)

    // Dispatch succeeded (running — async composition wf fires-and-forgets)
    expect(result.success).toBe(true)
    expect(result.status).toBe("running")

    // Coordinator-ws materialized with NO projects (spec D4 — orchestration only).
    // createFromSpec is the single workspace-creation seam; asserting projects=[] is
    // the load-bearing check that distinguishes composite from simple dispatch.
    expect(createFromSpecSpy).toHaveBeenCalledTimes(1)
    const createArg = createFromSpecSpy.mock.calls[0][0] as { projects: unknown[] }
    expect(createArg.projects).toEqual([])

    // composition-task workflow_ref + subunits/subunit_count/goal/integration_prompt
    // passed to the composition wf's execution (input_values carry the real subunit
    // array — the composition Loop consumes $iteration.subunit downstream).
    expect(createSpy).toHaveBeenCalledTimes(1)
    const createCall = createSpy.mock.calls[0]
    expect(createCall[1]).toMatchObject({
      workflow_ref: COMPOSITION_WF_REF,
      triggered_by: "scheduler",
    })
    const inputValues = createCall[1].input_values as Record<string, unknown>
    expect(inputValues.subunits).toEqual(subunits)
    expect(inputValues.subunit_count).toBe(3)
    expect(inputValues.goal).toBe("E2E_TP_composite_goal")
    expect(inputValues.integration_prompt).toBe("E2E_TP_synthesis_prompt")

    // Parent schedule status='running' while the composition wf is in flight + SSE.
    const sched = db.prepare("SELECT status FROM schedules WHERE id = ?").get(schedId) as {
      status: string
    }
    expect(sched.status).toBe("running")
    expect(mockSSE.emit).toHaveBeenCalledWith("taskpool", {
      event: "schedule_status",
      data: { schedule_id: schedId, status: "running" },
    })
  })

  // ── AC: 父卡聚合状态 — done when composition wf completes (no failed children) ──
  it("parent status='done' when the composition wf completes with no failed children", () => {
    const subunits = [makeSubunit("a"), makeSubunit("b"), makeSubunit("c")]
    const config = makeCompositeConfig(subunits)
    seedCompositeSchedule(config)
    // Composition wf root execution (status='completed' → done path)
    db.prepare(
      `INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name,
        status, triggered_by, org, created_at, updated_at)
       VALUES (?, ?, '0', 0, ?, 'composition-task', 'completed', 'scheduler', 'e2e-tp-org', datetime('now'), datetime('now'))`,
    ).run("exec-comp-1", wsId, COMPOSITION_WF_REF)
    db.prepare(
      `INSERT INTO schedule_executions (id, schedule_id, status, trigger_type, triggered_at,
        timezone_offset, timezone_iana, created_at, triggered_by)
       VALUES (?, ?, 'running', 'scheduled', datetime('now'), '+00:00', 'UTC', datetime('now'), 'scheduler')`,
    ).run(schedExecId, schedId)

    // Simulate the composition wf's onComplete → handleChainComplete
    const schedule = new ScheduleConfigDAO(db).findById(schedId)! as any
    ;(executor as any).handleChainComplete({
      executionId: "exec-comp-1",
      schedExecId,
      schedWsId: "sw-nonexistent", // findScheduleWorkspaceById → null → cleanup skipped
      scheduleId: schedId,
      triggeredAt: Date.now() - 1000,
      notifyOnFailure: false,
      schedule,
      maxRetain: 10,
      isRequirement: true,
    })

    const sched = db.prepare("SELECT status, claimed_at FROM schedules WHERE id = ?").get(schedId) as {
      status: string
      claimed_at: string | null
    }
    expect(sched.status).toBe("done")
    expect(sched.claimed_at).toBeNull()
    expect(mockSSE.emit).toHaveBeenCalledWith("taskpool", {
      event: "schedule_status",
      data: { schedule_id: schedId, status: "done" },
    })
  })

  // ── AC: 任一子 failed → 父 failed (propagate at composition-wf completion) ──
  it("parent status='failed' when the composition wf completes but one child schedule failed", () => {
    const subunits = [makeSubunit("a"), makeSubunit("b"), makeSubunit("c")]
    const config = makeCompositeConfig(subunits)
    seedCompositeSchedule(config)
    db.prepare(
      `INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name,
        status, triggered_by, org, created_at, updated_at)
       VALUES (?, ?, '0', 0, ?, 'composition-task', 'completed', 'scheduler', 'e2e-tp-org', datetime('now'), datetime('now'))`,
    ).run("exec-comp-1", wsId, COMPOSITION_WF_REF)
    db.prepare(
      `INSERT INTO schedule_executions (id, schedule_id, status, trigger_type, triggered_at,
        timezone_offset, timezone_iana, created_at, triggered_by)
       VALUES (?, ?, 'running', 'scheduled', datetime('now'), '+00:00', 'UTC', datetime('now'), 'scheduler')`,
    ).run(schedExecId, schedId)

    // Seed a FAILED child schedule whose config carries the parent_task_dispatch
    // marker pointing at the composition wf root execution (03's TaskDispatchService
    // writes this marker at dispatch time; here we simulate the persisted state).
    const childConfig = {
      schema_version: "3.0",
      type: "workflow",
      workspace_spec: subunits[0].workspace_spec,
      workflow_chain: [{ workflow_ref: subunits[0].workflow_ref, input_values: {} }],
      max_retain: 10,
      parent_task_dispatch: { execution_id: "exec-comp-1", node_id: "dispatch-child" },
    }
    db.prepare(
      `INSERT INTO schedules (
        id, org, name, cron_expression, timezone, enabled, timeout_seconds, notify_on_failure,
        created_at, updated_at, job_type, config, parallel_policy, version,
        consecutive_failures, max_retain, status, trigger_source
      ) VALUES (?, 'e2e-tp-org', 'e2e-tp-child-failed', NULL, 'UTC', 1, 3600, 0,
        datetime('now'), datetime('now'), 'workflow', ?, 'skip', 1, 0, 10, 'failed', 'requirement')`,
    ).run("e2e-tp-child-1", JSON.stringify(childConfig))

    // Composition wf completes (done path) but a failed child exists → propagate failed
    const schedule = new ScheduleConfigDAO(db).findById(schedId)! as any
    ;(executor as any).handleChainComplete({
      executionId: "exec-comp-1",
      schedExecId,
      schedWsId: "sw-nonexistent",
      scheduleId: schedId,
      triggeredAt: Date.now() - 1000,
      notifyOnFailure: false,
      schedule,
      maxRetain: 10,
      isRequirement: true,
    })

    const sched = db.prepare("SELECT status, claimed_at FROM schedules WHERE id = ?").get(schedId) as {
      status: string
      claimed_at: string | null
    }
    expect(sched.status).toBe("failed")
    expect(sched.claimed_at).toBeNull()
    expect(mockSSE.emit).toHaveBeenCalledWith("taskpool", {
      event: "schedule_status",
      data: { schedule_id: schedId, status: "failed" },
    })
  })

  // ── AC: composition wf itself fails → parent failed (05's writer already covers this;
  //  verify the composite path doesn't regress) ──
  it("parent status='failed' when the composition wf itself fails (status='failed')", () => {
    const config = makeCompositeConfig([makeSubunit("a")])
    seedCompositeSchedule(config)
    db.prepare(
      `INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name,
        status, triggered_by, org, created_at, updated_at)
       VALUES (?, ?, '0', 0, ?, 'composition-task', 'failed', 'scheduler', 'e2e-tp-org', datetime('now'), datetime('now'))`,
    ).run("exec-comp-1", wsId, COMPOSITION_WF_REF)
    db.prepare(
      `INSERT INTO schedule_executions (id, schedule_id, status, trigger_type, triggered_at,
        timezone_offset, timezone_iana, created_at, triggered_by)
       VALUES (?, ?, 'running', 'scheduled', datetime('now'), '+00:00', 'UTC', datetime('now'), 'scheduler')`,
    ).run(schedExecId, schedId)

    const schedule = new ScheduleConfigDAO(db).findById(schedId)! as any
    ;(executor as any).handleChainComplete({
      executionId: "exec-comp-1",
      schedExecId,
      schedWsId: "sw-nonexistent",
      scheduleId: schedId,
      triggeredAt: Date.now() - 1000,
      notifyOnFailure: false,
      schedule,
      maxRetain: 10,
      isRequirement: true,
    })

    const sched = db.prepare("SELECT status FROM schedules WHERE id = ?").get(schedId) as {
      status: string
    }
    expect(sched.status).toBe("failed")
  })
})
