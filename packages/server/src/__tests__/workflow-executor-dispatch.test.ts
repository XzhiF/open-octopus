// packages/server/src/__tests__/workflow-executor-dispatch.test.ts
//
// Ticket 08 (ADR-0009): integration tests for the simple-direct-dispatch vs
// composite-coordinator path in WorkflowExecutor.execute.
//
// AC1: simple task (0/1 subunits) → SKIP coordinator-ws. Exactly 1 workspace
//      created with REAL projects (NOT projects=[]). The task's workflow_ref
//      runs directly. No composition-task.yaml, no task_dispatch fan-out.
// AC2: composite task (3 subunits) → 1 coordinator-ws (projects=[]) running
//      composition-task.yaml with input_values.subunit_count=3. The N child
//      workspaces are dispatched later by task_dispatch nodes (not by execute()
//      directly — TaskDispatchService owns that; covered by its own tests).
//
// The old scheduler-executors.test.ts has describe.skip('WorkflowExecutor')
// because createFromSpec needs mocking. This file re-enables execute() testing
// with a stubbed WorkspaceService that captures the projects arg + a stubbed
// ExecutionService registry (task-dispatch-service.test.ts precedent).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import { WorkflowExecutor } from "../services/scheduler/executors/workflow-executor"
import { ScheduleConfigDAO, ScheduleRunDAO, ExecutionDAO, WorkspaceDAO } from "../db/dao"
import { WorkspaceService } from "../services/workspace"
import type { SchedulerJob, WorkflowConfig, TaskSpec } from "@octopus/shared"

// Stub the ExecutionService registry — execute() calls getExecutionService(ws.id)
// after createFromSpec. The stub returns a no-op service (the test does not
// assert chain completion here, only the dispatch-shape decision).
const stubService = {
  create: vi.fn(() => ({ id: "exec-root" })),
  start: vi.fn(async () => {}),
  registerExternalCallbacks: vi.fn(),
  clearExternalCallbacks: vi.fn(),
}
vi.mock("../services/execution-service-registry", () => ({
  getExecutionService: () => ({ service: stubService, wsPath: "/tmp/e2e-td-ws" }),
}))

const mockSSE = { emit: vi.fn() } as any

function makeSubunit(name: string) {
  return {
    name,
    workspace_spec: {
      org: "E2E_TD_org",
      branch_prefix: `e2e-td-${name}`,
      projects: [{ name: `E2E_TD_proj_${name}`, source_path: "", group: "" }],
    },
    workflow_ref: "e2e-td/sub-workflow",
    input_values: {},
    skills: [],
    resources: [],
  }
}

function makeTaskSpec(subunitCount: number): TaskSpec {
  const subunits =
    subunitCount > 0
      ? Array.from({ length: subunitCount }, (_, i) => makeSubunit(`su${i + 1}`))
      : undefined
  return {
    goal: "E2E_TD_goal",
    ac: ["E2E_TD_ac1"],
    subunits,
    resources: [],
    authoring_resources: [],
  }
}

describe("WorkflowExecutor.execute — ADR-0009 simple-direct-dispatch vs composite", () => {
  let db: Database.Database
  let executor: WorkflowExecutor
  let createFromSpecMock: ReturnType<typeof vi.fn>
  const schedId = "e2e-td-sched"
  const execId = "e2e-td-exec"
  const wsId = "e2e-td-ws"
  const ORG = "E2E_TD_org"

  /** Seed a schedule row carrying a materialized WorkflowConfig. Mirrors what
   *  scheduler-service.materializeTaskSpecToConfig + the dispatch seam produce:
   *  simple = real projects + task workflow_ref; composite = projects=[] +
   *  composition-task workflow_ref + (legacy path) task_spec in config OR
   *  (SG5 path) task_spec in the tasks table. This test seeds the LEGACY path
   *  (config carries task_spec) so buildCompositeInputValues reads subunits
   *  directly — isolating the executor's dispatch decision under test. */
  function seedSchedule(config: WorkflowConfig, originType: "task" | "cron" = "task"): void {
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO schedules (
        id, org, name, cron_expression, timezone, enabled, timeout_seconds,
        notify_on_failure, created_at, updated_at, job_type, config,
        parallel_policy, version, consecutive_failures, max_retain, status,
        origin_type, claimed_at
      ) VALUES (?, ?, ?, NULL, 'UTC', 1, 3600, 0, ?, ?, 'workflow', ?, 'skip', 1, 0, 10, 'running', ?, ?)`,
    ).run(
      schedId, ORG, "E2E_TD_task", now, now,
      JSON.stringify(config),
      originType,
      originType === "task" ? new Date(Date.now() - 60_000).toISOString() : null,
    )
  }

  function seedTriggeredExecution(): void {
    db.prepare(
      `INSERT INTO schedule_executions (
        id, schedule_id, status, trigger_type, triggered_at,
        timezone_offset, timezone_iana, created_at, triggered_by
      ) VALUES (?, ?, 'triggered', 'scheduled', datetime('now'), '+00:00', 'UTC', datetime('now'), 'scheduler')`,
    ).run(execId, schedId)
  }

  function buildJob(config: WorkflowConfig): SchedulerJob {
    return {
      id: schedId,
      name: "E2E_TD_task",
      job_type: "workflow",
      cron_expression: "0 9 * * *",
      timezone: "UTC",
      enabled: true,
      org: ORG,
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
    }
  }

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    // FK off: the stubbed ExecutionService returns a fake exec id without
    // inserting an executions row; FK enforcement would reject the link.
    db.pragma("foreign_keys = OFF")
    db.prepare(
      `INSERT INTO workspaces (id, name, org, path, created_at, updated_at)
       VALUES (?, 'E2E_TD_ws', ?, '/tmp/e2e-td', datetime('now'), datetime('now'))`,
    ).run(wsId, ORG)

    createFromSpecMock = vi.fn(() => ({ id: "ws-new-1" }))
    const stubWorkspaceService = {
      createFromSpec: createFromSpecMock,
      delete: vi.fn(),
    } as unknown as WorkspaceService

    executor = new WorkflowExecutor(
      mockSSE,
      new ScheduleConfigDAO(db),
      new ScheduleRunDAO(db),
      new ExecutionDAO(db),
      stubWorkspaceService,
    )
    stubService.create.mockClear()
    stubService.start.mockClear()
    mockSSE.emit.mockClear()
  })

  afterEach(() => {
    db.close()
  })

  // ── AC1: simple task skips coordinator-ws (N+1→1 win) ────────────────
  it("AC1: simple task (0 subunits) → 1 workspace with REAL projects (NOT projects=[])", async () => {
    const config: WorkflowConfig = {
      schema_version: "3.0",
      type: "workflow",
      workspace_spec: {
        org: ORG,
        branch_prefix: "e2e-td-simple",
        projects: [{ name: "E2E_TD_real_proj", source_path: "", group: "" }],
      },
      workflow_chain: [{ workflow_ref: "e2e-td/simple-wf", input_values: {} }],
      max_retain: 10,
    }
    seedSchedule(config)
    seedTriggeredExecution()

    const result = await executor.execute(buildJob(config), execId)

    expect(result.status).not.toBe("failure")
    // Exactly 1 workspace created (NOT a coordinator-ws + children).
    expect(createFromSpecMock).toHaveBeenCalledTimes(1)
    const call = createFromSpecMock.mock.calls[0][0]
    // The decisive assertion: simple task passes REAL projects, NOT [].
    // A coordinator-ws would pass projects=[] (composite path). This is the
    // ADR-0009 N+1→1 win — the simple task skips the coordinator entirely.
    expect(call.projects).not.toEqual([])
    expect(call.projects).toEqual([{ name: "E2E_TD_real_proj", source_path: "", group: "" }])
    // The task's own workflow_ref runs (NOT composition-task).
    expect(call.workflow_chain[0].workflow_ref).toBe("e2e-td/simple-wf")
  })

  it("AC1: 1-subunit task is STILL simple (SG9 threshold N>=2) — skips coordinator-ws", async () => {
    // A 1-subunit task_spec is NOT composite (SG9: subunits.length >= 2).
    // It takes the simple workflow_chain path. This test seeds a config that
    // has a 1-subunit task_spec but a NON-composition workflow_ref — the
    // executor must treat it as simple (real projects, no coordinator-ws).
    const taskSpec = makeTaskSpec(1)
    const config: WorkflowConfig = {
      schema_version: "3.0",
      type: "workflow",
      workspace_spec: {
        org: ORG,
        branch_prefix: "e2e-td-one-su",
        projects: [{ name: "E2E_TD_real_proj", source_path: "", group: "" }],
      },
      workflow_chain: [{ workflow_ref: "e2e-td/simple-wf", input_values: {} }],
      max_retain: 10,
      // Legacy path: config carries task_spec (buildCompositeInputValues reads
      // it). isCompositeTask returns FALSE because subunits.length=1 < 2.
      task_spec: taskSpec,
    } as WorkflowConfig
    seedSchedule(config)
    seedTriggeredExecution()

    const result = await executor.execute(buildJob(config), execId)

    expect(result.status).not.toBe("failure")
    expect(createFromSpecMock).toHaveBeenCalledTimes(1)
    const call = createFromSpecMock.mock.calls[0][0]
    // 1-subunit = simple → real projects, NOT coordinator-ws projects=[].
    expect(call.projects).not.toEqual([])
    expect(call.workflow_chain[0].workflow_ref).toBe("e2e-td/simple-wf")
  })

  // ── AC2: composite N>=2 builds coordinator-ws + composition-task ─────
  it("AC2: composite task (3 subunits) → coordinator-ws (projects=[]) + composition-task wf + subunit_count=3", async () => {
    const taskSpec = makeTaskSpec(3)
    // Mirrors materializeTaskSpecToConfig composite output: projects=[] would
    // be the coordinator-ws shape, but materialize uses a default project when
    // project_ids is empty. The EXECUTOR's coordinator decision is projects=[]
    // (isComposite → []); the materialize-side projects is a separate concern
    // (06/07). Here we seed the composition-task workflow_ref + task_spec so
    // isCompositeTask detects composite via BOTH branches (subunits>=2 AND ref).
    const config: WorkflowConfig = {
      schema_version: "3.0",
      type: "workflow",
      workspace_spec: {
        org: ORG,
        branch_prefix: "e2e-td-composite",
        projects: [{ name: "E2E_TD_default", source_path: "", group: "" }],
      },
      workflow_chain: [
        { workflow_ref: "composition-task", input_values: { subunit_count: "3" } },
      ],
      max_retain: 10,
      // Legacy path: config carries task_spec (buildCompositeInputValues reads
      // subunits from it directly).
      task_spec: taskSpec,
    } as WorkflowConfig
    seedSchedule(config)
    seedTriggeredExecution()

    const result = await executor.execute(buildJob(config), execId)

    expect(result.status).not.toBe("failure")
    // 1 coordinator-ws created (children are dispatched later by task_dispatch
    // nodes inside the composition wf — TaskDispatchService owns that path).
    expect(createFromSpecMock).toHaveBeenCalledTimes(1)
    const call = createFromSpecMock.mock.calls[0][0]
    // AC2 decisive: composite → coordinator-ws has NO projects (orchestration only).
    expect(call.projects).toEqual([])
    // The composition-task workflow runs in the coordinator-ws.
    expect(call.workflow_chain[0].workflow_ref).toBe("composition-task")
    // buildCompositeInputValues fed the composition wf subunits + subunit_count.
    const createCall = stubService.create.mock.calls[0]
    const createArg = createCall[1] // (workspaceId, { workflow_ref, input_values, ... })
    expect(createArg.workflow_ref).toBe("composition-task")
    expect(createArg.input_values).toMatchObject({
      subunit_count: 3,
      goal: "E2E_TD_goal",
    })
    expect(createArg.input_values.subunits).toHaveLength(3)
    expect(createArg.input_values.subunits.map((s: any) => s.name)).toEqual([
      "su1", "su2", "su3",
    ])
  })

  it("AC2: composite (2 subunits) → coordinator-ws (projects=[]) + composition-task (threshold boundary)", async () => {
    const taskSpec = makeTaskSpec(2)
    const config: WorkflowConfig = {
      schema_version: "3.0",
      type: "workflow",
      workspace_spec: {
        org: ORG,
        branch_prefix: "e2e-td-composite-2",
        projects: [{ name: "E2E_TD_default", source_path: "", group: "" }],
      },
      workflow_chain: [
        { workflow_ref: "composition-task", input_values: { subunit_count: "2" } },
      ],
      max_retain: 10,
      task_spec: taskSpec,
    } as WorkflowConfig
    seedSchedule(config)
    seedTriggeredExecution()

    await executor.execute(buildJob(config), execId)

    // 2-subunit boundary: composite (>= 2) → coordinator-ws projects=[].
    expect(createFromSpecMock).toHaveBeenCalledTimes(1)
    const call = createFromSpecMock.mock.calls[0][0]
    expect(call.projects).toEqual([])
    const createArg = stubService.create.mock.calls[0][1]
    expect(createArg.input_values.subunit_count).toBe(2)
  })
})
