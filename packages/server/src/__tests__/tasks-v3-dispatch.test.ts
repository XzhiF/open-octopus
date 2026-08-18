// packages/server/src/__tests__/tasks-v3-dispatch.test.ts
//
// Ticket 08 — dispatch $vars.task_artifacts_dir injection (three paths, SW-BP7).
//
// Four independent assertions:
//   AC1  simple task   → materializeTaskSpecToConfig injects
//                        input_values.task_artifacts_dir == homePath(id)/artifacts
//   AC2  composite task → buildCompositeInputValues PRESERVES the key (not dropped
//                        by the chain input_values replacement) → composition wf
//                        receives $vars.task_artifacts_dir
//   AC3  composition wf → dispatch-child input_mapping forwards
//                        $vars.task_artifacts_dir → subunit input_values
//   AC4  backward compat → legacy task (no taskArtifactsDir) → key omitted, no error
//
// Anti-fake-run: real better-sqlite3 + applySchema for AC2 (R1/R3); real
// WorkflowEngine for AC3 (R1 — deterministic edges not mocked); real
// TaskHomeService.artifactsDir path computation cross-checked (R3).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import path from "path"
import os from "os"
import { materializeTaskSpecToConfig } from "../services/scheduler/scheduler-service"
import { TaskHomeService } from "../services/tasks/task-home-service"
import { TasksService } from "../services/tasks/tasks-service"
import { SSEService } from "../services/sse"
import { WorkflowExecutor } from "../services/scheduler/executors/workflow-executor"
import { ScheduleConfigDAO, ScheduleRunDAO, ExecutionDAO } from "../db/dao"
import { applySchema } from "../db/schema"
import { WorkflowEngine } from "@octopus/engine"
import { VarPool } from "@octopus/shared"
import type {
  TaskSpec,
  SubunitSpec,
  WorkflowConfig,
  WorkflowDef,
  NodeDef,
  TaskDispatchPort,
  ScheduleHandle,
  SchedulerJob,
} from "@octopus/shared"

const ORG = "e2e-td-08"

// ── Mock getExecutionService for AC2 (composition wf fires-and-forgets) ──
const createSpy = vi.fn(() => ({ id: "exec-08-1" }))
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
    wsPath: "/tmp/e2e-td-08-ws",
  })),
}))

// ──────────────────────────────────────────────────────────────────────
//  AC1 + AC4: materializeTaskSpecToConfig (pure function, no DB)
// ──────────────────────────────────────────────────────────────────────

describe("08 AC1/AC4: materializeTaskSpecToConfig task_artifacts_dir injection", () => {
  const tmpBase = path.join(os.tmpdir(), `octopus-08-${Date.now()}`)
  const home = new TaskHomeService(tmpBase)
  const TASK_ID = "e2e-td-08-task-ac1"

  afterEach(() => {
    try { require("fs").rmSync(tmpBase, { recursive: true, force: true }) } catch { /* */ }
  })

  // AC1: simple task → input_values.task_artifacts_dir == homePath(id)/artifacts
  it("AC1: simple task config has input_values.task_artifacts_dir == artifactsDir(id)", () => {
    const taskSpec = { goal: "g", ac: ["a"] } as unknown as TaskSpec
    const expected = home.artifactsDir(TASK_ID)
    // Cross-check the path convention (ADR-0011): base/tasks/{id}/artifacts
    expect(expected).toBe(path.join(tmpBase, "tasks", TASK_ID, "artifacts"))

    const config = materializeTaskSpecToConfig(
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
    const config = materializeTaskSpecToConfig(
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
    const config = materializeTaskSpecToConfig(taskSpec, ["proj"], ORG, "wf", [])
    const iv = config.workflow_chain[0].input_values as Record<string, unknown>
    expect(iv.task_artifacts_dir).toBeUndefined()
  })

  // GS5/r2-05: key-set integrity. Value-checks (above) confirm the VALUE; this
  // confirms the KEY's structural presence/absence in Object.keys — a stronger
  // claim that catches "key set with undefined value" or "extra key leaked"
  // which toBeUndefined/toBe would miss. Independent truth source: the function
  // body builds simpleInputValues as `{}` or `{task_artifacts_dir}` — nothing else.
  it("AC1/AC4 boundary: simple input_values key-set is EXACTLY [task_artifacts_dir] when provided, [] when undefined (no leakage)", () => {
    const taskSpec = { goal: "g", ac: ["a"] } as unknown as TaskSpec
    const expected = home.artifactsDir(TASK_ID)

    const withArt = materializeTaskSpecToConfig(
      taskSpec, ["proj"], ORG, "e2e-td-08/wf", [], undefined, expected,
    )
    const ivWith = withArt.workflow_chain[0].input_values as Record<string, unknown>
    // Exact key-set: only task_artifacts_dir, no surprise keys.
    expect(Object.keys(ivWith)).toEqual(["task_artifacts_dir"])

    const withoutArt = materializeTaskSpecToConfig(taskSpec, ["proj"], ORG, "e2e-td-08/wf", [])
    const ivWithout = withoutArt.workflow_chain[0].input_values as Record<string, unknown>
    // Exact empty key-set: the key is never SET (not just undefined-valued) —
    // legacy tasks get a minimal config with no injection trace.
    expect(Object.keys(ivWithout)).toEqual([])
  })

  // GS5/r2-05: composite key-set + derived value. subunit_count is DERIVED inside
  // the function from `task_spec.subunits?.length` (not echoed from a param), so
  // asserting ===3 with 3 subunits is a real derived-value check. And the exact
  // key-set proves the composite branch carries both subunit_count + task_artifacts_dir.
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
    const config = materializeTaskSpecToConfig(
      taskSpec, ["proj"], ORG, undefined, [], undefined, expected,
    )
    const iv = config.workflow_chain[0].input_values as Record<string, unknown>
    // subunit_count is derived from task_spec.subunits.length inside the function
    // (not a param echo) — 3 subunits → 3.
    expect(iv.subunit_count).toBe(3)
    // Exact key-set (sorted for order-independence): composite branch produces
    // subunit_count + task_artifacts_dir, nothing else.
    expect(Object.keys(iv).sort()).toEqual(["subunit_count", "task_artifacts_dir"].sort())
  })
})

// ──────────────────────────────────────────────────────────────────────
//  AC2: buildCompositeInputValues preserves task_artifacts_dir
// ──────────────────────────────────────────────────────────────────────

describe("08 AC2: composite dispatch — buildCompositeInputValues preserves task_artifacts_dir", () => {
  let db: Database.Database
  let executor: WorkflowExecutor
  const wsId = "e2e-td-08-ws"
  const schedId = "e2e-td-08-sched"
  const schedExecId = "e2e-td-08-se"
  const mockSSE = { emit: vi.fn() } as any
  const createFromSpecSpy = vi.fn(() => ({ id: "e2e-td-08-coord-ws" }))
  const mockWorkspaceService = { createFromSpec: createFromSpecSpy, delete: vi.fn() } as any

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    db.pragma("foreign_keys = OFF")
    db.prepare(
      `INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, 'e2e-td-08-ws', ?, '/tmp/e2e-td-08-ws', datetime('now'), datetime('now'))`,
    ).run(wsId, ORG)
    executor = new WorkflowExecutor(
      mockSSE,
      new ScheduleConfigDAO(db),
      new ScheduleRunDAO(db),
      new ExecutionDAO(db),
      mockWorkspaceService,
    )
    createSpy.mockClear()
    startSpy.mockClear()
    createFromSpecSpy.mockClear()
    mockSSE.emit.mockClear()
  })
  afterEach(() => db.close())

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

  /** Composite config WITH task_artifacts_dir in workflow_chain[0].input_values
   *  (as materializeTaskSpecToConfig produces when taskArtifactsDir is provided). */
  function makeCompositeConfigWithArtifacts(subunits: SubunitSpec[], artifactsDir: string): WorkflowConfig {
    return {
      schema_version: "3.0",
      type: "workflow",
      workspace_spec: { org: ORG, branch_prefix: "e2e-td-08-coord", projects: [{ name: "coord", source_path: "", group: "" }] },
      workflow_chain: [{
        workflow_ref: "composition-task",
        input_values: {
          subunit_count: subunits.length,
          task_artifacts_dir: artifactsDir,
        } as unknown as Record<string, string>,
      }],
      max_retain: 10,
      task_spec: {
        goal: "E2E_TD_08_goal",
        ac: ["ac1"],
        subunits,
        integration_goal: { strategy: "synthesis", prompt: "E2E_TD_08_synth" },
      } as unknown as TaskSpec,
    }
  }

  function buildCompositeJob(config: WorkflowConfig): SchedulerJob {
    return {
      id: schedId, name: "e2e-td-08-composite", job_type: "workflow",
      cron_expression: null, timezone: "UTC", enabled: true, org: ORG, config,
      parallel_policy: "skip", timeout_seconds: 3600, notify_on_failure: false,
      version: 1, consecutive_failures: 0, next_trigger_at: null, deleted_at: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      status: "claimed", trigger_source: "requirement", source_chat_session_id: null,
      claimed_at: new Date().toISOString(),
    }
  }

  it("AC2: composition wf receives task_artifacts_dir in input_values (not dropped)", async () => {
    const subunits = [makeSubunit("a"), makeSubunit("b"), makeSubunit("c")]
    const artifactsDir = "/tmp/e2e-td-08/home/tasks/e2e-td-08-task/artifacts"
    const config = makeCompositeConfigWithArtifacts(subunits, artifactsDir)

    db.prepare(
      `INSERT INTO schedules (id, org, name, cron_expression, timezone, enabled, timeout_seconds, notify_on_failure,
        created_at, updated_at, job_type, config, parallel_policy, version, consecutive_failures, max_retain, status, origin_type, claimed_at)
       VALUES (?, ?, ?, NULL, 'UTC', 1, 3600, 0, datetime('now'), datetime('now'), 'workflow', ?, 'skip', 1, 0, 10, 'claimed', 'task', ?)`,
    ).run(schedId, ORG, "e2e-td-08-composite", JSON.stringify(config), new Date().toISOString())

    db.prepare(
      `INSERT INTO schedule_executions (id, schedule_id, status, trigger_type, triggered_at, timezone_offset, timezone_iana, created_at, triggered_by)
       VALUES (?, ?, 'triggered', 'scheduled', datetime('now'), '+00:00', 'UTC', datetime('now'), 'scheduler')`,
    ).run(schedExecId, schedId)

    const result = await executor.execute(buildCompositeJob(config), schedExecId)
    expect(result.success).toBe(true)

    // The composition wf's create() call carries buildCompositeInputValues output.
    // AC2: task_artifacts_dir must be present (not dropped by the replacement).
    expect(createSpy).toHaveBeenCalledTimes(1)
    // Cast through unknown: the spy is typed as a no-arg fn but the real
    // ExecutionService.create passes (workspaceId, config) — same pattern as
    // composite-dispatch.test.ts.
    const createCall = createSpy.mock.calls[0] as unknown as [unknown, { input_values: Record<string, unknown> }]
    const inputValues = createCall[1].input_values
    expect(inputValues.task_artifacts_dir).toBe(artifactsDir)
    // The other composite keys are still present (not clobbered)
    expect(inputValues.subunit_count).toBe(3)
    expect(inputValues.goal).toBe("E2E_TD_08_goal")

    // GS5/r2-05: composite preservation integrity. buildCompositeInputValues
    // completely REPLACES firstStep.input_values (the SW-BP7 hazard), then spreads
    // ...artifactsEntry LAST. These assertions prove every original key survives
    // that replacement AND task_artifacts_dir is not clobbered by an earlier key:
    //   - integration_prompt: a KEY-RENAME (task_spec.integration_goal.prompt →
    //     integration_prompt). Asserting the renamed key + value catches a
    //     regression where the rename is dropped (would yield undefined).
    //   - subunits: must be the ARRAY (not stringified) so the composition Loop
    //     can iterate it.
    //   - exact key-set: no key dropped, no extra key leaked.
    expect(inputValues.integration_prompt).toBe("E2E_TD_08_synth")
    expect(Array.isArray(inputValues.subunits)).toBe(true)
    expect(inputValues.subunits).toHaveLength(3)
    expect(Object.keys(inputValues).sort()).toEqual(
      ["goal", "integration_prompt", "subunit_count", "subunits", "task_artifacts_dir"],
    )
  })

  it("AC2/AC4: composite config WITHOUT task_artifacts_dir → key absent (backward compat)", async () => {
    const subunits = [makeSubunit("a"), makeSubunit("b")]
    const config = makeCompositeConfigWithArtifacts(subunits, "")
    // Remove the task_artifacts_dir to simulate a legacy config
    ;(config.workflow_chain[0].input_values as Record<string, unknown>).task_artifacts_dir = undefined

    db.prepare(
      `INSERT INTO schedules (id, org, name, cron_expression, timezone, enabled, timeout_seconds, notify_on_failure,
        created_at, updated_at, job_type, config, parallel_policy, version, consecutive_failures, max_retain, status, origin_type, claimed_at)
       VALUES (?, ?, ?, NULL, 'UTC', 1, 3600, 0, datetime('now'), datetime('now'), 'workflow', ?, 'skip', 1, 0, 10, 'claimed', 'task', ?)`,
    ).run(schedId, ORG, "e2e-td-08-compat", JSON.stringify(config), new Date().toISOString())

    db.prepare(
      `INSERT INTO schedule_executions (id, schedule_id, status, trigger_type, triggered_at, timezone_offset, timezone_iana, created_at, triggered_by)
       VALUES (?, ?, 'triggered', 'scheduled', datetime('now'), '+00:00', 'UTC', datetime('now'), 'scheduler')`,
    ).run(schedExecId, schedId)

    const result = await executor.execute(buildCompositeJob(config), schedExecId)
    expect(result.success).toBe(true)

    const createCall = createSpy.mock.calls[0] as unknown as [unknown, { input_values: Record<string, unknown> }]
    const inputValues = createCall[1].input_values
    expect(inputValues.task_artifacts_dir).toBeUndefined()
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

  /** Composition-style workflow (mirrors core-pack/composition-task.yaml shape)
   *  with input_mapping on the dispatch-child node. */
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

  function makePort(): { port: TaskDispatchPort; spy: ReturnType<typeof vi.fn> } {
    const spy = vi.fn().mockImplementation((_subunit: SubunitSpec) =>
      Promise.resolve({ schedule_id: "sch-08-1", workspace_id: "ws-08-1" } as ScheduleHandle),
    )
    return {
      port: {
        dispatchChildSchedule: spy,
        resumeOnCompletion: vi.fn().mockResolvedValue(undefined),
      },
      spy,
    }
  }

  it("AC3: task_dispatch input_mapping resolves $vars.task_artifacts_dir → subunit input_values", async () => {
    const subunits = [makeSubunit("a"), makeSubunit("b"), makeSubunit("c")]
    const wf = compositionWorkflow(subunits)
    const { port, spy } = makePort()

    const engine = new WorkflowEngine(wf, {}, process.cwd())
    engine.setTaskDispatchPort(port)

    // First run → dispatches subunit[0] → pauses (pending_task_dispatch)
    const res = await engine.run()
    expect(res.status).toBe("pending_task_dispatch")

    // The port received the subunit. AC3: the subunit's input_values must carry
    // task_artifacts_dir (resolved from $vars.task_artifacts_dir via input_mapping).
    expect(spy).toHaveBeenCalledTimes(1)
    const receivedSubunit = spy.mock.calls[0][0] as SubunitSpec
    expect(receivedSubunit.input_values.task_artifacts_dir).toBe(ARTIFACTS_DIR)
    // The existing goal mapping also works (bonus — input_mapping was previously
    // declared in composition-task.yaml but not resolved by the executor)
    expect(receivedSubunit.input_values.goal).toBe("E2E_TD_08_goal")
    // Original subunit identity preserved (not stringified)
    expect(receivedSubunit.name).toBe("a")
    expect(receivedSubunit.workflow_ref).toBe("e2e-td-08/simple")
  }, 20000)

  it("AC3/AC4: no input_mapping on the node → subunit input_values unchanged (backward compat)", async () => {
    const subunits = [makeSubunit("a")]
    // Workflow WITHOUT input_mapping on dispatch-child (existing behavior)
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

    // No input_mapping → subunit's input_values stays {} (task_artifacts_dir NOT injected)
    expect(spy).toHaveBeenCalledTimes(1)
    const receivedSubunit = spy.mock.calls[0][0] as SubunitSpec
    expect(receivedSubunit.input_values.task_artifacts_dir).toBeUndefined()
  }, 20000)

  // GS5/r2-05: type preservation through input_mapping. resolveMappingValue
  // (task-dispatch.ts:257) does `return this.pool.get(key)` for pure $vars.xxx —
  // VarPool stores `any` in a Map, and Object.entries preserves number/boolean.
  // So a non-string $vars value MUST arrive at the subunit with its type intact
  // (not stringified to "42"/"true"). This is a real edge the existing AC3 test
  // (string-only) does not cover. If a future refactor routes $vars through
  // substituteVars (which String()ifies), this test fails — catching the
  // type-loss regression before it reaches production dispatch.
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
              // string path (regression guard — existing behavior must still hold)
              task_artifacts_dir: "$vars.task_artifacts_dir",
              // numeric + boolean paths — the new edge under test
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
      // variables seeds VarPool via `new Map(Object.entries(variables))` —
      // Object.entries preserves number/boolean (not stringified).
      variables: {
        subunits,
        subunit_count: subunits.length,
        goal: "g",
        task_artifacts_dir: ARTIFACTS_DIR,
        numeric_metric: 42,   // number, not "42"
        flag: true,           // boolean, not "true"
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
    // resolveMappingValue returns pool.get(key) raw (no String()). Object.is is
    // type-strict, so toBe(42) DISTINGUISHES the number 42 from the string "42" —
    // a single assertion that fails the moment a refactor routes $vars through
    // substituteVars (which would stringify). No separate typeof check: it would
    // be logically implied by toBe(42) and thus tautological padding.
    expect(received.input_values.numeric_metric).toBe(42)
    expect(received.input_values.flag).toBe(true)
  }, 20000)
})

// ──────────────────────────────────────────────────────────────────────
//  GS5/r2-05: injection seam — TasksService.readyTask threads the injected
//  TaskHomeService.artifactsDir into the materialized schedule config.
//
//  Confirmed seam (Round 1): TasksService constructor takes an optional
//  `taskHomeService` (position 4). readyTask computes
//  `taskArtifactsDir = taskSpec.task_type !== undefined
//                      ? this.taskHomeService.artifactsDir(id) : undefined`
//  and passes it to materializeTaskSpecToConfig. By injecting a TaskHomeService
//  whose baseDir is a known temp prefix, we assert the resulting schedule
//  config's task_artifacts_dir CARRIES that temp prefix — proving the path
//  went through the injected seam, not the default os.homedir()/.octopus.
//  This is an end-to-end ready→materialize→insertSchedule exercise (real
//  :memory: DB, real TasksService); no HTTP, no production changes.
// ──────────────────────────────────────────────────────────────────────

describe("08 injection-seam: TasksService.readyTask uses injected TaskHomeService.baseDir", () => {
  let db: Database.Database
  let tempBase: string
  let svc: TasksService
  let sse: SSEService

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    tempBase = path.join(os.tmpdir(), `octopus-r2-05-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
    sse = new SSEService()
    // Inject a TaskHomeService whose baseDir is the temp prefix. readyTask will
    // call artifactsDir(id) = path.join(tempBase, "tasks", id, "artifacts").
    svc = new TasksService(db, sse, undefined, new TaskHomeService(tempBase))
  })
  afterEach(() => {
    db.close()
    try { require("fs").rmSync(tempBase, { recursive: true, force: true }) } catch { /* */ }
  })

  /** Seed a draft task row directly (mirrors tasks-v3-gates.test.ts insertTask). */
  function insertDraftTask(id: string, spec: Record<string, unknown>): void {
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO tasks (id, org, name, status, source_chat_session_id, task_spec,
        authoring_resources, resources, skills, project_ids, workflow_ref, version,
        deleted_at, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, 'draft', NULL, ?, '[]', '[]', '[]', '[]', NULL, 1, NULL, ?, ?, NULL)
    `).run(id, ORG, "r2-05-task", JSON.stringify(spec), now, now)
  }

  /** Read the schedule config that readyTask materialized (S2 origin lookup). */
  function readScheduleConfig(taskId: string): {
    workflow_chain: Array<{ workflow_ref: string; input_values: Record<string, unknown> }>
    task_spec?: unknown
    workspace_spec?: { org: string }
  } {
    const row = db.prepare(
      "SELECT config FROM schedules WHERE origin_id = ? AND origin_type = 'task'",
    ).get(taskId) as { config: string }
    return JSON.parse(row.config)
  }

  it("AC1-seam: v3 task ready → config.task_artifacts_dir carries injected tempBase (not default homedir)", () => {
    const id = "e2e-td-08-r2-05-v3"
    insertDraftTask(id, {
      goal: "E2E_TD r2-05 goal", ac: ["E2E_TD ac1"],
      task_type: "coding",            // v3 → readyTask injects taskArtifactsDir
      goal_confirmed: true,            // gate satisfied
      ac_confirmed: ["E2E_TD ac1"],
    })

    const dto = svc.readyTask(id)
    expect(dto.status).toBe("ready")

    const config = readScheduleConfig(id)
    const iv = config.workflow_chain[0].input_values
    const expected = path.join(tempBase, "tasks", id, "artifacts")
    // The injected base threaded through: path is EXACTLY tempBase/tasks/id/artifacts.
    expect(iv.task_artifacts_dir).toBe(expected)
    // SG5 (ticket 06): task_spec is DROPPED from the materialized config (lives
    // in the tasks table). A regression that re-attaches task_spec would fail
    // this — catches the "config carries task_spec" hazard independent of the
    // path assertions above.
    expect(config).not.toHaveProperty("task_spec")
    // The schedule envelope carries the S2 origin wiring (origin_type='task',
    // origin_id=task.id) — the seam TasksService.readyTask is responsible for.
    const sched = db.prepare(
      "SELECT origin_type, origin_id, status FROM schedules WHERE origin_id = ? AND origin_type = 'task'",
    ).get(id) as { origin_type: string; origin_id: string; status: string }
    expect(sched.origin_type).toBe("task")
    expect(sched.origin_id).toBe(id)
  })

  it("AC4-seam: v2 task (no task_type) ready → task_artifacts_dir key ABSENT (legacy backward compat, no home)", () => {
    const id = "e2e-td-08-r2-05-v2"
    // v2 task: no task_type → readyTask's `taskSpec.task_type !== undefined` is
    // false → taskArtifactsDir is undefined → no injection (AC4 backward compat).
    // The confirmation gate is ALSO skipped for v2 (gate is v3-only).
    insertDraftTask(id, { goal: "E2E_TD r2-05 v2 goal", ac: ["E2E_TD ac1"] })

    const dto = svc.readyTask(id)
    expect(dto.status).toBe("ready")

    const config = readScheduleConfig(id)
    const iv = config.workflow_chain[0].input_values
    // Exact empty key-set: legacy tasks get a minimal config with NO injection
    // trace (stronger than toBeUndefined — the key is never SET, so Object.keys
    // excludes it). A regression that injects an empty-string or undefined-valued
    // key would pass toBeUndefined but FAIL this exact-set check.
    expect(Object.keys(iv)).toEqual([])
    // No workflow_ref seeded on the task → materialize defaults to '' for simple.
    expect(config.workflow_chain[0].workflow_ref).toBe("")
  })
})
