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

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"

const stub = vi.hoisted(() => ({
  wsDir: "",
  started: [] as string[],
  created: [] as Array<Record<string, unknown>>,
  wsSpecs: [] as Array<Record<string, unknown>>,
  callbacks: new Map<string, (status?: string) => void>(),
  resumes: [] as Array<{ parentId: string; nodeId: string; output: Record<string, unknown> }>,
  /** Executions whose engine is NOT in this process — the mock's liveness answer. */
  dead: [] as string[],
  seq: 0,
}))

vi.mock("../services/execution-service-registry", () => ({
  // [P1 B5 票6b-1] 单引擎归一：workspaces/executions 均为 PG —— 镜像删除，桩直写注册池。
  getExecutionService: async (wsId: string) => {
    const wsRows = await pg!.sql`SELECT path FROM workspaces WHERE id = ${wsId}`
    const ws = wsRows[0] as { path: string } | undefined
    if (!ws) return undefined
    return {
      wsPath: ws.path,
      service: {
        create: async (workspaceId: string, input: Record<string, unknown>) => {
          const id = `comp-exec-${stub.seq++}`
          // Real INSERT: ux_exec_task_active + the claim queue behave as in production.
          await pg!.sql.unsafe(
            `INSERT INTO executions
               (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name, status,
                input_values, var_pool, org, triggered_by, created_at, updated_at, task_id, phase_index, round_index)
             VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7::jsonb, '{}'::jsonb, $8, $9, now(), now(), $10, $11, $12)`,
            [
              id, workspaceId,
              String(input.parent_id ?? "0"), Number(input.child_index ?? 0),
              String(input.workflow_ref ?? ""), String(input.workflow_ref ?? ""),
              JSON.stringify(input.input_values ?? {}),
              "e2e-tp-org", String(input.triggered_by ?? "manual"),
              (input.task_id as string) ?? null,
              (input.phase_index as number) ?? null, (input.round_index as number) ?? null,
            ],
          )
          stub.created.push({ id, workspaceId, ...input })
          return { id }
        },
        // Same precondition as the real engine — including the claimedLease handoff, so a
        // launcher that claims and then starts cannot drift from production again (票05).
        start: async (id: string, _iv?: unknown, _sync?: unknown, claimedLease?: string) => {
          const rowRows = await pg!.sql`SELECT status, started_at FROM executions WHERE id = ${id}`
          const row = rowRows[0] as { status: string; started_at: string | Date | null } | undefined
          // [票6b-1] PG timestamptz 读回 Date —— 与 claimedLease(ISO 串) 比较前按 DAO 同款归一。
          const leaseAt = row?.started_at instanceof Date ? row.started_at.toISOString() : row?.started_at ?? null
          if (claimedLease) {
            if (!row || row.status !== "running" || leaseAt !== claimedLease) {
              throw new Error("Execution is not claimed by this launcher")
            }
          } else if (!row || row.status !== "pending") {
            throw new Error("Execution is not pending")
          }
          stub.started.push(id)
          if (!claimedLease) {
            await pg!.sql.unsafe("UPDATE executions SET status='running', started_at=$1 WHERE id=$2",
              [new Date().toISOString(), id])
          }
        },
        registerExternalCallbacks: (cbs: { onComplete?: (s?: string) => void }, id: string) => {
          if (cbs.onComplete) stub.callbacks.set(id, cbs.onComplete as (s?: string) => void)
        },
        clearExternalCallbacks: (id: string) => { stub.callbacks.delete(id) },
        hasLiveEngine: (id: string) => !stub.dead.includes(id),
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
import { ScheduleRunDAO } from "../db/dao/schedule-run-dao"
import { describePg, setupRegisteredPgSchema, type PgFixture } from "../db/pg/__tests__/dao-fixture"
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

// [P1 B5 票6b-1] 单引擎：tasks/executions/workspaces/node_executions 全落 PG；
// SQLite `db` 仅保留 TaskLifecycleService/TaskDispatchService 构造签名。
// pg 模块级 —— vi.mock 桩闭包需要（与 tasks-trigger-mutex 同款）。
let pg: PgFixture | null = null

describePg("composite task dispatch — coordinator arm + child run + parent resume (票03/票04)", () => {
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

  // [P1 B5 票6b-1] mirrorExecsToPg 混窗镜像与计量闸 spy 已删 —— 单引擎归一（票5/票6a），
  // countActiveWork 直读同库。

  beforeAll(async () => {
    // 全局池注册 —— TaskLifecycleService 内部 taskDAO 经 pgSql() 取同一座库。
    pg = await setupRegisteredPgSchema()
  })

  afterAll(async () => {
    await pg?.close()
    pg = null
  })

  beforeEach(async () => {
    await pg!.truncate("node_executions", "executions", "workspaces", "schedule_executions", "schedules")
    db = new Database(":memory:")
    applySchema(db)
    db.pragma("foreign_keys = OFF")
    stub.started = []
    stub.created = []
    stub.wsSpecs = []
    stub.callbacks = new Map()
    stub.resumes = []
    stub.dead = []
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
      // [票6b-1] workspaces 已 PG；消费面 await（票6a）。
      getById: async (id: string) =>
        ((await pg!.sql`SELECT id, name, org, status, path, source, task_id FROM workspaces WHERE id = ${id}`)[0] as never) ?? undefined,
      ensureWorktreesForReuse: () => ({ rebuilt: [] }),
      createFromSpec: async (input: Record<string, unknown>) => {
        const id = `comp-ws-${stub.wsSpecs.length}`
        const p = path.join(wsDir, id)
        fs.mkdirSync(path.join(p, "workflows"), { recursive: true })
        await pg!.sql.unsafe(
          `INSERT INTO workspaces (id, name, org, status, path, source, task_id, created_at, updated_at)
           VALUES ($1, $2, $3, 'active', $4, 'task', $5, now(), now())`,
          [id, String(input.name), ORG, p, (input.task_id as string) ?? null],
        )
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
    tasks = new TaskDAO(pg!.sql)
    execs = new ExecutionDAO(pg!.sql)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    if (realUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = realUserProfile
    db.close()
    fs.rmSync(wsDir, { recursive: true, force: true })
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  async function insertCompositeTask(id: string, subunitNames: string[]): Promise<TaskRow> {
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
      cron_timezone: "Asia/Shanghai", trigger_enabled: true, next_fire_at: null, last_fired_at: null,
    } as unknown as TaskRow
    await tasks.insert(row as never)
    return row
  }

  function makeDispatch(coordinatorWsId: string): TaskDispatchService {
    return new TaskDispatchService({
      db,
      workspaceId: coordinatorWsId,
      workspacePath: path.join(wsDir, coordinatorWsId),
      org: ORG,
      workspaceService: {
        createFromSpec: async (input: Record<string, unknown>) => {
          const id = `child-ws-${stub.wsSpecs.length}`
          const p = path.join(wsDir, id)
          fs.mkdirSync(path.join(p, "workflows"), { recursive: true })
          await pg!.sql.unsafe(
            `INSERT INTO workspaces (id, name, org, status, path, source, task_id, created_at, updated_at)
             VALUES ($1, $2, $3, 'active', $4, 'task', $5, now(), now())`,
            [id, String(input.name), ORG, p, (input.task_id as string) ?? null],
          )
          stub.wsSpecs.push({ id, ...input })
          return { id }
        },
      } as never,
      sse: new SSEService(),
    })
  }

  // ── AC: arming a composite builds a COORDINATOR ws (no projects) + composition wf ──
  it("arms a composite task as a coordinator workspace with NO projects + the composition-task ref + composite input_values", async () => {
    await insertCompositeTask("t-comp-1", ["a", "b", "c"])
    const execId = await svc.armTask("t-comp-1")

    // Coordinator ws: projects=[] is the load-bearing distinction from a simple arm
    // (spec D4 — orchestration only; each subunit gets its own ws at dispatch).
    const coord = stub.wsSpecs.at(-1)!
    expect(coord.projects).toEqual([])
    expect((coord.workflow_chain as Array<{ workflow_ref: string }>)[0].workflow_ref).toBe(COMPOSITION_WF_REF)

    // The root execution carries the task binding and runs the composition wf with the
    // synthesized inputs the Loop consumes ($iteration.subunit / break_when count).
    const row = (await execs.findById(execId))!
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
    const schedRows = await pg!.sql`SELECT COUNT(*)::int AS c FROM schedules`
    expect((schedRows[0] as { c: number }).c).toBe(0)
  })

  // ── AC: 父在 task_dispatch 处持久暂停,子完成后被唤醒并拿到子的 var_pool 输出 ──
  it("the paused parent is woken with the child's var_pool output when the child run finalizes", async () => {
    await insertCompositeTask("t-comp-2", ["a", "b"])
    const rootId = await svc.armTask("t-comp-2")
    // The composition wf is dispatched on the coordinator → the engine marks the root
    // RUNNING and pauses INSIDE the task_dispatch node (a running node row is what the
    // pause persists — that is the whole restart-safety argument of 票03).
    await pg!.sql.unsafe("UPDATE executions SET status='running', started_at=now() WHERE id=$1", [rootId])
    const coordinatorWsId = (await execs.findById(rootId))!.workspace_id
    await pg!.sql.unsafe(
      "INSERT INTO node_executions (id, execution_id, node_id, node_type, status, started_at) VALUES ($1, $2, 'dispatch-child', 'task_dispatch', 'running', now())",
      [`${rootId}-dispatch-child`, rootId],
    )

    // The engine's port dispatches one subunit → a CHILD executions row correlated to
    // the paused root (parent_id) and to the same task (task_id).
    dispatch = makeDispatch(coordinatorWsId)
    const handle = await dispatch.dispatchChild(makeSubunit("a"))
    const child = (await execs.findById(handle.child_id))!
    expect(child.parent_id).toBe(rootId)
    expect(child.task_id).toBe("t-comp-2")

    // The child ran and put its result in its var_pool; the engine's terminal callback
    // now fires (row still 'running' — the persist lands after the callback, which is
    // exactly why finalize resolves the status from the engine's report).
    await pg!.sql.unsafe("UPDATE executions SET var_pool = $1::jsonb WHERE id = $2", [JSON.stringify({ result: "E2E_TP_subunit_a_out" }), handle.child_id])

    // The ONLY two resume paths are the completion callback and the job's finalize —
    // here the job side: finalizeLaunch sees a CHILD row and hands the result to the
    // parent's waiting node instead of writing the task card.
    await svc.finalizeLaunch(handle.child_id, "completed")
    // [票6b-1] finalize→resume 链是 fire-and-forget 跨多次 PG 往返 —— 屏障等事实落地
    // （vi.waitFor=四板斧之一，语义不变：只有这一条 resume 路径会填 stub.resumes）。
    await vi.waitFor(() => expect(stub.resumes).toHaveLength(1), { timeout: 5_000 })
    expect(stub.resumes[0]).toMatchObject({
      parentId: rootId,
      nodeId: "dispatch-child",
      output: { result: "E2E_TP_subunit_a_out" },
    })
    // Finalized as terminal, and the row — not the card — carries the outcome.
    expect((await execs.findById(handle.child_id))!.status).toBe("completed")
    // A subunit's outcome is NOT the task's outcome: no done/failed mirror for
    // children (task-lifecycle finalizeLaunch returns before the task write).
    expect((await tasks.getById("t-comp-2"))!.status).toBe("ready")
  })

  it("a FAILED child still wakes the paused parent (empty output), never leaves it stalled", async () => {
    await insertCompositeTask("t-comp-3", ["a", "b"])
    const rootId = await svc.armTask("t-comp-3")
    await pg!.sql.unsafe("UPDATE executions SET status='running', started_at=now() WHERE id=$1", [rootId])
    const coordinatorWsId = (await execs.findById(rootId))!.workspace_id
    await pg!.sql.unsafe(
      "INSERT INTO node_executions (id, execution_id, node_id, node_type, status, started_at) VALUES ($1, $2, 'dispatch-child', 'task_dispatch', 'running', now())",
      [`${rootId}-dispatch-child`, rootId],
    )

    dispatch = makeDispatch(coordinatorWsId)
    const handle = await dispatch.dispatchChild(makeSubunit("a"))

    // The dispatch path registered its own completion callback (startChildRun). The
    // child died with nothing in its pool — the callback still forwards, empty.
    stub.callbacks.get(handle.child_id)?.("failed")
    // [票6b-1] 同上：终态回调→父回填链 PG 化，屏障等待。
    await vi.waitFor(() => expect(stub.resumes).toHaveLength(1), { timeout: 5_000 })

    // The composition workflow's own aggregation decides what a missing subunit means;
    // the parent is NOT left paused forever.
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
    await insertCompositeTask("t-comp-4", ["a", "b"])
    const rootId = await svc.armTask("t-comp-4")
    await pg!.sql.unsafe("UPDATE executions SET status='running', started_at=now() WHERE id=$1", [rootId])
    const coordinatorWsId = (await execs.findById(rootId))!.workspace_id
    await pg!.sql.unsafe(
      "INSERT INTO node_executions (id, execution_id, node_id, node_type, status, started_at) VALUES ($1, $2, 'dispatch-child', 'task_dispatch', 'running', now())",
      [`${rootId}-dispatch-child`, rootId],
    )

    // Fill the shared gate (cap 2): the coordinator root is 1; one more live task row
    // puts countActiveWork at the cap, so the child cannot start now.
    await pg!.sql.unsafe(
      `INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, org, status, started_at, created_at, updated_at, task_id)
       VALUES ('exec-busy', $1, '0', 'w', 'w', $2, 'running', now(), now(), now(), 't-busy')`,
      [coordinatorWsId, ORG],
    )

    dispatch = makeDispatch(coordinatorWsId)
    const handle = await dispatch.dispatchChild(makeSubunit("a"))
    expect((await execs.findById(handle.child_id))!.status).toBe("pending")
    expect(stub.started).not.toContain(handle.child_id)

    // Free a slot; the built-in job's claim loop starts the parked child — the SAME
    // queue a root launch uses, so composite fan-out inherits the cap for free.
    await pg!.sql.unsafe("UPDATE executions SET status='completed', completed_at=now() WHERE id='exec-busy'")
    const { launched } = await svc.launchQueued()
    expect(launched).toBeGreaterThanOrEqual(1)
    expect((await execs.findById(handle.child_id))!.status).toBe("running")
    expect(stub.started).toContain(handle.child_id)

    // The claim wired the child's completion to the parent: fire it, expect the resume.
    await pg!.sql.unsafe("UPDATE executions SET var_pool='{\"result\":\"E2E_TP_claimed_out\"}'::jsonb, status='completed', completed_at=now() WHERE id=$1", [handle.child_id])
    stub.callbacks.get(handle.child_id)?.("completed")
    // [票6b-1] PG 化屏障（四板斧 vi.waitFor）。
    await vi.waitFor(() => expect(stub.resumes.length).toBeGreaterThan(0), { timeout: 5_000 })
    expect(stub.resumes).toContainEqual({
      parentId: rootId,
      nodeId: "dispatch-child",
      output: { result: "E2E_TP_claimed_out" },
    })
  })

  it("a parent whose child's completion callback was lost is woken by the tick (lost wake-up)", async () => {
    // The shape a lost callback leaves behind: the child row is terminal, the parent is
    // still 'pending_task_dispatch' with its engine alive, and the one callback that would
    // have resumed it is never coming. RecoveryManager does not cover it — it restarts
    // INTERRUPTED engines, and a paused parent is not interrupted, it is waiting on a
    // waiter that no longer exists. So nothing else in the system ever tells it, and the
    // round hangs holding a slot. What makes the question askable at all is 票03's row
    // shape: 「这个暂停节点还欠着子执行吗」 is a parent_id query, not a config-marker scan.
    await insertCompositeTask("t-comp-5", ["a", "b"])
    const rootId = await svc.armTask("t-comp-5")
    await pg!.sql.unsafe("UPDATE executions SET status='pending_task_dispatch' WHERE id=$1", [rootId])
    const coordinatorWsId = (await execs.findById(rootId))!.workspace_id
    await pg!.sql.unsafe(
      `INSERT INTO node_executions (id, execution_id, node_id, node_type, status, started_at)
       VALUES ($1, $2, 'dispatch-child', 'task_dispatch', 'pending_task_dispatch', now())`,
      [`${rootId}-dispatch-child`, rootId],
    )
    await pg!.sql.unsafe(
      `INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name,
         org, status, var_pool, started_at, completed_at, created_at, updated_at, task_id)
       VALUES ('child-done', $1, $2, 0, 'wf/a', 'a', $3, 'completed', '{"result":"E2E_TP_orphan"}'::jsonb,
         now() - INTERVAL '3 minutes', now() - INTERVAL '2 minutes', now() - INTERVAL '3 minutes', now() - INTERVAL '2 minutes', $4)`,
      [coordinatorWsId, rootId, ORG, "t-comp-5"],
    )

    const { resynced } = await svc.reconcile()
    expect(resynced).toBeGreaterThanOrEqual(1)
    expect(stub.resumes).toContainEqual({
      parentId: rootId,
      nodeId: "dispatch-child",
      output: { result: "E2E_TP_orphan" },
    })

    // The negatives that make the above mean something:
    //   ① a child still parked behind the cap (pending) or itself waiting must NOT be
    //      declared over, or the parent would be resumed with the wrong subunit's output
    //      mid-fan-out;
    //   ② a parent whose engine is ALSO gone must NOT be counted as recovered — there is
    //      nothing to receive the resume, and the strand reap owns that row (it ends it
    //      past the stale threshold instead of reporting a wake-up that cannot happen).
    stub.resumes.length = 0
    await pg!.sql.unsafe("UPDATE executions SET status='pending' WHERE id='child-done'")
    await svc.reconcile()
    expect(stub.resumes).toHaveLength(0)

    await pg!.sql.unsafe("UPDATE executions SET status='completed' WHERE id='child-done'")
    stub.dead.push(rootId)
    const after = await svc.reconcile()
    expect(stub.resumes).toHaveLength(0)
    expect(after.resynced).toBe(0)
    expect(after.reaped).toBe(0) // still inside the stale window — left alone, not killed early
    expect((await execs.findById(rootId))!.status).toBe("pending_task_dispatch")
  })
})
