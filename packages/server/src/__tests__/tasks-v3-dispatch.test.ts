// packages/server/src/__tests__/tasks-v3-dispatch.test.ts
//
// Ticket 08 — dispatch $vars.task_artifacts_dir / $vars.task_workflows_dir injection.
//
// ADR-0021 票03 rewrite notes (this file moved with the materializer):
//   * `materializeTaskSpecToConfig` was RENAMED to `buildTaskLaunchConfig` and MOVED out
//     of services/scheduler/scheduler-service.ts into services/tasks/task-materialize.ts
//     (first 7 positional args unchanged). AC1/AC4 are the same pure-function checks.
//   * AC2 used to drive WorkflowExecutor.execute to prove buildCompositeInputValues
//     preserved task_artifacts_dir across the chain-input replacement (SW-BP7). 票03
//     removed every task branch from the executor; the replacement now happens in
//     TaskLifecycleService.armTask, which composes {...buildCompositeInputValues(spec,
//     plan), ...step.inputValues} onto the armed execution. AC2 pins the SAME rule at
//     that seam — the created row's input_values must carry the composite keys AND the
//     injected dir (not dropped by the wholesale replacement).
//   * The injection-seam describe used to read the materialized config back off a
//     schedules envelope that readyTask wrote. readyTask now writes ONLY the status
//     (contract §新行为 1: 不建任何 schedules 行) — asserted directly. The per-launch
//     materializer is armTask, so the injected TaskHomeService.baseDir is asserted on
//     the ARMED execution's input_values instead; the legacy (no home) case stays a
//     pure-function assertion because an empty workflow_ref refuses to arm by design.
//
// AC3 (engine input_mapping) and AC10 (ADR-0013 workflows copy) are unchanged in intent.
//
// Anti-fake-run: real better-sqlite3 + applySchema for AC2/seam (R1/R3); real
// WorkflowEngine for AC3 (deterministic edges not mocked); real TaskHomeService path
// computation cross-checked (R3).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { buildTaskLaunchConfig } from "../services/tasks/task-materialize"
import { TaskHomeService } from "../services/tasks/task-home-service"
import { TasksService } from "../services/tasks/tasks-service"
import { TaskLifecycleService } from "../services/tasks/task-lifecycle-service"
import { SSEService } from "../services/sse"
import { applySchema } from "../db/schema"
import { TaskDAO } from "../db/dao/task-dao"
import { ExecutionDAO } from "../db/dao/execution-dao"
import { WorkflowEngine } from "@octopus/engine"
import type { TaskSpec, SubunitSpec, WorkflowDef, NodeDef, TaskDispatchPort, ChildHandle } from "@octopus/shared"

const ORG = "e2e-td-08"

// ── Mock getExecutionService ───────────────────────────────────────────
// The armed paths stub the engine at the ExecutionService seam: create INSERTS a real
// executions row (so the armed shape is read back from disk, not from a spy) and keeps
// the full input for assertions.
const stub = vi.hoisted(() => ({
  db: null as Database.Database | null,
  seq: 0,
  created: [] as Array<Record<string, unknown>>,
}))
vi.mock("../services/execution-service-registry", () => ({
  getExecutionService: (wsId: string) => {
    const ws = stub.db?.prepare("SELECT path FROM workspaces WHERE id = ?").get(wsId) as
      { path: string } | undefined
    if (!ws) return undefined
    return {
      wsPath: ws.path,
      service: {
        create: (workspaceId: string, input: Record<string, unknown>) => {
          const id = `td08-exec-${stub.seq++}`
          stub.db!.prepare(
            `INSERT INTO executions
               (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name, status,
                input_values, var_pool, org, created_at, updated_at, task_id)
             VALUES (?, ?, '0', 0, ?, ?, 'pending', ?, '{}', ?, datetime('now'), datetime('now'), ?)`,
          ).run(
            id, workspaceId, String(input.workflow_ref ?? ""), String(input.workflow_ref ?? ""),
            JSON.stringify(input.input_values ?? {}), ORG, (input.task_id as string) ?? null,
          )
          stub.created.push({ id, workspaceId, ...input })
          return { id }
        },
        start: async () => {},
        registerExternalCallbacks: () => {},
        clearExternalCallbacks: () => {},
      },
    }
  },
}))

// ──────────────────────────────────────────────────────────────────────
//  AC1 + AC4: buildTaskLaunchConfig (pure function, no DB)
// ──────────────────────────────────────────────────────────────────────

describe("08 AC1/AC4: buildTaskLaunchConfig task_artifacts_dir injection", () => {
  const tmpBase = path.join(os.tmpdir(), `octopus-08-${Date.now()}`)
  const home = new TaskHomeService(tmpBase)
  const TASK_ID = "e2e-td-08-task-ac1"

  // AC1: simple task → input_values.task_artifacts_dir == homePath(id)/artifacts
  it("AC1: simple task config has input_values.task_artifacts_dir == artifactsDir(id)", () => {
    const taskSpec = { goal: "g", ac: ["a"] } as unknown as TaskSpec
    const expected = home.artifactsDir(TASK_ID)
    // Cross-check the path convention (ADR-0011): base/tasks/{id}/artifacts
    expect(expected).toBe(path.join(tmpBase, "tasks", TASK_ID, "artifacts"))

    const config = buildTaskLaunchConfig(
      taskSpec, ["proj"], ORG, "e2e-td-08/wf", [], undefined, expected,
    )
    expect(config.workflow_chain[0].workflow_ref).toBe("e2e-td-08/wf")
    const iv = config.workflow_chain[0].input_values as Record<string, unknown>
    expect(iv.task_artifacts_dir).toBe(expected)
  })

  // AC1: composite task → task_artifacts_dir also injected into workflow_chain[0]
  // (buildCompositeInputValues reads it from there — AC2)
  it("AC1: composite task config also carries task_artifacts_dir in workflow_chain[0].input_values", () => {
    const taskSpec = {
      goal: "g", ac: ["a"],
      subunits: [
        { name: "su-a", workspace_spec: { org: ORG, branch_prefix: "e2e-td-08-a", projects: [{ name: "p", source_path: "", group: "" }] }, workflow_ref: "wf-a", input_values: {}, skills: [], resources: [] },
        { name: "su-b", workspace_spec: { org: ORG, branch_prefix: "e2e-td-08-b", projects: [{ name: "p", source_path: "", group: "" }] }, workflow_ref: "wf-b", input_values: {}, skills: [], resources: [] },
      ],
    } as unknown as TaskSpec
    const expected = home.artifactsDir(TASK_ID)
    const config = buildTaskLaunchConfig(
      taskSpec, ["proj"], ORG, undefined, [], undefined, expected,
    )
    // Composite → composition-task workflow_ref
    expect(config.workflow_chain[0].workflow_ref).toBe("composition-task")
    const iv = config.workflow_chain[0].input_values as Record<string, unknown>
    expect(iv.task_artifacts_dir).toBe(expected)
  })

  // AC4: no taskArtifactsDir → key absent (legacy task backward compat)
  it("AC4: legacy task (no taskArtifactsDir) → no task_artifacts_dir key, no error", () => {
    const taskSpec = { goal: "g", ac: ["a"] } as unknown as TaskSpec
    const config = buildTaskLaunchConfig(taskSpec, ["proj"], ORG, "wf", [])
    const iv = config.workflow_chain[0].input_values as Record<string, unknown>
    expect(iv.task_artifacts_dir).toBeUndefined()
  })

  // GS5/r2-05: key-set integrity — a stronger claim than toBeUndefined (catches a
  // "key set with undefined value" or a leaked extra key).
  it("AC1/AC4 boundary: simple input_values key-set is EXACTLY [task_artifacts_dir] when provided, [] when undefined (no leakage)", () => {
    const taskSpec = { goal: "g", ac: ["a"] } as unknown as TaskSpec
    const expected = home.artifactsDir(TASK_ID)

    const withArt = buildTaskLaunchConfig(
      taskSpec, ["proj"], ORG, "e2e-td-08/wf", [], undefined, expected,
    )
    const ivWith = withArt.workflow_chain[0].input_values as Record<string, unknown>
    expect(Object.keys(ivWith)).toEqual(["task_artifacts_dir"])

    const withoutArt = buildTaskLaunchConfig(taskSpec, ["proj"], ORG, "e2e-td-08/wf", [])
    const ivWithout = withoutArt.workflow_chain[0].input_values as Record<string, unknown>
    expect(Object.keys(ivWithout)).toEqual([])
  })

  // GS5/r2-05: composite key-set + derived value (subunit_count derived from
  // subunits.length inside the function, not echoed from a param).
  it("AC1 composite boundary: composite input_values key-set is EXACTLY [subunit_count, task_artifacts_dir] (subunit_count derived from subunits.length)", () => {
    const taskSpec = {
      goal: "g", ac: ["a"],
      subunits: [
        { name: "su-a", workspace_spec: { org: ORG, branch_prefix: "e2e-td-08-a", projects: [{ name: "p", source_path: "", group: "" }] }, workflow_ref: "wf-a", input_values: {}, skills: [], resources: [] },
        { name: "su-b", workspace_spec: { org: ORG, branch_prefix: "e2e-td-08-b", projects: [{ name: "p", source_path: "", group: "" }] }, workflow_ref: "wf-b", input_values: {}, skills: [], resources: [] },
        { name: "su-c", workspace_spec: { org: ORG, branch_prefix: "e2e-td-08-c", projects: [{ name: "p", source_path: "", group: "" }] }, workflow_ref: "wf-c", input_values: {}, skills: [], resources: [] },
      ],
    } as unknown as TaskSpec
    const expected = home.artifactsDir(TASK_ID)
    const config = buildTaskLaunchConfig(
      taskSpec, ["proj"], ORG, undefined, [], undefined, expected,
    )
    const iv = config.workflow_chain[0].input_values as Record<string, unknown>
    expect(iv.subunit_count).toBe(3)
    expect(Object.keys(iv).sort()).toEqual(["subunit_count", "task_artifacts_dir"].sort())
  })

  // ADR-0013: the task_workflows_dir injection mirrors the artifacts one.
  it("ADR-0013: task_workflows_dir lands in input_values when a workflows dir is passed", () => {
    const taskSpec = { goal: "g", ac: ["a"] } as unknown as TaskSpec
    const wfDir = home.workflowsDir(TASK_ID)
    const config = buildTaskLaunchConfig(taskSpec, ["proj"], ORG, "wf", [], undefined, home.artifactsDir(TASK_ID), wfDir)
    const iv = config.workflow_chain[0].input_values as Record<string, unknown>
    expect(iv.task_workflows_dir).toBe(wfDir)
  })
})

// ──────────────────────────────────────────────────────────────────────
//  AC2: armTask preserves task_artifacts_dir across the composite
//  input_values replacement (was: WorkflowExecutor.execute + materialized
//  schedules envelope; 票03 moved the composition to the lifecycle job)
// ──────────────────────────────────────────────────────────────────────

describe("08 AC2: composite arm — buildCompositeInputValues preserves task_artifacts_dir", () => {
  let db: Database.Database
  let svc: TaskLifecycleService
  let tasks: TaskDAO
  let execs: ExecutionDAO
  let homeDir: string
  let wsDir: string
  let taskHome: TaskHomeService
  let realHome: string | undefined
  let realUserProfile: string | undefined

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    db.pragma("foreign_keys = OFF")
    stub.db = db
    stub.seq = 0
    stub.created = []
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "td08-ac2-home-"))
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "td08-ac2-ws-"))
    realHome = process.env.HOME
    realUserProfile = process.env.USERPROFILE
    process.env.HOME = homeDir
    process.env.USERPROFILE = homeDir
    taskHome = new TaskHomeService(path.join(homeDir, ".octopus"))
    tasks = new TaskDAO(db)
    execs = new ExecutionDAO(db)
    svc = new TaskLifecycleService({
      db,
      sse: new SSEService(),
      workspaceService: {
        getById: (id: string) => (db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as never) ?? undefined,
        ensureWorktreesForReuse: () => ({ rebuilt: [] }),
        createFromSpec: (input: Record<string, unknown>) => {
          const id = `ac2-ws-${stub.created.length}-${Math.random().toString(36).slice(2, 6)}`
          const p = path.join(wsDir, id)
          fs.mkdirSync(path.join(p, "workflows"), { recursive: true })
          db.prepare(
            `INSERT INTO workspaces (id, name, org, status, path, source, task_id, created_at, updated_at)
             VALUES (?, ?, ?, 'active', ?, 'task', ?, datetime('now'), datetime('now'))`,
          ).run(id, String(input.name), ORG, p, (input.task_id as string) ?? null)
          return { id }
        },
      } as never,
      builtInWorkflows: { get: (ref: string) => ({ ref, content: "name: demo\nnodes: []\n", name: "demo" }) } as never,
      taskHomeService: taskHome,
    })
  })
  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    if (realUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = realUserProfile
    db.close()
    fs.rmSync(homeDir, { recursive: true, force: true })
    fs.rmSync(wsDir, { recursive: true, force: true })
  })

  function makeSubunit(name: string): SubunitSpec {
    return {
      name,
      workspace_spec: { org: ORG, branch_prefix: `e2e-td-08-${name}`, projects: [{ name: "p", source_path: "", group: "" }] },
      workflow_ref: "e2e-td-08/simple",
      input_values: {},
      skills: [],
      resources: [],
    }
  }

  function insertCompositeTask(id: string, subunits: SubunitSpec[]): void {
    const now = new Date().toISOString()
    tasks.insert({
      id, org: ORG, name: `T_${id}`, status: "ready",
      task_spec: JSON.stringify({
        goal: "E2E_TD_08_goal", ac: ["ac1"], task_type: "coding", subunits,
        integration_goal: { strategy: "synthesis", prompt: "E2E_TD_08_synth" },
      } as unknown as TaskSpec),
      authoring_resources: "[]", resources: "[]", skills: "[]", project_ids: '["E2E_TP_proj"]',
      workflow_ref: null, version: 1, source_chat_session_id: null,
      deleted_at: null, created_at: now, updated_at: now, completed_at: null, workspace_id: null,
      trigger_mode: "manual", trigger_at: null, cron_expression: null,
      cron_timezone: "Asia/Shanghai", trigger_enabled: 1, next_fire_at: null, last_fired_at: null,
    } as never)
  }

  it("AC2: the armed composite execution carries task_artifacts_dir (not dropped by the replacement)", () => {
    const subunits = [makeSubunit("a"), makeSubunit("b"), makeSubunit("c")]
    insertCompositeTask("td08-ac2", subunits)
    const execId = svc.armTask("td08-ac2")
    const iv = JSON.parse(execs.findById(execId)!.input_values) as Record<string, unknown>

    // AC2 core: the injected dir SURVIVES buildCompositeInputValues's wholesale
    // replacement of chain[0].input_values (the SW-BP7 hazard).
    expect(iv.task_artifacts_dir).toBe(taskHome.artifactsDir("td08-ac2"))
    // The other composite keys are present (not clobbered).
    expect(iv.subunit_count).toBe(3)
    expect(iv.goal).toBe("E2E_TD_08_goal")
    // integration_prompt is a KEY-RENAME (task_spec.integration_goal.prompt →
    // integration_prompt): asserting the renamed key catches a dropped rename.
    expect(iv.integration_prompt).toBe("E2E_TD_08_synth")
    // subunits must be the ARRAY (not stringified) for the composition Loop.
    expect(Array.isArray(iv.subunits)).toBe(true)
    expect(iv.subunits).toHaveLength(3)
    // Exact key-set. The two management dirs (artifacts + workflows) are BOTH injected
    // by the per-launch materializer (buildTaskLaunchConfig writes them, and
    // resolveTaskLaunchStep copies chain[0].input_values into step.inputValues), then
    // merged over buildCompositeInputValues's composite keys. So the armed row carries
    // goal + integration_prompt + subunit_count + subunits + both dirs — nothing dropped,
    // nothing leaked.
    expect(Object.keys(iv).sort()).toEqual([
      "goal", "integration_prompt", "subunit_count", "subunits", "task_artifacts_dir", "task_workflows_dir",
    ])
  })
})

// ──────────────────────────────────────────────────────────────────────
//  AC3: composition subunit — input_mapping forwards $vars.task_artifacts_dir
// ──────────────────────────────────────────────────────────────────────

describe("08 AC3: composition subunit — input_mapping forwards task_artifacts_dir", () => {
  const ARTIFACTS_DIR = "/tmp/e2e-td-08/home/tasks/e2e-td-08-task/artifacts"

  function makeSubunit(name: string): SubunitSpec {
    return {
      name,
      workspace_spec: { org: ORG, branch_prefix: `e2e-td-08-${name}`, projects: [{ name: "p", source_path: "", group: "" }] },
      workflow_ref: "e2e-td-08/simple",
      input_values: {},
      skills: [],
      resources: [],
    }
  }

  function compositionWorkflow(subunits: SubunitSpec[]): WorkflowDef {
    const nodes: NodeDef[] = [
      {
        id: "loop-subunits",
        type: "loop",
        max_iterations: 20,
        break_when: "$iteration >= $vars.subunit_count",
        nodes: [
          {
            id: "dispatch-child",
            type: "task_dispatch",
            subunit: "$iteration.subunit",
            await: true,
            input_mapping: {
              goal: "$vars.goal",
              task_artifacts_dir: "$vars.task_artifacts_dir",
            },
            output_mapping: { result: "last_output" },
          },
        ],
      },
    ]
    return {
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "loop-task-dispatch-08",
      execution_mode: "serial",
      budget: {} as any,
      variables: {
        subunits,
        subunit_count: subunits.length,
        goal: "E2E_TD_08_goal",
        task_artifacts_dir: ARTIFACTS_DIR,
      },
      nodes,
    }
  }

  // The port shape changed with 票03: dispatchChildSchedule → dispatchChild, and it
  // resolves a ChildHandle ({ child_id }) instead of a ScheduleHandle ({ schedule_id }).
  function makePort(): { port: TaskDispatchPort; spy: ReturnType<typeof vi.fn> } {
    const spy = vi.fn().mockImplementation((_subunit: SubunitSpec) =>
      Promise.resolve({ child_id: "child-08-1", workspace_id: "ws-08-1" } as ChildHandle),
    )
    return {
      port: { dispatchChild: spy, resumeOnCompletion: vi.fn().mockResolvedValue(undefined) },
      spy,
    }
  }

  it("AC3: task_dispatch input_mapping resolves $vars.task_artifacts_dir → subunit input_values", async () => {
    const subunits = [makeSubunit("a"), makeSubunit("b"), makeSubunit("c")]
    const wf = compositionWorkflow(subunits)
    const { port, spy } = makePort()

    const engine = new WorkflowEngine(wf, {}, process.cwd())
    engine.setTaskDispatchPort(port)

    const res = await engine.run()
    expect(res.status).toBe("pending_task_dispatch")

    expect(spy).toHaveBeenCalledTimes(1)
    const receivedSubunit = spy.mock.calls[0][0] as SubunitSpec
    expect(receivedSubunit.input_values.task_artifacts_dir).toBe(ARTIFACTS_DIR)
    expect(receivedSubunit.input_values.goal).toBe("E2E_TD_08_goal")
    expect(receivedSubunit.name).toBe("a")
    expect(receivedSubunit.workflow_ref).toBe("e2e-td-08/simple")
  }, 20000)

  it("AC3/AC4: no input_mapping on the node → subunit input_values unchanged (backward compat)", async () => {
    const subunits = [makeSubunit("a")]
    const nodes: NodeDef[] = [
      {
        id: "loop-subunits",
        type: "loop",
        max_iterations: 20,
        break_when: "$iteration >= $vars.subunit_count",
        nodes: [
          {
            id: "dispatch-child",
            type: "task_dispatch",
            subunit: "$iteration.subunit",
            await: true,
            output_mapping: { result: "last_output" },
          },
        ],
      },
    ]
    const wf: WorkflowDef = {
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "loop-task-dispatch-08-nomap",
      execution_mode: "serial",
      budget: {} as any,
      variables: { subunits, subunit_count: subunits.length, goal: "g", task_artifacts_dir: ARTIFACTS_DIR },
      nodes,
    }
    const { port, spy } = makePort()

    const engine = new WorkflowEngine(wf, {}, process.cwd())
    engine.setTaskDispatchPort(port)

    const res = await engine.run()
    expect(res.status).toBe("pending_task_dispatch")

    expect(spy).toHaveBeenCalledTimes(1)
    const receivedSubunit = spy.mock.calls[0][0] as SubunitSpec
    expect(receivedSubunit.input_values.task_artifacts_dir).toBeUndefined()
  }, 20000)

  // GS5/r2-05: type preservation through input_mapping (resolveMappingValue returns
  // pool.get raw, not substituteVars's String()).
  it("AC3/type-preservation: input_mapping resolves $vars.<numeric>/<boolean> preserving type (not stringified)", async () => {
    const subunits = [makeSubunit("a")]
    const nodes: NodeDef[] = [
      {
        id: "loop-subunits",
        type: "loop",
        max_iterations: 20,
        break_when: "$iteration >= $vars.subunit_count",
        nodes: [
          {
            id: "dispatch-child",
            type: "task_dispatch",
            subunit: "$iteration.subunit",
            await: true,
            input_mapping: {
              task_artifacts_dir: "$vars.task_artifacts_dir",
              numeric_metric: "$vars.numeric_metric",
              flag: "$vars.flag",
            },
            output_mapping: { result: "last_output" },
          },
        ],
      },
    ]
    const wf: WorkflowDef = {
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "loop-task-dispatch-08-types",
      execution_mode: "serial",
      budget: {} as any,
      variables: {
        subunits,
        subunit_count: subunits.length,
        goal: "g",
        task_artifacts_dir: ARTIFACTS_DIR,
        numeric_metric: 42,
        flag: true,
      } as Record<string, unknown>,
      nodes,
    }
    const { port, spy } = makePort()

    const engine = new WorkflowEngine(wf, {}, process.cwd())
    engine.setTaskDispatchPort(port)

    const res = await engine.run()
    expect(res.status).toBe("pending_task_dispatch")
    expect(spy).toHaveBeenCalledTimes(1)

    const received = spy.mock.calls[0][0] as SubunitSpec
    expect(received.input_values.numeric_metric).toBe(42)
    expect(received.input_values.flag).toBe(true)
  }, 20000)
})

// ──────────────────────────────────────────────────────────────────────
//  Injection seam — 票03: readyTask creates NO schedules envelope; the plan is
//  materialized per-launch by the lifecycle job, which reads the injected
//  TaskHomeService. So the "readyTask materialized a schedule config" read is gone;
//  its replacement asserts (1) readyTask leaves no schedule row, (2) armTask threads
//  the injected home base into the armed execution's input_values.
// ──────────────────────────────────────────────────────────────────────

describe("08 injection-seam: readyTask creates no envelope; armTask uses the injected TaskHomeService baseDir", () => {
  let db: Database.Database
  let tempBase: string
  let svc: TasksService
  let lifecycle: TaskLifecycleService
  let execs: ExecutionDAO
  let wsSeq = 0
  const homeBase = path.join(os.tmpdir(), `octopus-seam-${Date.now()}`)
  let realHome: string | undefined
  let realUserProfile: string | undefined

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    db.pragma("foreign_keys = OFF")
    stub.db = db
    stub.seq = 0
    stub.created = []
    wsSeq = 0
    tempBase = path.join(os.tmpdir(), `octopus-r2-05-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
    realHome = process.env.HOME
    realUserProfile = process.env.USERPROFILE
    process.env.HOME = homeBase
    process.env.USERPROFILE = homeBase
    const sse = new SSEService()
    const stubBuiltIn = {
      get(ref: string) {
        if (ref.includes("e2e-td")) return { ref, content: "stub-builtin" }
        return null
      },
    } as never
    svc = new TasksService(db, sse, undefined, new TaskHomeService(tempBase), undefined, stubBuiltIn)
    const workspaceService = {
      getById: (id: string) => (db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as never) ?? undefined,
      ensureWorktreesForReuse: () => ({ rebuilt: [] }),
      createFromSpec: (input: Record<string, unknown>) => {
        const id = `seam-ws-${wsSeq++}`
        const p = path.join(os.tmpdir(), `octopus-seam-ws-${id}`)
        fs.mkdirSync(path.join(p, "workflows"), { recursive: true })
        db.prepare(
          `INSERT INTO workspaces (id, name, org, status, path, source, task_id, created_at, updated_at)
           VALUES (?, ?, ?, 'active', ?, 'task', ?, datetime('now'), datetime('now'))`,
        ).run(id, String(input.name), ORG, p, (input.task_id as string) ?? null)
        return { id }
      },
    }
    lifecycle = new TaskLifecycleService({
      db,
      sse,
      workspaceService: workspaceService as never,
      builtInWorkflows: stubBuiltIn,
      taskHomeService: new TaskHomeService(tempBase),
    })
    execs = new ExecutionDAO(db)
  })
  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    if (realUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = realUserProfile
    db.close()
    try { fs.rmSync(tempBase, { recursive: true, force: true }) } catch { /* */ }
  })

  function insertDraftTask(id: string, spec: Record<string, unknown>, workflowRef: string | null = null): void {
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO tasks (id, org, name, status, source_chat_session_id, task_spec,
        authoring_resources, resources, skills, project_ids, workflow_ref, version,
        deleted_at, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, 'draft', NULL, ?, '[]', '[]', '[]', '[]', ?, 1, NULL, ?, ?, NULL)
    `).run(id, ORG, "r2-05-task", JSON.stringify(spec), workflowRef, now, now)
  }

  it("AC1/§1: readyTask flips status to ready and creates NO schedules row (contract §新行为 1)", () => {
    const id = "e2e-td-08-seam-nosched"
    insertDraftTask(id, {
      goal: "E2E_TD goal", ac: ["E2E_TD ac1"],
      task_type: "coding", goal_confirmed: true, ac_confirmed: ["E2E_TD ac1"],
    }, "e2e-td-08/wf")

    const dto = svc.readyTask(id)
    expect(dto.status).toBe("ready")
    // The envelope is dead: enqueuing touches no schedule table at all.
    expect((db.prepare("SELECT COUNT(*) c FROM schedules").get() as { c: number }).c).toBe(0)
  })

  it("AC1-seam: v3 task arm → input_values.task_artifacts_dir carries injected tempBase (not default homedir)", () => {
    const id = "e2e-td-08-seam-v3"
    insertDraftTask(id, {
      goal: "E2E_TD r2-05 goal", ac: ["E2E_TD ac1"],
      task_type: "coding", goal_confirmed: true, ac_confirmed: ["E2E_TD ac1"],
    }, "e2e-td-08/wf")
    svc.readyTask(id)
    const execId = lifecycle.armTask(id)
    const iv = JSON.parse(execs.findById(execId)!.input_values) as Record<string, unknown>
    const expected = path.join(tempBase, "tasks", id, "artifacts")
    // The injected base threaded through the per-launch materializer.
    expect(iv.task_artifacts_dir).toBe(expected)
    // SG5/r2-05 preserved: task_spec is dropped from the plan (lives in the tasks table);
    // the armed input_values carries no task_spec trace either.
    expect(iv).not.toHaveProperty("task_spec")
  })

  it("AC1-seam: v3 task arm → input_values carries task_workflows_dir (ADR-0013 injection seam)", () => {
    const id = "e2e-td-08-seam-wf"
    insertDraftTask(id, {
      goal: "E2E_TD r2-05 wf", ac: ["E2E_TD ac1"],
      task_type: "coding", goal_confirmed: true, ac_confirmed: ["E2E_TD ac1"],
    }, "e2e-td-08/wf")
    svc.readyTask(id)
    const execId = lifecycle.armTask(id)
    const iv = JSON.parse(execs.findById(execId)!.input_values) as Record<string, unknown>
    expect(iv.task_workflows_dir).toBe(path.join(tempBase, "tasks", id, "workflows"))
  })
})

// ──────────────────────────────────────────────────────────────────────
//  AC10: dispatch copy — {home}/workflows/*.yaml → ws workflows/ (ADR-0013)
// ──────────────────────────────────────────────────────────────────────

describe("08 AC10: dispatch copy — task_workflows_dir YAMLs copied into ws workflows/", () => {
  let tmpHome: string
  let tmpWs: string

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-td-ac10-home-"))
    tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-td-ac10-ws-"))
    fs.mkdirSync(path.join(tmpWs, "workflows"), { recursive: true })
  })

  afterEach(() => {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* */ }
    try { fs.rmSync(tmpWs, { recursive: true, force: true }) } catch { /* */ }
  })

  it("copies YAML files from task_workflows_dir into ws workflows/", async () => {
    const srcDir = path.join(tmpHome, "tasks", "task-1", "workflows")
    fs.mkdirSync(srcDir, { recursive: true })
    fs.writeFileSync(path.join(srcDir, "my-flow.yaml"), "workflow: my-flow\n", "utf-8")
    fs.writeFileSync(path.join(srcDir, "other.yml"), "workflow: other\n", "utf-8")
    fs.writeFileSync(path.join(srcDir, "readme.md"), "ignore me", "utf-8")

    // 票03: the copy helper moved to services/tasks/task-artifact-sync (the executor
    // now imports it from there); ADR-0013 behaviour is unchanged.
    const { copyTaskWorkflowsToWs } = await import("../services/tasks/task-artifact-sync")
    copyTaskWorkflowsToWs(srcDir, tmpWs)

    const wsWf = path.join(tmpWs, "workflows")
    expect(fs.existsSync(path.join(wsWf, "my-flow.yaml"))).toBe(true)
    expect(fs.existsSync(path.join(wsWf, "other.yml"))).toBe(true)
    expect(fs.existsSync(path.join(wsWf, "readme.md"))).toBe(false)
    expect(fs.readFileSync(path.join(wsWf, "my-flow.yaml"), "utf-8")).toBe("workflow: my-flow\n")
  })

  it("no-op when source dir is missing (legacy tasks)", async () => {
    // 票03: the copy helper moved to services/tasks/task-artifact-sync (the executor
    // now imports it from there); ADR-0013 behaviour is unchanged.
    const { copyTaskWorkflowsToWs } = await import("../services/tasks/task-artifact-sync")
    copyTaskWorkflowsToWs("/nonexistent/path", tmpWs)
    expect(fs.readdirSync(path.join(tmpWs, "workflows"))).toEqual([])
  })

  it("no-op when source dir is empty", async () => {
    const emptyDir = path.join(tmpHome, "empty")
    fs.mkdirSync(emptyDir, { recursive: true })
    // 票03: the copy helper moved to services/tasks/task-artifact-sync (the executor
    // now imports it from there); ADR-0013 behaviour is unchanged.
    const { copyTaskWorkflowsToWs } = await import("../services/tasks/task-artifact-sync")
    copyTaskWorkflowsToWs(emptyDir, tmpWs)
    expect(fs.readdirSync(path.join(tmpWs, "workflows"))).toEqual([])
  })
})
