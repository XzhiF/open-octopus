// packages/server/src/__tests__/composite-dispatch.test.ts
//
// ADR-0021 票03/票04 — the composite task END TO END on the server side: a task whose
// task_spec carries subunits arms a COORDINATOR workspace that runs the composition
// workflow, the composition workflow's `task_dispatch` node fans out a child RUN, the
// child finishes, and the PAUSED parent is woken with the child's output.
//
// What changed (ticket03-contract §数据形状 / §新行为 11) and how this file follows:
//   * The child used to be a private `schedules` row (origin_role='subunit') plus a
//     `schedule_executions` link, and the PARENT's status lived on the parent's
//     schedules row ('running' while the composition wf ran, 'done'/'failed' aggregated
//     from the CHILD schedules' statuses). All of that is gone: there is no parent
//     schedule to flip and no child schedule to aggregate. Deleted outright, not
//     weakened — the contract's aggregation rule for a finished composite is now
//     structural: the coordinator IS the round; its root execution row carries the
//     outcome (task-lifecycle finalize), and the children are its internals.
//   * The load-bearing pause/resume intent survives verbatim and is what this file now
//     pins: 父 composition-wf 在 task_dispatch 处持久暂停,子完成后被唤醒并拿到子的
//     var_pool 输出 — expressed as: dispatch arms an `executions` child row with
//     parent_id + task_id (rows, not callbacks → restart-safe); the completion path
//     derives the parent's RUNNING task_dispatch node and calls
//     resumeTaskDispatch(parentId, nodeId, childVarPool); a failed child still wakes
//     the parent (with an empty output — the composition wf decides); an over-cap
//     child parks as 'pending' and the built-in job's claim starts it, and a child
//     finalized through the job resumes the parent WITHOUT touching tasks.status
//     (a subunit's outcome is not the task's outcome).
//
// The engine-level Loop + task_dispatch semantics (pause → retryFrom) are owned by
// packages/engine/src/__tests__/{task-dispatch,task-dispatch-bridge,loop-task-dispatch}.test.ts;
// here the engine is stubbed at the ExecutionService seam (anti-fake-run: the DB writes,
// the arming, the claim, the correlation and the resume wiring all run for real).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"

const stub = vi.hoisted(() => ({
  db: null as Database.Database | null,
  wsDir: "",
  started: [] as string[],
  created: [] as Array<Record<string, unknown>>,
  wsSpecs: [] as Array<Record<string, unknown>>,
  callbacks: new Map<string, (status?: string) => void>(),
  resumes: [] as Array<{ parentId: string; nodeId: string; output: Record<string, unknown> }>,
  seq: 0,
}))

vi.mock("../services/execution-service-registry", () => ({
  getExecutionService: (wsId: string) => {
    const ws = stub.db!.prepare("SELECT path FROM workspaces WHERE id = ?").get(wsId) as
      { path: string } | undefined
    if (!ws) return undefined
    return {
      wsPath: ws.path,
      service: {
        create: (workspaceId: string, input: Record<string, unknown>) => {
          const id = `comp-exec-${stub.seq++}`
          // Real INSERT: ux_exec_task_active + the claim queue behave as in production.
          stub.db!.prepare(
            `INSERT INTO executions
               (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name, status,
                input_values, var_pool, org, triggered_by, created_at, updated_at, task_id, phase_index, round_index)
             VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, '{}', ?, ?, datetime('now'), datetime('now'), ?, ?, ?)`,
          ).run(
            id, workspaceId,
            String(input.parent_id ?? "0"), Number(input.child_index ?? 0),
            String(input.workflow_ref ?? ""), String(input.workflow_ref ?? ""),
            JSON.stringify(input.input_values ?? {}),
            "e2e-tp-org", String(input.triggered_by ?? "manual"),
            (input.task_id as string) ?? null,
            (input.phase_index as number) ?? null, (input.round_index as number) ?? null,
          )
          stub.created.push({ id, workspaceId, ...input })
          return { id }
        },
        start: async (id: string) => {
          stub.started.push(id)
          stub.db!.prepare("UPDATE executions SET status='running', started_at=datetime('now') WHERE id=?").run(id)
        },
        registerExternalCallbacks: (cbs: { onComplete?: (s?: string) => void }, id: string) => {
          if (cbs.onComplete) stub.callbacks.set(id, cbs.onComplete as (s?: string) => void)
        },
        clearExternalCallbacks: (id: string) => { stub.callbacks.delete(id) },
        resumeTaskDispatch: async (parentId: string, nodeId: string, output: Record<string, unknown>) => {
          stub.resumes.push({ parentId, nodeId, output })
        },
      },
    }
  },
}))

// Cap pinned for the same reason task-lifecycle.test.ts pins it: what is under test is
// that dispatch RESPECTS the shared meter, not what the number is today.
vi.mock("../services/scheduler/concurrency", () => ({
  MAX_PARALLEL_WORKSPACES: 2,
  MAX_AGENT_CONCURRENCY: 10,
  STALE_CLAIMED_THRESHOLD_MS: 600_000,
}))

import { applySchema } from "../db/schema"
import { SSEService } from "../services/sse"
import { TaskDAO } from "../db/dao/task-dao"
import { ExecutionDAO } from "../db/dao/execution-dao"
import { TaskLifecycleService } from "../services/tasks/task-lifecycle-service"
import { TaskDispatchService } from "../services/scheduler/task-dispatch-service"
import { TaskHomeService } from "../services/tasks/task-home-service"
import type { TaskRow } from "../db/types"
import type { SubunitSpec, TaskSpec } from "@octopus/shared"

const ORG = "e2e-tp-org"
const COMPOSITION_WF_REF = "composition-task"

function makeSubunit(name: string): SubunitSpec {
  return {
    name,
    workspace_spec: {
      org: ORG,
      branch_prefix: `e2e-tp-${name}`,
      projects: [{ name: "E2E_TP_project", source_path: "", group: "" }],
    },
    workflow_ref: "e2e-tp/simple-spec-workflow",
    input_values: {},
    skills: [],
    resources: [],
  }
}

describe("composite task dispatch — coordinator arm + child run + parent resume (票03/票04)", () => {
  let db: Database.Database
  let svc: TaskLifecycleService
  let dispatch: TaskDispatchService
  let execs: ExecutionDAO
  let tasks: TaskDAO
  let homeDir: string
  let wsDir: string
  let realHome: string | undefined
  let realUserProfile: string | undefined
  let taskHome: TaskHomeService

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    db.pragma("foreign_keys = OFF")
    stub.db = db
    stub.started = []
    stub.created = []
    stub.wsSpecs = []
    stub.callbacks = new Map()
    stub.resumes = []
    stub.seq = 0

    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "comp-home-"))
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "comp-ws-"))
    stub.wsDir = wsDir
    // HOME redirection + restore, same discipline as task-lifecycle.test.ts: leaking a
    // temp HOME into another file in the same worker produces isolation-only red.
    realHome = process.env.HOME
    realUserProfile = process.env.USERPROFILE
    process.env.HOME = homeDir
    process.env.USERPROFILE = homeDir
    taskHome = new TaskHomeService(path.join(homeDir, ".octopus"))

    const workspaceService = {
      getById: (id: string) =>
        (db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as never) ?? undefined,
      ensureWorktreesForReuse: () => ({ rebuilt: [] }),
      createFromSpec: (input: Record<string, unknown>) => {
        const id = `comp-ws-${stub.wsSpecs.length}`
        const p = path.join(wsDir, id)
        fs.mkdirSync(path.join(p, "workflows"), { recursive: true })
        db.prepare(
          `INSERT INTO workspaces (id, name, org, status, path, source, task_id, created_at, updated_at)
           VALUES (?, ?, ?, 'active', ?, 'task', ?, datetime('now'), datetime('now'))`,
        ).run(id, String(input.name), ORG, p, (input.task_id as string) ?? null)
        stub.wsSpecs.push({ id, ...input })
        return { id, name: input.name, org: ORG, status: "active", path: p }
      },
    }

    svc = new TaskLifecycleService({
      db,
      sse: new SSEService(),
      workspaceService: workspaceService as never,
      builtInWorkflows: { get: (ref: string) => ({ ref, content: "name: demo\nnodes: []\n", name: "demo" }) } as never,
      taskHomeService: taskHome,
    })

    // The port the engine calls from inside the coordinator's task_dispatch node.
    // Its workspaceId is the coordinator ws — resolved per test after arming.
    dispatch = null as never
    tasks = new TaskDAO(db)
    execs = new ExecutionDAO(db)
  })

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    if (realUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = realUserProfile
    db.close()
    fs.rmSync(wsDir, { recursive: true, force: true })
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  function insertCompositeTask(id: string, subunitNames: string[]): TaskRow {
    const now = new Date().toISOString()
    const spec = {
      goal: "E2E_TP_composite_goal",
      ac: ["E2E_TP_ac_1"],
      task_type: "coding",
      subunits: subunitNames.map(makeSubunit),
      integration_goal: { strategy: "synthesis", prompt: "E2E_TP_synthesis_prompt" },
    } as unknown as TaskSpec
    const row = {
      id, org: ORG, name: `T_${id}`, status: "ready",
      task_spec: JSON.stringify(spec),
      authoring_resources: "[]", resources: "[]", skills: "[]", project_ids: '["E2E_TP_proj"]',
      workflow_ref: null, version: 1, source_chat_session_id: null,
      deleted_at: null, created_at: now, updated_at: now, completed_at: null, workspace_id: null,
      trigger_mode: "manual", trigger_at: null, cron_expression: null,
      cron_timezone: "Asia/Shanghai", trigger_enabled: 1, next_fire_at: null, last_fired_at: null,
    } as unknown as TaskRow
    tasks.insert(row as never)
    return row
  }

  function makeDispatch(coordinatorWsId: string): TaskDispatchService {
    return new TaskDispatchService({
      db,
      workspaceId: coordinatorWsId,
      workspacePath: path.join(wsDir, coordinatorWsId),
      org: ORG,
      workspaceService: {
        createFromSpec: (input: Record<string, unknown>) => {
          const id = `child-ws-${stub.wsSpecs.length}`
          const p = path.join(wsDir, id)
          fs.mkdirSync(path.join(p, "workflows"), { recursive: true })
          db.prepare(
            `INSERT INTO workspaces (id, name, org, status, path, source, task_id, created_at, updated_at)
             VALUES (?, ?, ?, 'active', ?, 'task', ?, datetime('now'), datetime('now'))`,
          ).run(id, String(input.name), ORG, p, (input.task_id as string) ?? null)
          stub.wsSpecs.push({ id, ...input })
          return { id }
        },
      } as never,
      sse: new SSEService(),
    })
  }

  // ── AC: arming a composite builds a COORDINATOR ws (no projects) + composition wf ──
  it("arms a composite task as a coordinator workspace with NO projects + the composition-task ref + composite input_values", () => {
    insertCompositeTask("t-comp-1", ["a", "b", "c"])
    const execId = svc.armTask("t-comp-1")

    // Coordinator ws: projects=[] is the load-bearing distinction from a simple arm
    // (spec D4 — orchestration only; each subunit gets its own ws at dispatch).
    const coord = stub.wsSpecs.at(-1)!
    expect(coord.projects).toEqual([])
    expect((coord.workflow_chain as Array<{ workflow_ref: string }>)[0].workflow_ref).toBe(COMPOSITION_WF_REF)

    // The root execution carries the task binding and runs the composition wf with the
    // synthesized inputs the Loop consumes ($iteration.subunit / break_when count).
    const row = execs.findById(execId)!
    expect(row.task_id).toBe("t-comp-1")
    expect(row.parent_id).toBe("0")
    expect(row.workflow_ref).toBe(COMPOSITION_WF_REF)
    const iv = JSON.parse(row.input_values) as Record<string, unknown>
    expect(iv.subunit_count).toBe(3)
    expect(iv.goal).toBe("E2E_TP_composite_goal")
    expect(iv.integration_prompt).toBe("E2E_TP_synthesis_prompt")
    expect(Array.isArray(iv.subunits)).toBe(true)
    expect((iv.subunits as SubunitSpec[]).map((s) => s.name)).toEqual(["a", "b", "c"])
    // ticket08 AC2 preserved: the replacement must not DROP the injected home key.
    expect(iv.task_artifacts_dir).toBe(taskHome.artifactsDir("t-comp-1"))

    // No schedule row anywhere — the composite no longer borrows the pump's tables.
    expect((db.prepare("SELECT COUNT(*) c FROM schedules").get() as { c: number }).c).toBe(0)
  })

  // ── AC: 父在 task_dispatch 处持久暂停,子完成后被唤醒并拿到子的 var_pool 输出 ──
  it("the paused parent is woken with the child's var_pool output when the child run finalizes", async () => {
    insertCompositeTask("t-comp-2", ["a", "b"])
    const rootId = svc.armTask("t-comp-2")
    // The composition wf is dispatched on the coordinator → the engine marks the root
    // RUNNING and pauses INSIDE the task_dispatch node (a running node row is what the
    // pause persists — that is the whole restart-safety argument of 票03).
    db.prepare("UPDATE executions SET status='running', started_at=datetime('now') WHERE id=?").run(rootId)
    const coordinatorWsId = execs.findById(rootId)!.workspace_id
    db.prepare(
      "INSERT INTO node_executions (id, execution_id, node_id, node_type, status, started_at) VALUES (?, ?, 'dispatch-child', 'task_dispatch', 'running', datetime('now'))",
    ).run(`${rootId}-dispatch-child`, rootId)

    // The engine's port dispatches one subunit → a CHILD executions row correlated to
    // the paused root (parent_id) and to the same task (task_id).
    dispatch = makeDispatch(coordinatorWsId)
    const handle = await dispatch.dispatchChild(makeSubunit("a"))
    const child = execs.findById(handle.child_id)!
    expect(child.parent_id).toBe(rootId)
    expect(child.task_id).toBe("t-comp-2")

    // The child ran and put its result in its var_pool; the engine's terminal callback
    // now fires (row still 'running' — the persist lands after the callback, which is
    // exactly why finalize resolves the status from the engine's report).
    db.prepare("UPDATE executions SET var_pool = ? WHERE id = ?").run(JSON.stringify({ result: "E2E_TP_subunit_a_out" }), handle.child_id)

    // The ONLY two resume paths are the completion callback and the job's finalize —
    // here the job side: finalizeLaunch sees a CHILD row and hands the result to the
    // parent's waiting node instead of writing the task card.
    svc.finalizeLaunch(handle.child_id, "completed")
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    expect(stub.resumes).toHaveLength(1)
    expect(stub.resumes[0]).toMatchObject({
      parentId: rootId,
      nodeId: "dispatch-child",
      output: { result: "E2E_TP_subunit_a_out" },
    })
    // Finalized as terminal, and the row — not the card — carries the outcome.
    expect(execs.findById(handle.child_id)!.status).toBe("completed")
    // A subunit's outcome is NOT the task's outcome: no done/failed mirror for
    // children (task-lifecycle finalizeLaunch returns before the task write).
    expect(tasks.getById("t-comp-2")!.status).toBe("ready")
  })

  it("a FAILED child still wakes the paused parent (empty output), never leaves it stalled", async () => {
    insertCompositeTask("t-comp-3", ["a", "b"])
    const rootId = svc.armTask("t-comp-3")
    db.prepare("UPDATE executions SET status='running', started_at=datetime('now') WHERE id=?").run(rootId)
    const coordinatorWsId = execs.findById(rootId)!.workspace_id
    db.prepare(
      "INSERT INTO node_executions (id, execution_id, node_id, node_type, status, started_at) VALUES (?, ?, 'dispatch-child', 'task_dispatch', 'running', datetime('now'))",
    ).run(`${rootId}-dispatch-child`, rootId)

    dispatch = makeDispatch(coordinatorWsId)
    const handle = await dispatch.dispatchChild(makeSubunit("a"))

    // The dispatch path registered its own completion callback (startChildRun). The
    // child died with nothing in its pool — the callback still forwards, empty.
    stub.callbacks.get(handle.child_id)?.("failed")
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    // The composition workflow's own aggregation decides what a missing subunit means;
    // the parent is NOT left paused forever.
    expect(stub.resumes).toHaveLength(1)
    expect(stub.resumes[0]).toMatchObject({ parentId: rootId, nodeId: "dispatch-child", output: {} })
  })

  // ── AC: 超并发的子留 pending,由内置 job 领取并接通父回填 ──
  // KNOWN PRODUCT BUG (票04-partial, reported not papered): a parked child is claimed
  // by TaskLifecycleService.launchQueued, which flips pending→running via
  // execDAO.claimLaunch BEFORE delegating to startChildRun — but startChildRun re-runs
  // the SAME guarded claimLaunch (task-child-run.ts:149) and, seeing status!='pending',
  // returns false, so the child is marked running with NO engine started and the parent
  // is never wired. The two claims must be one guarded flip. This assertion is the
  // contract (§新行为 11 "超并发时留 pending 由 job 领取"); it goes green when the
  // double-claim is collapsed.
  it("an over-cap child parks as pending; the job's claim starts it with the parent-resume wiring", async () => {
    insertCompositeTask("t-comp-4", ["a", "b"])
    const rootId = svc.armTask("t-comp-4")
    db.prepare("UPDATE executions SET status='running', started_at=datetime('now') WHERE id=?").run(rootId)
    const coordinatorWsId = execs.findById(rootId)!.workspace_id
    db.prepare(
      "INSERT INTO node_executions (id, execution_id, node_id, node_type, status, started_at) VALUES (?, ?, 'dispatch-child', 'task_dispatch', 'running', datetime('now'))",
    ).run(`${rootId}-dispatch-child`, rootId)

    // Fill the shared gate (cap 2): the coordinator root is 1; one more live task row
    // puts countActiveWork at the cap, so the child cannot start now.
    db.prepare(
      `INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, org, status, started_at, created_at, updated_at, task_id)
       VALUES ('exec-busy', ?, '0', 'w', 'w', ?, 'running', datetime('now'), datetime('now'), datetime('now'), 't-busy')`,
    ).run(coordinatorWsId, ORG)

    dispatch = makeDispatch(coordinatorWsId)
    const handle = await dispatch.dispatchChild(makeSubunit("a"))
    expect(execs.findById(handle.child_id)!.status).toBe("pending")
    expect(stub.started).not.toContain(handle.child_id)

    // Free a slot; the built-in job's claim loop starts the parked child — the SAME
    // queue a root launch uses, so composite fan-out inherits the cap for free.
    db.prepare("UPDATE executions SET status='completed', completed_at=datetime('now') WHERE id='exec-busy'").run()
    const { launched } = svc.launchQueued()
    expect(launched).toBeGreaterThanOrEqual(1)
    expect(execs.findById(handle.child_id)!.status).toBe("running")
    expect(stub.started).toContain(handle.child_id)

    // The claim wired the child's completion to the parent: fire it, expect the resume.
    db.prepare("UPDATE executions SET var_pool='{\"result\":\"E2E_TP_claimed_out\"}', status='completed', completed_at=datetime('now') WHERE id=?").run(handle.child_id)
    stub.callbacks.get(handle.child_id)?.("completed")
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    expect(stub.resumes).toContainEqual({
      parentId: rootId,
      nodeId: "dispatch-child",
      output: { result: "E2E_TP_claimed_out" },
    })
  })
})
