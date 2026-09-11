// packages/server/src/__tests__/workflow-executor-dispatch.test.ts
//
// ADR-0009 (simple-direct vs composite) + ADR-0021 票03 — where the dispatch decision
// now lives.
//
// The OLD version of this file drove WorkflowExecutor.execute() and asserted it
// bifurcated into "simple task → real projects" vs "composite → coordinator ws with
// projects=[] + composition-task". 票03 deleted that bifurcation from the executor
// entirely: a task is no longer a schedule, so the scheduler's workflow executor only
// ever runs what the job definition says (config.workflow_chain[0] on a fresh ws from
// the job's own workspace_spec) and knows nothing about tasks. The simple-vs-composite
// decision MOVED to the task domain, split across two pure/owned seams:
//
//   1. WHICH workflow:  buildTaskLaunchConfig (task-materialize) — composite (≥2
//      subunits) → composition-task ref, simple → the task's own workflow_ref.
//      isCompositeWorkflowConfig is the post-materialization probe.
//   2. WHICH workspace:  TaskLifecycleService.prepareWorkspace — composite → projects
//      [] (orchestration only, spec D4); simple → the plan's real projects.
//
// So this file re-expresses AC1/AC2 at those two seams (both were the executor's before)
// and pins that the executor itself is now TASK-AGNOSTIC (its constructor lost the
// taskDAO / scheduleStatusListener params that existed only for the deleted branches) —
// while execute()'s generic cron path (job's own workspace_spec + chain[0]) is covered
// directly. It doubles as a regression guard for a 票03 slip (a dangling
// `assocBranchSuffix` reference that made every cron fire throw) that was caught during
// this rewrite and fixed in the source.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import { WorkflowExecutor } from "../services/scheduler/executors/workflow-executor"
import { ScheduleConfigDAO, ScheduleRunDAO, ExecutionDAO } from "../db/dao"
import { TaskLifecycleService } from "../services/tasks/task-lifecycle-service"
import { TaskDAO } from "../db/dao/task-dao"
import { buildTaskLaunchConfig } from "../services/tasks/task-materialize"
import { isCompositeWorkflowConfig } from "../services/scheduler/ws-launch"
import { SSEService } from "../services/sse"
import type { SchedulerJob, WorkflowConfig, TaskSpec } from "@octopus/shared"
import type { TaskRow } from "../db/types"

// Stub the ExecutionService registry so the generic dispatch + arming don't need a real
// engine (git + provider). Only used by the tests that reach a createFromSpec→create hop.
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
const ORG = "E2E_TD_org"

function makeSubunit(name: string) {
  return {
    name,
    workspace_spec: { org: ORG, branch_prefix: `e2e-td-${name}`, projects: [{ name: `E2E_TD_proj_${name}`, source_path: "", group: "" }] },
    workflow_ref: "e2e-td/sub-workflow",
    input_values: {},
    skills: [],
    resources: [],
  }
}

describe("WorkflowExecutor is task-agnostic after 票03", () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    db.pragma("foreign_keys = OFF")
  })
  afterEach(() => db.close())

  it("the constructor no longer takes taskDAO / scheduleStatusListener", () => {
    // The old signature was (sse, configDAO, runDAO, execDAO, workspaceService, taskDAO,
    // scheduleStatusListener) — the last two existed only so the executor could mirror
    // task status + seed/collect phases. With the task branches gone the arity is 5; this
    // test constructs it positionally and a widened signature would fail to typecheck /
    // throw at arity. (Runtime Function.length counts declared params.)
    const executor = new WorkflowExecutor(
      mockSSE,
      new ScheduleConfigDAO(db),
      new ScheduleRunDAO(db),
      new ExecutionDAO(db),
      { createFromSpec: vi.fn(), delete: vi.fn() } as never,
    )
    expect(executor).toBeInstanceOf(WorkflowExecutor)
    expect(WorkflowExecutor.length).toBe(5)
  })
})

describe("票03 — the simple/composite dispatch decision (relocated off the executor)", () => {
  // ── AC1: simple task → its OWN workflow_ref + REAL projects (no coordinator) ──
  it("AC1: a simple (0/1-subunit) plan is NOT composite — the task's own ref, real projects", () => {
    // 0 subunits.
    const simple = buildTaskLaunchConfig(
      { goal: "g", ac: ["a"] } as unknown as TaskSpec,
      ["E2E_TD_real_proj"], ORG, "e2e-td/simple-wf", [],
    )
    expect(isCompositeWorkflowConfig(simple)).toBe(false)
    expect(simple.workflow_chain[0].workflow_ref).toBe("e2e-td/simple-wf")
    // The ADR-0009 N+1→1 win: a simple task never produces a coordinator, so the plan
    // keeps the project it was given (NOT projects=[]).
    expect(simple.workspace_spec.projects).toEqual([{ name: "E2E_TD_real_proj", source_path: "", group: "" }])

    // 1 subunit is STILL simple (SG9 threshold is ≥2).
    const one = buildTaskLaunchConfig(
      { goal: "g", ac: ["a"], subunits: [makeSubunit("su1")] } as unknown as TaskSpec,
      ["E2E_TD_real_proj"], ORG, "e2e-td/simple-wf", [],
    )
    expect(isCompositeWorkflowConfig(one)).toBe(false)
    expect(one.workflow_chain[0].workflow_ref).toBe("e2e-td/simple-wf")
  })

  // ── AC2: composite (N≥2) → composition-task ref + the threshold boundary ──
  it("AC2: a composite (≥2-subunit) plan routes to the composition-task ref", () => {
    const two = buildTaskLaunchConfig(
      { goal: "g", ac: ["a"], subunits: [makeSubunit("su1"), makeSubunit("su2")] } as unknown as TaskSpec,
      ["E2E_TD_default"], ORG, undefined, [],
    )
    expect(isCompositeWorkflowConfig(two)).toBe(true)
    expect(two.workflow_chain[0].workflow_ref).toBe("composition-task")
    const iv = two.workflow_chain[0].input_values as Record<string, unknown>
    expect(iv.subunit_count).toBe(2)
  })
})

describe("票03 — TaskLifecycleService.prepareWorkspace: composite → coordinator (projects=[])", () => {
  let db: Database.Database
  let svc: TaskLifecycleService
  let createFromSpecMock: ReturnType<typeof vi.fn>
  let realHome: string | undefined
  let realUserProfile: string | undefined

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    db.pragma("foreign_keys = OFF")
    realHome = process.env.HOME
    realUserProfile = process.env.USERPROFILE
    process.env.HOME = "/tmp/e2e-td-pw-home"
    process.env.USERPROFILE = "/tmp/e2e-td-pw-home"
    createFromSpecMock = vi.fn(() => ({ id: "ws-new-1" }))
    const workspaceService = {
      getById: () => undefined, // no bound ws → always the build path
      createFromSpec: createFromSpecMock,
      delete: vi.fn(),
    } as never
    svc = new TaskLifecycleService({
      db,
      sse: new SSEService(),
      workspaceService,
      builtInWorkflows: null,
      taskHomeService: { artifactsDir: (id: string) => `/tmp/home/${id}/artifacts`, workflowsDir: (id: string) => `/tmp/home/${id}/workflows`, homePath: (id: string) => `/tmp/home/${id}` } as never,
    })
  })
  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    if (realUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = realUserProfile
    db.close()
  })

  function taskRow(id: string): TaskRow {
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO tasks (id, org, name, status, task_spec, authoring_resources, resources, skills,
        project_ids, workflow_ref, version, created_at, updated_at)
       VALUES (?, ?, ?, 'ready', '{}', '[]', '[]', '[]', '[]', 'w', 1, ?, ?)`,
    ).run(id, ORG, `T_${id}`, now, now)
    return new TaskDAO(db).getById(id)! as unknown as TaskRow
  }

  it("AC1: a simple plan builds a workspace with the REAL projects", () => {
    const plan: WorkflowConfig = {
      schema_version: "3.0", type: "workflow",
      workspace_spec: { org: ORG, branch_prefix: "e2e-td-simple", projects: [{ name: "E2E_TD_real_proj", source_path: "", group: "" }] },
      workflow_chain: [{ workflow_ref: "e2e-td/simple-wf", input_values: {} }],
      max_retain: 10,
    }
    svc.prepareWorkspace(taskRow("pw-simple"), plan)

    expect(createFromSpecMock).toHaveBeenCalledTimes(1)
    const arg = createFromSpecMock.mock.calls[0][0]
    // The decisive simple-vs-coordinator split now lives HERE, not in the executor.
    expect(arg.projects).toEqual([{ name: "E2E_TD_real_proj", source_path: "", group: "" }])
    expect(arg.workflow_chain[0].workflow_ref).toBe("e2e-td/simple-wf")
    expect(arg.source).toBe("task")
    expect(arg.task_id).toBe("pw-simple")
  })

  it("AC2: a composite plan builds a COORDINATOR workspace with NO projects", () => {
    const plan: WorkflowConfig = {
      schema_version: "3.0", type: "workflow",
      // The plan's own workspace_spec carries a default project, but a composite run is
      // detected via the composition-task ref → the coordinator is built with [].
      workspace_spec: { org: ORG, branch_prefix: "e2e-td-coord", projects: [{ name: "default", source_path: "", group: "" }] },
      workflow_chain: [{ workflow_ref: "composition-task", input_values: {} }],
      max_retain: 10,
    }
    svc.prepareWorkspace(taskRow("pw-comp"), plan)

    expect(createFromSpecMock).toHaveBeenCalledTimes(1)
    const arg = createFromSpecMock.mock.calls[0][0]
    expect(arg.projects).toEqual([]) // spec D4: orchestration only, subunits get their own ws
    expect(arg.workflow_chain[0].workflow_ref).toBe("composition-task")
  })
})

// ──────────────────────────────────────────────────────────────────────
//  The generic cron dispatch path (post-票03).
//
//  execute() is no longer task-aware: it builds a workspace from the JOB's own
//  workspace_spec and runs config.workflow_chain[0] — this is what survives of the old
//  "AC1 simple dispatch" once the composite/coordinator branch was deleted. It doubles
//  as a regression guard for a 票03 slip found (and fixed) during the rewrite: the
//  ws-reuse-branch deletion left a dangling `assocBranchSuffix` reference at
//  workflow-executor.ts:246, so every cron fire threw ReferenceError at the
//  schedule_workspace insert. Green today; it would go red the moment that insert
//  regresses again.
// ──────────────────────────────────────────────────────────────────────
describe("WorkflowExecutor.execute — generic cron dispatch (票03)", () => {
  let db: Database.Database
  let executor: WorkflowExecutor
  let createFromSpecMock: ReturnType<typeof vi.fn>
  const schedId = "e2e-td-sched"
  const execId = "e2e-td-exec"
  const wsId = "e2e-td-ws"

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    db.pragma("foreign_keys = OFF")
    db.prepare(
      `INSERT INTO workspaces (id, name, org, path, created_at, updated_at)
       VALUES (?, 'E2E_TD_ws', ?, '/tmp/e2e-td', datetime('now'), datetime('now'))`,
    ).run(wsId, ORG)
    createFromSpecMock = vi.fn(() => ({ id: "ws-new-1" }))
    executor = new WorkflowExecutor(
      mockSSE,
      new ScheduleConfigDAO(db),
      new ScheduleRunDAO(db),
      new ExecutionDAO(db),
      { createFromSpec: createFromSpecMock, delete: vi.fn() } as never,
    )
    stubService.create.mockClear()
  })
  afterEach(() => db.close())

  it("runs config.workflow_chain[0] on a workspace built from the job's OWN spec", async () => {
    const config: WorkflowConfig = {
      schema_version: "3.0", type: "workflow",
      workspace_spec: { org: ORG, branch_prefix: "e2e-td-simple", projects: [{ name: "E2E_TD_real_proj", source_path: "", group: "" }] },
      workflow_chain: [{ workflow_ref: "e2e-td/simple-wf", input_values: {} }],
      max_retain: 10,
    } as unknown as WorkflowConfig
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO schedules (id, org, name, cron_expression, timezone, enabled, timeout_seconds,
        notify_on_failure, created_at, updated_at, job_type, config, parallel_policy, version,
        consecutive_failures, max_retain, status)
       VALUES (?, ?, ?, NULL, 'UTC', 1, 3600, 0, ?, ?, 'workflow', ?, 'skip', 1, 0, 10, 'running')`,
    ).run(schedId, ORG, "E2E_TD_task", now, now, JSON.stringify(config))
    db.prepare(
      `INSERT INTO schedule_executions (id, schedule_id, status, trigger_type, triggered_at,
        timezone_offset, timezone_iana, created_at, triggered_by)
       VALUES (?, ?, 'triggered', 'scheduled', datetime('now'), '+00:00', 'UTC', datetime('now'), 'scheduler')`,
    ).run(execId, schedId)
    const job = {
      id: schedId, name: "E2E_TD_task", job_type: "workflow", cron_expression: "0 9 * * *", timezone: "UTC",
      enabled: true, org: ORG, config, parallel_policy: "skip", timeout_seconds: 3600, notify_on_failure: false,
      version: 1, consecutive_failures: 0, next_trigger_at: null, deleted_at: null,
      created_at: now, updated_at: now, status: "running", claimed_at: now,
    } as unknown as SchedulerJob

    const result = await executor.execute(job, execId)

    expect(result.status).toBe("running")
    expect(createFromSpecMock).toHaveBeenCalledTimes(1)
    expect(createFromSpecMock.mock.calls[0][0].projects).toEqual([{ name: "E2E_TD_real_proj", source_path: "", group: "" }])
    // vi.fn() declares no params → cast to read the create(workspaceId, input) tuple.
    const createArg = stubService.create.mock.calls[0] as unknown as [string, { workflow_ref: string }]
    expect(createArg[1]).toMatchObject({ workflow_ref: "e2e-td/simple-wf" })
  })
})
