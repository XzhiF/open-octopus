// packages/server/src/__tests__/scheduler-task-spec.test.ts
//
// Ticket 10 — POST/PUT /jobs task_spec + JobDetail + task_spec→WorkflowConfig
// materialization (G9).
//
// Seams under test (all service-level, with direct DB SELECT for R3/R4):
//   1. SchedulerService.createJob({ task_spec, project_ids, skills, workflow_ref }) →
//      draft with config v3.0 containing task_spec.
//   2. SchedulerService.updateJob(id, { task_spec }, version) → edited task_spec
//      while status=draft (If-Match optimistic lock).
//   3. SchedulerService.getJob(id) → JobDetail with children[] + dag for composite
//      tasks (derived from task_spec.subunits + integration_goal).
//   4. SchedulerService.enqueueJob(id) → config.workflow_chain materialized from
//      task_spec (simple=single item; composite=composition-task ref).

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import { SchedulerService } from "../services/scheduler/scheduler-service"
import { ScheduleConfigDAO, ScheduleRunDAO } from "../db/dao"
import type { TaskSpec } from "@octopus/shared"

const ORG = "e2e-tp-org"

function makeSimpleTaskSpec(): TaskSpec {
  return {
    goal: "E2E_TP_simple_goal",
    ac: ["E2E_TP_simple_ac_1"],
  }
}

function makeCompositeTaskSpec(): TaskSpec {
  return {
    goal: "E2E_TP_composite_goal",
    ac: ["E2E_TP_comp_ac_1"],
    subunits: [
      {
        name: "E2E_TP_sub_a",
        workspace_spec: {
          org: ORG,
          branch_prefix: "e2e-tp-sub-a",
          projects: [{ name: "E2E_TP_proj_a", source_path: "", group: "" }],
        },
        workflow_ref: "e2e-tp/simple-spec-workflow",
        input_values: {},
        skills: [],
      },
      {
        name: "E2E_TP_sub_b",
        workspace_spec: {
          org: ORG,
          branch_prefix: "e2e-tp-sub-b",
          projects: [{ name: "E2E_TP_proj_b", source_path: "", group: "" }],
        },
        workflow_ref: "e2e-tp/simple-spec-workflow",
        input_values: {},
        skills: [],
      },
    ],
    integration_goal: { strategy: "synthesis", prompt: "E2E_TP_synthesis_prompt" },
  }
}

describe("Ticket 10: POST/PUT /jobs task_spec + JobDetail + materialization", () => {
  let db: Database.Database
  let service: SchedulerService
  let configDAO: ScheduleConfigDAO
  let runDAO: ScheduleRunDAO

  beforeAll(() => {
    db = new Database(":memory:")
    applySchema(db)
    // FKs off so the dispatched-composite test can seed an executions row pointing
    // at a non-existent workspace (mirrors composite-dispatch.test.ts pattern).
    db.pragma("foreign_keys = OFF")
    configDAO = new ScheduleConfigDAO(db)
    runDAO = new ScheduleRunDAO(db)
    service = new SchedulerService(configDAO, runDAO)
  })

  afterAll(() => {
    db.close()
  })

  /** Read the raw config JSON straight from the DB (R3: API↔DB 双向, R4: response+SQL). */
  function selectConfig(scheduleId: string): Record<string, unknown> {
    const row = db
      .prepare("SELECT config FROM schedules WHERE id = ?")
      .get(scheduleId) as { config: string }
    return JSON.parse(row.config)
  }

  // ── AC1: POST /jobs with task_spec → draft (config v3.0, SG5: NO task_spec) ──

  it("createJob with task_spec creates a draft (SG5: config has NO task_spec — lives in tasks table)", () => {
    const task_spec = makeSimpleTaskSpec()
    const job = service.createJob({
      name: `e2e-tp-simple-${Date.now()}`,
      job_type: "workflow",
      cron_expression: null,
      timezone: "UTC",
      org: ORG,
      trigger_source: "requirement",
      task_spec,
      project_ids: ["E2E_TP_project"],
      skills: ["E2E_TP_skill_a"],
      workflow_ref: "e2e-tp/simple-spec-workflow",
    } as any)

    // Draft status (requirement-type → origin_type='task' → draft, not queued)
    expect(job.status).toBe("draft")
    // trigger_source derived from origin_type='task' (SchedulerJob shared type field)
    expect(job.trigger_source).toBe("requirement")

    // config v3.0. SG5 (ticket 06): task_spec is NO LONGER in the materialized
    // config — it lives in the tasks table. The config carries only the runtime
    // WorkflowConfig (workspace_spec + workflow_chain).
    expect(job.config.schema_version).toBe("3.0")
    expect((job.config as { task_spec?: unknown }).task_spec).toBeUndefined()

    // R3/R4: direct DB SELECT confirms task_spec NOT persisted in schedules.config
    const dbConfig = selectConfig(job.id)
    expect(dbConfig.schema_version).toBe("3.0")
    expect((dbConfig as { task_spec?: unknown }).task_spec).toBeUndefined()
    // Simple path: workflow_chain[0].workflow_ref is the provided workflow_ref
    expect((dbConfig.workflow_chain as Array<{ workflow_ref: string }>)[0].workflow_ref).toBe("e2e-tp/simple-spec-workflow")
  })

  // ── AC2: PUT /jobs/:id edit task_spec while status=draft (If-Match) ─────────

  it("updateJob edits task_spec while status=draft (If-Match optimistic lock)", () => {
    const job = service.createJob({
      name: `e2e-tp-edit-${Date.now()}`,
      job_type: "workflow",
      cron_expression: null,
      timezone: "UTC",
      org: ORG,
      trigger_source: "requirement",
      task_spec: makeSimpleTaskSpec(),
      project_ids: ["E2E_TP_project"],
      workflow_ref: "e2e-tp/simple-spec-workflow",
    } as any)

    const updatedSpec: TaskSpec = {
      goal: "E2E_TP_updated_goal",
      ac: ["E2E_TP_updated_ac_1", "E2E_TP_updated_ac_2"],
    }

    const updated = service.updateJob(
      job.id,
      { task_spec: updatedSpec } as any,
      job.version,
    )

    // SG5: task_spec re-materialized but NOT persisted in config (lives in tasks table).
    // The workflow_chain re-materializes from the new task_spec.
    expect((updated.config as { task_spec?: unknown }).task_spec).toBeUndefined()

    // R4: DB reflects the re-materialized config (no task_spec)
    const dbConfig = selectConfig(job.id)
    expect((dbConfig as { task_spec?: unknown }).task_spec).toBeUndefined()
  })

  it("updateJob rejects task_spec edit with stale If-Match version (409)", () => {
    const job = service.createJob({
      name: `e2e-tp-stale-${Date.now()}`,
      job_type: "workflow",
      cron_expression: null,
      timezone: "UTC",
      org: ORG,
      trigger_source: "requirement",
      task_spec: makeSimpleTaskSpec(),
      project_ids: ["E2E_TP_project"],
      workflow_ref: "e2e-tp/simple-spec-workflow",
    } as any)

    expect(() =>
      service.updateJob(
        job.id,
        { task_spec: { goal: "E2E_TP_stale", ac: ["x"] } } as any,
        job.version + 999, // stale
      ),
    ).toThrow(/conflict/i)
  })

  // ── AC3: GET /jobs/:id composite returns children[] + dag ───────────────────

  // SKIPPED (ticket 06 SG5): the v1 createJob+getJob composite path is
  // incompatible with SG5 — task_spec moved out of schedules.config into the
  // tasks table, and the v1 createJob path doesn't create a parent task row to
  // resolve the task_spec from via S2 origin lookup. The v2 path (TasksService:
  // createTask → readyTask → schedule with origin_id=task.id) IS tested by
  // tasks-routes.test.ts + 06-schedules-origin-materialize.test.ts.
  it.skip("getJob on a composite draft returns children[]=[] + dag with subunit+integration nodes+edges", () => {
    const task_spec = makeCompositeTaskSpec()
    const job = service.createJob({
      name: `e2e-tp-composite-${Date.now()}`,
      job_type: "workflow",
      cron_expression: null,
      timezone: "UTC",
      org: ORG,
      trigger_source: "requirement",
      task_spec,
      project_ids: ["E2E_TP_coord"],
      workflow_ref: "e2e-tp/simple-spec-workflow",
    } as any)

    const detail = service.getJob(job.id) as any

    // JobDetail extends SchedulerJob — composite fields present
    expect(detail.dag).toBeDefined()
    expect(Array.isArray(detail.dag.nodes)).toBe(true)
    expect(Array.isArray(detail.dag.edges)).toBe(true)

    // DAG: one node per subunit + one integration node
    const nodeIds = detail.dag.nodes.map((n: any) => n.id)
    expect(nodeIds).toContain("E2E_TP_sub_a")
    expect(nodeIds).toContain("E2E_TP_sub_b")
    const integrationNode = detail.dag.nodes.find(
      (n: any) => n.type === "integration",
    )
    expect(integrationNode).toBeDefined()

    // Edges: each subunit → integration
    const edgeTargets = detail.dag.edges.map((e: any) => e.to)
    expect(edgeTargets).toContain(integrationNode.id)
    const edgeSources = detail.dag.edges.map((e: any) => e.from)
    expect(edgeSources).toContain("E2E_TP_sub_a")
    expect(edgeSources).toContain("E2E_TP_sub_b")

    // Draft composite has no dispatched children yet
    expect(detail.children).toEqual([])
  })

  it("getJob on a simple task does NOT include dag/children (undefined)", () => {
    const job = service.createJob({
      name: `e2e-tp-simple-nodag-${Date.now()}`,
      job_type: "workflow",
      cron_expression: null,
      timezone: "UTC",
      org: ORG,
      trigger_source: "requirement",
      task_spec: makeSimpleTaskSpec(),
      project_ids: ["E2E_TP_project"],
      workflow_ref: "e2e-tp/simple-spec-workflow",
    } as any)

    const detail = service.getJob(job.id) as any
    expect(detail.dag).toBeUndefined()
    expect(detail.children).toBeUndefined()
  })

  // SKIPPED (ticket 06 SG5): same as the composite-draft test above — the v1
  // createJob path doesn't create a task row, so getJob can't resolve the
  // task_spec via S2 origin lookup to build children[]. The v2 path is tested
  // via tasks-routes.test.ts (TasksService.getTask children[] via origin lookup).
  it.skip("getJob on a dispatched composite returns actual child schedules in children[]", () => {
    const task_spec = makeCompositeTaskSpec()
    const job = service.createJob({
      name: `e2e-tp-dispatched-${Date.now()}`,
      job_type: "workflow",
      cron_expression: null,
      timezone: "UTC",
      org: ORG,
      trigger_source: "requirement",
      task_spec,
      project_ids: ["E2E_TP_coord"],
      workflow_ref: "e2e-tp/simple-spec-workflow",
    } as any)

    // Simulate dispatch: enqueue → claimed, then seed a composition-wf execution +
    // a child schedule carrying the parent_task_dispatch marker (03/04 runtime shape)
    service.enqueueJob(job.id)
    db.prepare(
      "UPDATE schedules SET status = 'running', claimed_at = ? WHERE id = ?",
    ).run(new Date().toISOString(), job.id)

    // Seed the composition-wf execution linked via schedule_executions.execution_id
    const compExecId = "e2e-tp-comp-exec-1"
    db.prepare(
      `INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref,
        workflow_name, status, triggered_by, org, created_at, updated_at)
       VALUES (?, 'e2e-tp-ws-noexist', '0', 0, 'composition-task', 'composition-task',
        'running', 'scheduler', ?, datetime('now'), datetime('now'))`,
    ).run(compExecId, ORG)
    db.prepare(
      `INSERT INTO schedule_executions (id, schedule_id, execution_id, status, trigger_type,
        triggered_at, timezone_offset, timezone_iana, created_at, triggered_by)
       VALUES (?, ?, ?, 'running', 'scheduled', datetime('now'), '+00:00', 'UTC',
        datetime('now'), 'scheduler')`,
    ).run("e2e-tp-se-dispatched", job.id, compExecId)

    // Seed a child schedule carrying the parent_task_dispatch marker
    const childConfig = {
      schema_version: "3.0",
      type: "workflow",
      workspace_spec: task_spec.subunits![0].workspace_spec,
      workflow_chain: [
        {
          workflow_ref: task_spec.subunits![0].workflow_ref,
          input_values: {},
        },
      ],
      max_retain: 10,
      parent_task_dispatch: { execution_id: compExecId, node_id: "dispatch-0" },
    }
    db.prepare(
      `INSERT INTO schedules (id, org, name, cron_expression, timezone, enabled,
        timeout_seconds, notify_on_failure, created_at, updated_at, job_type, config,
        parallel_policy, version, consecutive_failures, max_retain, status, origin_type)
       VALUES (?, ?, 'e2e-tp-child-1', NULL, 'UTC', 1, 3600, 0, datetime('now'),
        datetime('now'), 'workflow', ?, 'skip', 1, 0, 10, 'done', 'task')`,
    ).run("e2e-tp-child-sched-1", ORG, JSON.stringify(childConfig))

    const detail = service.getJob(job.id) as any
    expect(detail.children).toBeDefined()
    expect(detail.children.length).toBe(1)
    expect(detail.children[0].schedule_id).toBe("e2e-tp-child-sched-1")
    expect(detail.children[0].subunit_name).toBe("E2E_TP_sub_a")
    expect(detail.children[0].status).toBe("done")
  })

  // ── AC4: enqueue materializes task_spec into WorkflowConfig ─────────────────

  it("enqueue on a simple draft leaves config.workflow_chain materialized (workflow_ref present)", () => {
    const job = service.createJob({
      name: `e2e-tp-enq-simple-${Date.now()}`,
      job_type: "workflow",
      cron_expression: null,
      timezone: "UTC",
      org: ORG,
      trigger_source: "requirement",
      task_spec: makeSimpleTaskSpec(),
      project_ids: ["E2E_TP_project"],
      workflow_ref: "e2e-tp/simple-spec-workflow",
    } as any)

    service.enqueueJob(job.id)

    // R4: DB SELECT — workflow_chain materialized (executor reads this)
    const dbConfig = selectConfig(job.id)
    const chain = dbConfig.workflow_chain as Array<{
      workflow_ref: string
      input_values: Record<string, string>
    }>
    expect(chain).toBeDefined()
    expect(chain.length).toBeGreaterThanOrEqual(1)
    expect(chain[0].workflow_ref).toBe("e2e-tp/simple-spec-workflow")
  })

  it("enqueue on a composite draft leaves config.workflow_chain materialized (composition-task ref)", () => {
    const task_spec = makeCompositeTaskSpec()
    const job = service.createJob({
      name: `e2e-tp-enq-comp-${Date.now()}`,
      job_type: "workflow",
      cron_expression: null,
      timezone: "UTC",
      org: ORG,
      trigger_source: "requirement",
      task_spec,
      project_ids: ["E2E_TP_coord"],
      workflow_ref: "e2e-tp/simple-spec-workflow",
    } as any)

    service.enqueueJob(job.id)

    const dbConfig = selectConfig(job.id)
    const chain = dbConfig.workflow_chain as Array<{
      workflow_ref: string
    }>
    expect(chain).toBeDefined()
    expect(chain.length).toBeGreaterThanOrEqual(1)
    // Composite → composition-task template ref (executor's COMPOSITION_WF_REF)
    expect(chain[0].workflow_ref).toBe("composition-task")
    // SG5 (ticket 06): task_spec is NO LONGER in config (lives in tasks table).
    // Instead, subunit_count is injected into workflow_chain[0].input_values so
    // the composition-task Loop break_when can read it without re-parsing task_spec.
    expect((dbConfig as { task_spec?: unknown }).task_spec).toBeUndefined()
    const inputValues = (chain[0] as { input_values: Record<string, unknown> }).input_values
    expect(inputValues.subunit_count).toBe(2)
  })
})
