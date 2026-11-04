// packages/server/src/__tests__/workflow-executor-dispatch.test.ts
//
// ADR-0021 票03 — the executor is task-agnostic.
//
// The OLD version of this file drove WorkflowExecutor.execute() and asserted it
// bifurcated into "simple task → real projects" vs "coordinator workspace".
// 票03 deleted that bifurcation from the executor entirely: a task is no longer a
// schedule, so the scheduler's workflow executor only ever runs what the job definition
// says (config.workflow_chain[0] on a fresh ws from the job's own workspace_spec) and
// knows nothing about tasks.
//
// This file pins that the executor is TASK-AGNOSTIC (its constructor lost the taskDAO /
// scheduleStatusListener params that existed only for the deleted branches) — while
// execute()'s generic cron path (job's own workspace_spec + chain[0]) is covered
// directly. It doubles as a regression guard for a 票03 slip (a dangling
// `assocBranchSuffix` reference that made every cron fire throw) that was caught during
// this rewrite and fixed in the source.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import { WorkflowExecutor } from "../services/scheduler/executors/workflow-executor"
import { ScheduleConfigDAO, ScheduleRunDAO, ExecutionDAO } from "../db/dao"
import { SSEService } from "../services/sse"
import type { SchedulerJob, WorkflowConfig } from "@octopus/shared"

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
      `INSERT INTO workspaces (id, name, repo_group, path, created_at, updated_at)
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
      enabled: true, repo_group: ORG, config, parallel_policy: "skip", timeout_seconds: 3600, notify_on_failure: false,
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
