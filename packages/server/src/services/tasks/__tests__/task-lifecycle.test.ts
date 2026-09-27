import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { describePg, pgTestEnabledOn, setupRegisteredPgSchema, type PgFixture } from "../../../db/pg/__tests__/dao-fixture"

/**
 * 票03 (ADR-0021) — the built-in `task-lifecycle` job.
 *
 * This file is the load-bearing test of the whole redesign. Everything the envelope used
 * to guarantee by convention (one instance per task, queue behind a shared cap, never
 * launch twice when two rounds overlap, release the slot when the run ends, resolve rows
 * nobody owns any more) is now this service's job, so the tests are written as the
 * properties that must hold rather than as a walk-through of the code.
 *
 * Two seams are stubbed, deliberately:
 *   - the ExecutionService registry — a real engine would need git + a provider; the
 *     stub writes REAL executions rows so the DB constraints (ux_exec_task_active) are
 *     exercised for real, and records start() calls so double-launch is observable.
 *   - the concurrency cap — pinned to 2 here rather than read from env, because what is
 *     under test is that the job RESPECTS the meter, not what the number is.
 *
 * P1 B2 双引擎 fixture：`tasks` 表落在 PG（每文件一座随机库，注册为全局池 ——
 * service 内部 taskDAO getter 经 pgSql() 取）；executions/workspaces/schedules/
 * node_executions/scheduler_state 仍在 SQLite `db`（B5 域）。用例间 truncate tasks。
 */

const stub = vi.hoisted(() => ({
  started: [] as string[],
  live: new Set<string>(),
  created: [] as Array<Record<string, unknown>>,
  callbacks: new Map<string, (status?: string) => void>(),
  failStart: false,
  seq: 0,
  db: null as Database.Database | null,
}))

vi.mock("../../execution-service-registry", () => ({
  getExecutionService: (wsId: string) => {
    const ws = stub.db!.prepare("SELECT path FROM workspaces WHERE id = ?").get(wsId) as
      { path: string } | undefined
    if (!ws) return undefined
    return {
      wsPath: ws.path,
      service: {
        create: (_workspaceId: string, input: Record<string, unknown>) => {
          // A real INSERT, so task_id + the UNIQUE latch behave exactly as in production.
          // parent_id is written from the input too (task-exec-tree v44): the arm side now
          // hands create() a chain lineage, and a stub that ignored it would hide whether
          // the row actually lands under its predecessor.
          const id = `lc-exec-${stub.seq++}`
          stub.db!.prepare(
            `INSERT INTO executions
               (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name, status,
                input_values, var_pool, org, created_at, updated_at, task_id, phase_index, round_index)
             VALUES (?, ?, ?, 0, ?, ?, 'pending', ?, ?, ?, datetime('now'), datetime('now'), ?, ?, ?)`,
          ).run(
            id, _workspaceId, input.parent_id ? String(input.parent_id) : "0", String(input.workflow_ref ?? ""), String(input.workflow_ref ?? ""),
            JSON.stringify(input.input_values ?? {}), JSON.stringify(input.initial_var_pool ?? {}),
            String(input.org ?? "xzf"), input.task_id ?? null, input.phase_index ?? null, input.round_index ?? null,
          )
          stub.created.push({ id, ...input })
          return { id }
        },
        // Mirrors ExecutionLifecycle.start's precondition, INCLUDING the claimed-lease
        // handoff (票05 真机实测:生产 start 要求 'pending',而 job 的领取已把行翻成 running,
        // 于是每次真启动都死在 "Execution is not pending" —— 一个忽略 claimedLease 参数的
        // stub 永远看不见这个 bug)。
        start: async (id: string, _iv?: Record<string, string>, _sync?: boolean, claimedLease?: string) => {
          const row = stub.db!.prepare("SELECT status, started_at FROM executions WHERE id=?").get(id) as
            { status: string; started_at: string | null } | undefined
          if (!row) throw new Error("Execution not found")
          if (claimedLease) {
            if (row.status !== "running" || row.started_at !== claimedLease) {
              throw new Error("Execution is not claimed by this launcher")
            }
          } else if (row.status !== "pending") {
            throw new Error("Execution is not pending")
          }
          if (stub.failStart) throw new Error("provider 挂了")
          stub.started.push(id)
          stub.live.add(id)
          if (!claimedLease) {
            stub.db!.prepare("UPDATE executions SET status='running', started_at=? WHERE id=?")
              .run(new Date().toISOString(), id)
          }
        },
        registerExternalCallbacks: (cbs: { onComplete?: (s?: string) => void }, id: string) => {
          if (cbs.onComplete) stub.callbacks.set(id, cbs.onComplete as (s?: string) => void)
        },
        clearExternalCallbacks: (id: string) => { stub.callbacks.delete(id); stub.live.delete(id) },
        cancel: (id: string) => { stub.live.delete(id); return { id } },
        hasLiveEngine: (id: string) => stub.live.has(id),
      },
    }
  },
}))

vi.mock("../../scheduler/concurrency", () => ({
  MAX_PARALLEL_WORKSPACES: 2,
  MAX_AGENT_CONCURRENCY: 10,
  STALE_CLAIMED_THRESHOLD_MS: 600_000,
}))

import { applySchema } from "../../../db/schema"
import { TaskDAO } from "../../../db/dao/task-dao"
import { ExecutionDAO } from "../../../db/dao/execution-dao"
import { ScheduleRunDAO } from "../../../db/dao/schedule-run-dao"
import { SSEService } from "../../sse"
import type { TaskRow } from "../../../db/types"
import type { TaskSpec } from "@octopus/shared"
import { TaskLifecycleService, TaskLifecycleError } from "../task-lifecycle-service"
import { TaskHomeService } from "../task-home-service"
import { TASK_TRIGGER_FAILED_EVENT, taskTriggerFailedPayloadSchema } from "@octopus/shared"

// P1 B2：tasks 造数/读断言全部走这座 PG 库（beforeAll 注册为全局池）。
let pg: PgFixture | null = null

let db: Database.Database
let sse: SSEService
let svc: TaskLifecycleService
let tasks: TaskDAO
let execs: ExecutionDAO
let wsDir: string
let homeDir: string
let taskHome: TaskHomeService
let events: Array<Record<string, unknown>>
let realHome: string | undefined
let realUserProfile: string | undefined
let wsSeq = 0

const ORG = "xzf"

// finalizeLaunch 是引擎回调里的 fire-and-forget 调用（registerLaunchCallbacks 不 await 它），
// 其尾巴含多次 PG 往返（状态镜像、产物回收、队列 drain）—— 单个 setImmediate 等不到落地。
// 实例级 wrapper 收集在飞的 Promise，complete()/settleFinalizers() 确定性等待。
let finalizePending = new Set<Promise<void>>()

async function settleFinalizers(): Promise<void> {
  while (finalizePending.size > 0) {
    await Promise.allSettled([...finalizePending])
    await new Promise((r) => setImmediate(r))
  }
}

/** P1 B2: tasks 表已迁 PG —— 用例里「重新入队/游标/绑定」的直写走这里（语义同旧 prepare UPDATE）。 */
async function updateTask(id: string, sets: Record<string, string | number | null>): Promise<void> {
  const cols = Object.keys(sets)
  const text = `UPDATE tasks SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(", ")} WHERE id = $${cols.length + 1}`
  await pg!.sql.unsafe(text, [...cols.map((c) => sets[c] as never), id])
}

beforeAll(async () => {
  if (!pgTestEnabledOn()) return
  pg = await setupRegisteredPgSchema()
})

afterAll(async () => {
  if (!pgTestEnabledOn()) return
  await pg?.close()
  pg = null
})

beforeEach(async () => {
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  applySchema(db)
  db.prepare("INSERT OR IGNORE INTO scheduler_state (id, last_heartbeat) VALUES (1, datetime('now'))").run()
  // PG 侧每用例清 tasks（本文件唯一的 PG 表），与 :memory: SQLite 同生命周期。
  await pg!.truncate("tasks")
  stub.db = db
  stub.started = []
  stub.live = new Set()
  stub.created = []
  stub.callbacks = new Map()
  stub.failStart = false
  stub.seq = 0
  wsSeq = 0
  events = []
  finalizePending = new Set()
  tasks = new TaskDAO(pg!.sql)
  execs = new ExecutionDAO(db)
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "lc-home-"))
  wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "lc-ws-"))
  // Both, because os.homedir() reads $HOME on POSIX and %USERPROFILE$ on Windows.
  // Saved + restored below: leaking a temp HOME into another test file in the same
  // worker makes unrelated suites fail only in the full run (isolation-only red), which
  // is the worst kind of red to debug.
  realHome = process.env.HOME
  realUserProfile = process.env.USERPROFILE
  process.env.HOME = homeDir
  process.env.USERPROFILE = homeDir
  sse = new SSEService()
  sse.subscribe("taskpool", (e) => events.push(e as Record<string, unknown>))
  taskHome = new TaskHomeService(path.join(homeDir, ".octopus"))
  svc = new TaskLifecycleService({
    db,
    sse,
    // Structural fake: only the three methods the lifecycle job calls exist. Typed as
    // never rather than a partial WorkspaceService so a future call to a real method
    // fails loudly here instead of returning undefined at runtime.
    workspaceService: fakeWorkspaceService() as never,
    builtInWorkflows: fakeBuiltIn() as never,
    taskHomeService: taskHome,
  })
  const realFinalize = svc.finalizeLaunch.bind(svc)
  svc.finalizeLaunch = (executionId: string, engineFinalStatus?: string): Promise<void> => {
    const p = realFinalize(executionId, engineFinalStatus)
    finalizePending.add(p)
    void p.finally(() => finalizePending.delete(p))
    return p
  }
})

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  if (realUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = realUserProfile
  fs.rmSync(wsDir, { recursive: true, force: true })
  fs.rmSync(homeDir, { recursive: true, force: true })
})

// ── fixtures ─────────────────────────────────────────────────────────

function fakeWorkspaceService() {
  return {
    getById: (id: string) =>
      (db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as never) ?? undefined,
    ensureWorktreesForReuse: () => ({ rebuilt: [] }),
    createFromSpec: (input: Record<string, unknown>) => {
      const id = `lc-ws-${wsSeq++}`
      const p = path.join(wsDir, id)
      fs.mkdirSync(path.join(p, "workflows"), { recursive: true })
      db.prepare(
        `INSERT INTO workspaces (id, name, org, status, path, source, task_id, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, 'task', ?, datetime('now'), datetime('now'))`,
      ).run(id, String(input.name), ORG, p, (input.task_id as string) ?? null)
      return { id, name: input.name, org: ORG, status: "active", path: p }
    },
  }
}

/** A built-in workflow with no required inputs — enough to satisfy ②/③ of the v4 gate. */
function fakeBuiltIn() {
  return {
    get: (ref: string) => ({
      ref,
      content: "name: demo\nnodes: []\n",
      name: ref.split("/").pop() ?? ref,
    }),
  }
}

async function insertTask(id: string, overrides: Partial<TaskRow> = {}, spec?: Partial<TaskSpec>): Promise<TaskRow> {
  const now = new Date().toISOString()
  const row = {
    id, org: ORG, name: `T_${id}`, status: "ready",
    task_spec: JSON.stringify({ goal: "做点什么", ac: ["能跑"], ...(spec ?? {}) }),
    authoring_resources: "[]", resources: "[]", skills: "[]", project_ids: "[]",
    workflow_ref: "built-in/demo", version: 1, source_chat_session_id: null,
    deleted_at: null, created_at: now, updated_at: now, completed_at: null,
    workspace_id: null,
    trigger_mode: "manual", trigger_at: null, cron_expression: null,
    cron_timezone: "Asia/Shanghai", trigger_enabled: 1, next_fire_at: null, last_fired_at: null,
    ...overrides,
  } as TaskRow
  await tasks.insert(row)
  return row
}

/** A v4 task whose phase 1 spec file exists under the home (the gate checks the disk). */
async function insertV4Task(id: string, opts: { phases?: number; deleteSpec?: boolean } = {}): Promise<TaskRow> {
  const n = opts.phases ?? 2
  const batchDir = path.join(taskHome.homePath(id), ".scratch", "2026-09-10")
  const phases = Array.from({ length: n }, (_, i) => ({
    slug: `p${i + 1}`,
    name: `阶段${i + 1}`,
    specPath: `.scratch/2026-09-10/p${i + 1}/spec.md`,
    workflowRef: "built-in/demo",
    inputValues: {},
  }))
  for (let i = 1; i <= n; i++) {
    const d = path.join(batchDir, `p${i}`)
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, "spec.md"), `# 阶段${i}\n`)
  }
  if (opts.deleteSpec) fs.rmSync(path.join(batchDir, "p1", "spec.md"))
  return insertTask(id, {}, { format: "v4", phases } as never)
}

async function bindWorkspace(taskId: string): Promise<string> {
  const id = `lc-ws-${wsSeq++}`
  const p = path.join(wsDir, id)
  fs.mkdirSync(path.join(p, "workflows"), { recursive: true })
  db.prepare(
    `INSERT INTO workspaces (id, name, org, status, path, source, task_id, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, 'task', ?, datetime('now'), datetime('now'))`,
  ).run(id, `ws-${taskId}`, ORG, p, taskId)
  await updateTask(taskId, { workspace_id: id })
  return id
}

function latestRoot(taskId: string) {
  return execs.findLatestTaskInstance(taskId)
}

/** Fire the terminal callback the way the engine does, and await the async tail. */
async function complete(execId: string, status?: string): Promise<void> {
  stub.callbacks.get(execId)?.(status)
  await new Promise((r) => setImmediate(r))
  await settleFinalizers()
}

// ── ① arm ────────────────────────────────────────────────────────────

describePg("task-lifecycle — arming creates the instance row", () => {
  it("arms a v3 task as a PENDING root row carrying task_id", async () => {
    await insertTask("a1")
    const execId = await svc.armTask("a1")
    const row = execs.findById(execId)!
    expect(row.task_id).toBe("a1")
    expect(row.status).toBe("pending")
    expect(row.parent_id).toBe("0")
    expect(row.workflow_ref).toBe("built-in/demo")
    // No round tags on a v3 task — the board distinguishes by their absence.
    expect([row.phase_index, row.round_index]).toEqual([null, null])
  })

  it("arms a v4 task at phase 1 round 1 and stamps the round coordinates", async () => {
    await insertV4Task("a2")
    const execId = await svc.armTask("a2")
    const row = execs.findById(execId)!
    expect([row.phase_index, row.round_index]).toEqual([1, 1])
    const iv = JSON.parse(row.input_values) as Record<string, string>
    expect(iv._phase_index).toBe("1")
    expect(iv._round_index).toBe("1")
  })

  it("arms a later phase/round when asked (验收打回 → 新一轮)", async () => {
    await insertV4Task("a3", { phases: 3 })
    const execId = await svc.armTask("a3", { phaseIndex: 2, roundIndex: 3, feedback: "重做" })
    const row = execs.findById(execId)!
    expect([row.phase_index, row.round_index]).toEqual([2, 3])
    expect(JSON.parse(row.input_values).feedback).toBe("重做")
  })

  it("refuses to arm a second instance while one is live — and the refusal is the LATCH", async () => {
    await insertTask("a4")
    await svc.armTask("a4")
    let caught: unknown
    try {
      await svc.armTask("a4")
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(TaskLifecycleError)
    expect((caught as TaskLifecycleError).reason).toBe("in-flight")
    // The DB holds exactly one live root — the refusal is not bookkeeping, it is the index.
    const live = db.prepare(
      "SELECT COUNT(*) c FROM executions WHERE task_id='a4' AND status NOT IN ('completed','failed','cancelled','aborted','skipped','rejected','completed_with_failures')",
    ).get() as { c: number }
    expect(live.c).toBe(1)
  })

  it("the latch itself blocks a row inserted without going through the pre-check", async () => {
    await insertTask("a5")
    const wsId = await bindWorkspace("a5")
    // Written straight to SQL, bypassing armTask entirely: what is under test is that the
    // index — not the pre-check — is the serializer.
    db.prepare(
      `INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, org, created_at, updated_at, task_id)
       VALUES ('x1', ?, '0', 'w', 'w', 'pending', 'xzf', datetime('now'), datetime('now'), 'a5')`,
    ).run(wsId)
    await expect(svc.armTask("a5")).rejects.toThrow(TaskLifecycleError)
  })

  it("two DIFFERENT tasks arm independently (the latch is per task, not global)", async () => {
    await insertTask("a6"); await insertTask("a7")
    await svc.armTask("a6")
    await svc.armTask("a7")
    expect(stub.created).toHaveLength(2)
  })

  it("refuses a task that is not enqueued, and one that is gone", async () => {
    await insertTask("a8", { status: "draft" })
    await expect(svc.armTask("a8")).rejects.toThrow(/ready/)
    await expect(svc.armTask("nope")).rejects.toThrow(/不存在/)
  })

  it("refuses when nothing is bound to run (rather than launching an empty workflow)", async () => {
    await insertTask("a9", { workflow_ref: null })
    let caught: TaskLifecycleError | undefined
    try {
      await svc.armTask("a9")
    } catch (err) { caught = err as TaskLifecycleError }
    expect(caught?.reason).toBe("no-workflow")
  })

  it("re-checks the v4 contract at launch: a deleted phase spec refuses instead of running blind", async () => {
    await insertV4Task("a10", { deleteSpec: true })
    let caught: TaskLifecycleError | undefined
    try {
      await svc.armTask("a10")
    } catch (err) { caught = err as TaskLifecycleError }
    expect(caught?.reason).toBe("gate")
    expect(caught?.message).toContain("phase:1:spec-missing")
  })

  it("reuses the bound workspace instead of building a second one per round", async () => {
    await insertTask("b1")
    const wsId = await bindWorkspace("b1")
    await svc.armTask("b1")
    expect(db.prepare("SELECT COUNT(*) c FROM workspaces WHERE task_id='b1'").get()).toEqual({ c: 1 })
    expect(execs.findLatestTaskInstance("b1")!.workspace_id).toBe(wsId)
  })

  it("builds and binds a workspace on first arm (task_id written, no schedule anywhere)", async () => {
    await insertTask("b2")
    const execId = await svc.armTask("b2")
    const ws = db.prepare("SELECT * FROM workspaces WHERE task_id='b2'").get() as { id: string }
    expect(ws).toBeTruthy()
    expect(execs.findById(execId)!.workspace_id).toBe(ws.id)
    expect((await tasks.getById("b2"))!.workspace_id).toBe(ws.id)
  })
})

// ── ①b execution tree (task-exec-tree, schema v44) ───────────────────

describePg("task-lifecycle — the run history is one tree (v44)", () => {
  /** arm → launch → complete one round, returning its row. */
  async function round(taskId: string, opts?: Parameters<TaskLifecycleService["armTask"]>[1]) {
    const execId = await svc.armTask(taskId, opts)
    await svc.launchQueued()
    await complete(execId, "completed")
    return execs.findById(execId)!
  }

  it("the first round is a root; every later TAGGED round chains under the previous instance", async () => {
    await insertV4Task("t1", { phases: 3 })
    const r1 = await round("t1")
    expect(r1.parent_id).toBe("0")
    const r2 = await round("t1", { phaseIndex: 2, roundIndex: 1 })
    expect(r2.parent_id).toBe(r1.id)
    const r3 = await round("t1", { phaseIndex: 3, roundIndex: 1 })
    expect(r3.parent_id).toBe(r2.id)
  })

  it("an UNTAGGED launch (v3) stays a root — the chain belongs to tagged rounds only", async () => {
    await insertTask("t2")
    await round("t2")
    await updateTask("t2", { status: "ready" })
    const again = await round("t2")
    expect(again.parent_id).toBe("0")
  })

  it("the badge/currentInstance follows the CHAIN TIP, not the newest root", async () => {
    await insertV4Task("t3", { phases: 3 })
    const r1 = await round("t3")
    const execId = await svc.armTask("t3", { phaseIndex: 2 })
    expect(execs.findLatestTaskInstance("t3")!.id).toBe(execId)
    expect(execs.findLatestTaskInstances(["t3"])[0].id).toBe(execId)
    // History is both instances, newest first.
    expect(execs.listTaskInstances("t3").map((r) => r.id)).toEqual([execId, r1.id])
  })

  it("a chained round still holds the single-instance latch (phase tag is enough)", async () => {
    await insertV4Task("t4")
    const r1 = await round("t4")
    const r2 = await svc.armTask("t4", { phaseIndex: 2 }) // chained, pending — instance row
    // Direct SQL, bypassing every pre-check: the index itself must refuse a second live
    // instance even though neither row may any longer be found by a roots-only probe.
    expect(() =>
      db.prepare(
        `INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, org, created_at, updated_at, task_id, phase_index, round_index)
         VALUES ('t4-x', (SELECT workspace_id FROM executions WHERE id=?), ?, 'w', 'w', 'pending', 'xzf', datetime('now'), datetime('now'), 't4', 3, 1)`,
      ).run(r2, r1.id),
    ).toThrow(/UNIQUE/)
  })

  it("a chained round launches through the TASK path (startRow), not the arm path", async () => {
    await insertV4Task("t5", { phases: 3 })
    await round("t5")
    const r2 = await svc.armTask("t5", { phaseIndex: 2 })
    expect((await svc.launchQueued()).launched).toBe(1)
    expect(stub.started).toContain(r2) // startChildRun would have failed on a completed parent
    await complete(r2, "completed")
    // Only the instance finalize emits the round's 待验收 + task_execution — the child
    // path returns before collectRound/emitPhaseAwaitingReview ever runs.
    const done = events.find(
      (e) => (e.data as { execution_id?: string })?.execution_id === r2 && (e.data as { phase_index?: number })?.phase_index === 2,
    )
    expect(done).toBeTruthy()
  })

  it("arms under a rebuilt workspace start a NEW tree (no cross-ws parent)", async () => {
    await insertV4Task("t6")
    const r1 = await round("t6")
    // Simulate the ws-rebuild branch of prepareWorkspace: the previous instance lives in
    // a workspace that is gone. Arm must not hand create() a cross-ws parent.
    db.pragma("foreign_keys = OFF")
    db.prepare("UPDATE executions SET workspace_id = 'ws-from-a-deleted-world' WHERE id = ?").run(r1.id)
    const r2 = await svc.armTask("t6", { phaseIndex: 2 })
    db.pragma("foreign_keys = ON")
    expect(execs.findById(r2)!.parent_id).toBe("0")
  })

  it("listTaskChildRuns keeps ARMS (untagged children); chained rounds are instances", async () => {
    await insertTask("t7")
    const ws = await bindWorkspace("t7")
    db.prepare(
      `INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, org, created_at, updated_at, task_id, phase_index, round_index)
       VALUES ('c-r1', ?, '0', 'w', 'w', 'completed', 'xzf', datetime('now'), datetime('now'), 't7', 1, 1)`,
    ).run(ws)
    db.prepare(
      `INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, org, created_at, updated_at, task_id, phase_index, round_index)
       VALUES ('c-r2', ?, 'c-r1', 'w', 'w', 'running', 'xzf', datetime('now'), datetime('now'), 't7', 2, 1)`,
    ).run(ws)
    // An arm: task_id set, parent set, NO phase tag → the subunit predicate, not an instance.
    db.prepare(
      `INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name, status, org, created_at, updated_at, task_id)
       VALUES ('c-arm', ?, 'c-r2', 0, 'w', 'w', 'running', 'xzf', datetime('now'), datetime('now'), 't7')`,
    ).run(ws)
    expect(execs.listTaskChildRuns("t7").map((r) => r.id)).toEqual(["c-arm"])
    // Both r1 (root) and r2 (chained) count as instances; the tip wins latest.
    expect(execs.listTaskInstances("t7").map((r) => r.id).sort()).toEqual(["c-r1", "c-r2"])
    expect(execs.findLatestTaskInstance("t7")!.id).toBe("c-r2")
  })

  it("schema v44 rebuilds a roots-only latch over instances (re-entrant)", () => {
    // Recreate the OLD index verbatim, then run the startup sequence again.
    db.exec("DROP INDEX ux_exec_task_active")
    db.exec(`CREATE UNIQUE INDEX ux_exec_task_active ON executions(task_id)
      WHERE task_id IS NOT NULL AND parent_id = '0'
        AND status NOT IN ('completed','completed_with_failures','failed','cancelled','aborted','skipped','rejected')`)
    applySchema(db)
    const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='ux_exec_task_active'").get() as { sql: string }
    expect(sql).toContain("phase_index IS NOT NULL")
    applySchema(db) // second pass: no-op, must not throw
    const { sql: sql2 } = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='ux_exec_task_active'").get() as { sql: string }
    expect(sql2).toBe(sql)
  })
})

// ── ② claim + the shared cap (hard gate) ─────────────────────────────

describePg("task-lifecycle — the claim queue and the concurrency gate", () => {
  it("launches armed rows and flips them pending → running", async () => {
    await insertTask("c1")
    await svc.armTask("c1")
    const { launched } = await svc.launchQueued()
    expect(launched).toBe(1)
    expect(stub.started).toHaveLength(1)
    expect(latestRoot("c1")!.status).toBe("running")
  })

  it("never launches past the shared cap — job fires count against it too", async () => {
    for (const id of ["c2", "c3", "c4"]) {
      await insertTask(id)
      await svc.armTask(id)
    }
    // One cron job fire in flight occupies a slot: cap is 2, so only ONE task may start.
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO schedules (id, org, name, cron_expression, timezone, enabled, job_type, config, created_at, updated_at)
       VALUES ('s-job', 'xzf', 'S', '* * * * *', 'UTC', 1, 'workflow', '{}', ?, ?)`,
    ).run(now, now)
    db.prepare(
      `INSERT INTO schedule_executions (id, schedule_id, status, trigger_type, triggered_at,
         timezone_offset, timezone_iana, created_at, triggered_by)
       VALUES ('f1', 's-job', 'running', 'scheduled', ?, '+00:00', 'UTC', ?, 'scheduler')`,
    ).run(now, now)

    const { launched, capped } = await svc.launchQueued()
    expect(launched).toBe(1)
    expect(capped).toBe(true)
    expect(latestRoot("c2")!.status).toBe("running")
    // FIFO: the queue is not starved or reordered — later rows wait.
    expect(latestRoot("c3")!.status).toBe("pending")
  })

  it("the built-in job's OWN fire does not eat a slot", async () => {
    // Two armed tasks, cap 2, one task-lifecycle fire running → both must still launch.
    await insertTask("c5"); await insertTask("c6")
    await svc.armTask("c5"); await svc.armTask("c6")
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO schedules (id, org, name, cron_expression, timezone, enabled, job_type, config, created_at, updated_at)
       VALUES ('builtin-task-lifecycle', 'xzf', '系统', '* * * * *', 'UTC', 1, 'job', '{}', ?, ?)`,
    ).run(now, now)
    db.prepare(
      `INSERT INTO schedule_executions (id, schedule_id, status, trigger_type, triggered_at,
         timezone_offset, timezone_iana, created_at, triggered_by)
       VALUES ('f2', 'builtin-task-lifecycle', 'running', 'scheduled', ?, '+00:00', 'UTC', ?, 'scheduler')`,
    ).run(now, now)
    expect((await svc.launchQueued()).launched).toBe(2)
  })

  it("re-entering the claim loop never starts a row twice (guarded claim)", async () => {
    await insertTask("c7")
    await svc.armTask("c7")
    await svc.launchQueued()
    await svc.launchQueued()
    await svc.launchQueued()
    expect(stub.started).toHaveLength(1)
  })

  it("two overlapping owners: the loser of the claim sees changes===0", async () => {
    await insertTask("c8")
    const execId = await svc.armTask("c8")
    expect(execs.claimLaunch(execId).changes).toBe(1)
    expect(execs.claimLaunch(execId).changes).toBe(0)
  })

  it("a row whose workspace vanished fails loudly and releases the task slot", async () => {
    await insertTask("c9")
    const execId = await svc.armTask("c9")
    db.pragma("foreign_keys = OFF") // a ws deleted out of band ≡ a row pointing at a gone ws
    db.prepare("UPDATE executions SET workspace_id = 'ws-deleted-out-of-band' WHERE id = ?").run(execId)
    db.pragma("foreign_keys = ON")
    const { launched } = await svc.launchQueued()
    expect(launched).toBe(0)
    expect(execs.findById(execId)!.status).toBe("failed")
    expect((await tasks.getById("c9"))!.status).toBe("failed")
    // Released: re-enqueued, the same task can be armed again (the latch let go).
    await updateTask("c9", { status: "ready" })
    await expect(svc.armTask("c9")).resolves.toBeTruthy()
  })

  it("an engine that refuses to start does not leave the row running forever", async () => {
    await insertTask("c10")
    const execId = await svc.armTask("c10")
    stub.failStart = true
    await svc.launchQueued()
    await new Promise((r) => setImmediate(r))
    await settleFinalizers()
    expect(execs.findById(execId)!.status).toBe("failed")
  })
})

// ── ③ finalize ───────────────────────────────────────────────────────

describePg("task-lifecycle — a round ending", () => {
  it("mirrors done onto a v3 task and releases the slot", async () => {
    await insertTask("d1")
    const execId = await svc.armAndLaunch("d1", { triggeredBy: "manual" })
    await complete(execId, "completed")
    expect(execs.findById(execId)!.status).toBe("completed")
    expect((await tasks.getById("d1"))!.status).toBe("done")
    // The slot is released (the latch no longer holds it) — proven by re-arming once the
    // task is enqueued again, which is what a human does after a run finishes.
    await updateTask("d1", { status: "ready" })
    await expect(svc.armTask("d1")).resolves.toBeTruthy()
  })

  it("a v4 round ending does NOT decide the task — 待验收 is derived, not stored", async () => {
    await insertV4Task("d2")
    const execId = await svc.armAndLaunch("d2")
    await complete(execId, "completed")
    expect((await tasks.getById("d2"))!.status).toBe("running")
    const awaiting = events.filter((e) => String(e.event).includes("phase_status_update"))
    expect(awaiting.length).toBeGreaterThan(0)
    expect(awaiting.at(-1)!.data).toMatchObject({ task_id: "d2", phase_index: 1, status: "awaiting_review" })
  })

  it("a failed round mirrors failed", async () => {
    await insertTask("d3")
    const execId = await svc.armAndLaunch("d3")
    await complete(execId, "failed")
    expect((await tasks.getById("d3"))!.status).toBe("failed")
  })

  it("an approval/interaction pause is not an ending", async () => {
    await insertTask("d4")
    const execId = await svc.armAndLaunch("d4")
    db.prepare("UPDATE executions SET status='pending_approval' WHERE id=?").run(execId)
    await complete(execId, "completed")
    expect(execs.findById(execId)!.status).toBe("pending_approval")
    expect((await tasks.getById("d4"))!.status).toBe("running")
  })

  it("the persisted status is not overwritten by the engine's later opinion", async () => {
    await insertTask("d5")
    const execId = await svc.armAndLaunch("d5")
    db.prepare("UPDATE executions SET status='cancelled' WHERE id=?").run(execId)
    await complete(execId, "completed")
    expect(execs.findById(execId)!.status).toBe("cancelled")
  })

  it("a task whose run ended out of band is resynced by the tick, not the callback", async () => {
    // Cancelled through the generic execution UI (no task-side abort involved): the row
    // is terminal, the card is still 执行中, and nothing calls finalize for it.
    await insertTask("d5b")
    const execId = await svc.armAndLaunch("d5b")
    db.prepare("UPDATE executions SET status='cancelled' WHERE id=?").run(execId)
    await updateTask("d5b", { status: "running" })
    await svc.tick()
    expect((await tasks.getById("d5b"))!.status).toBe("failed")
    // The slot is free — proven once a human re-enqueues (a one-shot task's run ending IS
    // its outcome; only a cron task returns to 已入队 by itself, see the cron test).
    await updateTask("d5b", { status: "ready" })
    expect(await svc.armTask("d5b")).toBeTruthy()
  })

  it("finalize is idempotent — the callback and the tick can both arrive", async () => {
    await insertTask("d6")
    const execId = await svc.armAndLaunch("d6")
    await complete(execId, "completed")
    const first = events.filter((e) => String(e.event) === "task_execution").length
    await svc.finalizeLaunch(execId, "completed")
    await settleFinalizers()
    expect(events.filter((e) => String(e.event) === "task_execution").length).toBe(first)
  })
})

describePg("task-lifecycle — finalize resolves the way the executor used to", () => {
  it("goal-task-dev T6 parity: an engine 'completed' over zero completed nodes is a failure", async () => {
    // The rule the executor used to own (and the reason this file exists): onComplete
    // fires inside run(), BEFORE the lifecycle persists the final status, so a pure DB
    // read sees a stale 'running'. Trusting the engine then needs the allSkipped guard —
    // a run that completed nothing but skipped everything achieved nothing.
    await insertTask("d7")
    const execId = await svc.armAndLaunch("d7")
    const addNode = (id: string, status: string) =>
      db.prepare("INSERT INTO node_executions (id, execution_id, node_id, node_type, status) VALUES (?, ?, ?, 'agent', ?)")
        .run(`n-${id}`, execId, id, status)
    addNode("a", "skipped")
    addNode("b", "skipped")
    await complete(execId, "completed")
    expect(execs.findById(execId)!.status).toBe("failed")

    // And the guard's own boundary: zero node rows at all stays completed (the lifecycle
    // rule has a length>0 guard; without it an empty workflow would fail).
    await insertTask("d8")
    const bare = await svc.armAndLaunch("d8")
    await complete(bare, "completed")
    expect(execs.findById(bare)!.status).toBe("completed")
  })

  it("a completed_with_failures round counts as done for the card", async () => {
    await insertTask("d9")
    const execId = await svc.armAndLaunch("d9")
    await complete(execId, "completed_with_failures")
    expect(execs.findById(execId)!.status).toBe("completed_with_failures")
    expect((await tasks.getById("d9"))!.status).toBe("done")
  })

  it("an unknown engine status is never written verbatim onto the task", async () => {
    await insertTask("d10")
    const execId = await svc.armAndLaunch("d10")
    await complete(execId, "waiting_for_luck" as never)
    expect(execs.findById(execId)!.status).toBe("completed")
  })
})

// ── ④ reconcile ──────────────────────────────────────────────────────

// ── 票05: a red run has to say why ───────────────────────────────────
//
// 票03 moved the failure writes into this service, and each of them had a reason in hand
// that it threw away (into console + the log) while the executions table has no error
// column. The read model can only surface what a writer stored, so the storage rule is
// pinned here: every path that ends a run red puts one line under var_pool.error, and the
// SSE event carries the same line.
describePg("task-lifecycle — every red run carries its reason (票05)", () => {
  const reasonOn = (execId: string): unknown =>
    JSON.parse(execs.findById(execId)!.var_pool).error

  it("a reap stores why it reaped, on the row and in the event", async () => {
    const execId = await armRunning("r1")
    age(execId, 30)
    stub.live.delete(execId)
    const { reaped } = await svc.reconcile()
    expect(reaped).toBe(1)
    expect(String(reasonOn(execId))).toContain("失去引擎进程")
    const ev = events.filter((e) => e.event === "task_execution").at(-1)
    expect(ev?.data).toMatchObject({ execution_id: execId, status: "aborted" })
    expect((ev?.data as Record<string, unknown>).reason).toContain("失去引擎进程")
  })

  it("a user abort says 用户中止, not nothing", async () => {
    const execId = await armRunning("r2")
    await svc.abortTask("r2")
    expect(String(reasonOn(execId))).toBe("用户中止")
    // The row is not the whole story: the board reads task_execution, so an abort that
    // only writes the row leaves the card showing 'running' until the next poll — and
    // the poll has no reason to show, because only this event carries one.
    const ev = events.filter((e) => e.event === "task_execution").at(-1)
    expect(ev?.data).toMatchObject({ task_id: "r2", execution_id: execId, status: "aborted" })
    expect((ev?.data as Record<string, unknown>).reason).toBe("用户中止")
  })

  it("a queued abort announces the retirement too", async () => {
    // 排队中 rows never started, so there is no engine event for them from anywhere else —
    // if this path stays silent the badge sits on 'pending' and the user has no idea their
    // 中止 landed.
    await insertTask("r2b")
    const execId = await svc.armTask("r2b")
    events.length = 0
    expect((await svc.abortTask("r2b")).retired).toEqual([execId])
    const ev = events.filter((e) => e.event === "task_execution")
    expect(ev).toHaveLength(1)
    expect((ev[0].data as Record<string, unknown>).reason).toContain("排队中")
    // Idempotence holds on the wire as well as in the table: a second abort is terminal
    // and emits nothing.
    events.length = 0
    await svc.abortTask("r2b")
    expect(events.filter((e) => e.event === "task_execution")).toHaveLength(0)
  })

  it("an engine that refuses to start puts its message on the row", async () => {
    await insertTask("r3")
    stub.failStart = true
    const execId = await svc.armTask("r3")
    await svc.launchQueued()
    await new Promise((r) => setImmediate(r))
    await settleFinalizers()
    expect(execs.findById(execId)!.status).toBe("failed")
    expect(String(reasonOn(execId))).toContain("provider 挂了")
  })

  it("a run the engine failed with no stored reason lifts the failing node's error", async () => {
    const execId = await armRunning("r4")
    execs.insertNodeExecutionOrIgnore({
      id: `${execId}-n1`, execution_id: execId, node_id: "build",
      node_type: "bash", status: "failed", error: "pnpm build 退出码 1",
      started_at: new Date().toISOString(),
    })
    await complete(execId, "failed")
    expect(String(reasonOn(execId))).toBe("pnpm build 退出码 1")
  })

  it("the composite aggregation says how many arms it folded in", async () => {
    // The coordinator's own workflow completes green even when an arm died (票04), so the
    // only truthful line available here is the count — and it must reach the row, or the
    // card flips red with nothing to point at.
    const execId = await armRunning("r5")
    const wsId = execs.findById(execId)!.workspace_id
    db.prepare(
      `INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name,
         name, status, org, created_at, updated_at, task_id)
       VALUES (?, ?, ?, 0, 'wf/a', 'a', 'subunit-a', 'failed', ?, datetime('now'), datetime('now'), 'r5')`,
    ).run(`${execId}-child`, wsId, execId, ORG)
    await complete(execId, "completed")
    expect(execs.findById(execId)!.status).toBe("failed")
    expect(String(reasonOn(execId))).toBe("1 个子单元执行失败")
  })

  it("finalize touches nothing on a green run — a leftover key is filtered by the read model", async () => {
    // The writer's rule is "only a red ending writes a reason". The badge's rule is
    // "only a terminal-failure row shows one" (errorSummaryOf, tasks-routes covers that);
    // pinning both halves is what keeps a stale key from ever reaching a green card.
    const execId = await armRunning("r6")
    db.prepare("UPDATE executions SET var_pool = ? WHERE id = ?")
      .run(JSON.stringify({ error: "上一轮遗留" }), execId)
    await complete(execId, "completed")
    expect(execs.findById(execId)!.status).toBe("completed")
    expect(JSON.parse(execs.findById(execId)!.var_pool).error).toBe("上一轮遗留")
  })
})

/** Arm + launch a task and return its live root execution (the shape a run has when it
 *  can be ended red). */
async function armRunning(taskId: string): Promise<string> {
  await insertTask(taskId)
  const execId = await svc.armAndLaunch(taskId)
  stub.live.add(execId)
  return execId
}

/** Backdate a row past the stale threshold (the mock writes SQLite's UTC clock, which
 *  dbTimeMs reads as UTC — same as production's ISO writes, by construction). */
function age(execId: string, minutes: number): void {
  const at = new Date(Date.now() - minutes * 60_000).toISOString()
  db.prepare("UPDATE executions SET started_at = ?, created_at = ?, updated_at = ? WHERE id = ?")
    .run(at, at, at, execId)
}

describePg("task-lifecycle — reconciliation (the orphan path, now task-side)", () => {
  async function stranded(taskId: string, ageMinutes: number, status = "running") {
    await insertTask(taskId)
    const execId = await svc.armTask(taskId)
    db.prepare("UPDATE executions SET status=?, started_at=?, updated_at=? WHERE id=?")
      .run(status, new Date(Date.now() - ageMinutes * 60_000).toISOString(),
        new Date(Date.now() - ageMinutes * 60_000).toISOString(), execId)
    return execId
  }

  it("reaps a stale running row whose engine is gone", async () => {
    const execId = await stranded("e1", 30)
    const { reaped } = await svc.reconcile()
    expect(reaped).toBe(1)
    expect(execs.findById(execId)!.status).toBe("aborted")
    expect((await tasks.getById("e1"))!.status).toBe("aborted")
  })

  it("leaves a young row alone — another tick may still be starting it", async () => {
    const execId = await stranded("e2", 1)
    expect((await svc.reconcile()).reaped).toBe(0)
    expect(execs.findById(execId)!.status).toBe("running")
  })

  it("leaves an alive engine alone", async () => {
    const execId = await stranded("e3", 30)
    stub.live.add(execId)
    expect((await svc.reconcile()).reaped).toBe(0)
  })

  it("never reaps a QUEUED row — waiting for a slot is the queue working", async () => {
    await insertTask("e4")
    const execId = await svc.armTask("e4")
    db.prepare("UPDATE executions SET created_at=datetime('now','-90 minutes') WHERE id=?").run(execId)
    expect((await svc.reconcile()).reaped).toBe(0)
    expect(execs.findById(execId)!.status).toBe("pending")
  })

  it("never reaps a PAUSED row — a pause is a human decision, not a strand", async () => {
    // ⚠️ This is not an edge case. ExecutionLifecycle.pause() calls
    // enginePool.remove() when the engine returns 'paused', so hasLiveEngine() is
    // ALREADY false when pause() returns — the engineAlive guard above cannot save
    // the row. And staleness is measured from started_at (the round's START), not
    // from the pause. So without the paused exemption a round that had been running
    // 30 minutes gets reaped to 'aborted' on the very next tick: the pause silently
    // undoes itself within a minute.
    const execId = await stranded("e7", 30, "paused")
    const before = (await tasks.getById("e7"))!.status
    expect((await svc.reconcile()).reaped).toBe(0)
    expect(execs.findById(execId)!.status).toBe("paused")
    // The task's row is untouched too — no reap means no finishTaskOutcome mirror.
    expect((await tasks.getById("e7"))!.status).toBe(before)
  })

  it("resyncs a task whose row finished but whose status never mirrored (died callback)", async () => {
    await insertTask("e5")
    const execId = await svc.armAndLaunch("e5")
    // Simulate the crash window: the execution row is terminal, tasks.status is stuck.
    db.prepare("UPDATE executions SET status='completed' WHERE id=?").run(execId)
    await updateTask("e5", { status: "running" })
    const { resynced } = await svc.reconcile()
    expect(resynced).toBe(1)
    expect((await tasks.getById("e5"))!.status).toBe("done")
  })

  it("after a reap the slot is free — the task can be armed again", async () => {
    await stranded("e6", 30)
    await svc.reconcile()
    await updateTask("e6", { status: "ready" })
    await expect(svc.armTask("e6")).resolves.toBeTruthy()
  })
})

// ── the tick: due-scan, cursor, suppression ──────────────────────────

describePg("task-lifecycle — tick (what the cron cadence drives)", () => {
  it("arms a due once-task, launches it, and retires the cursor permanently", async () => {
    await insertTask("f1", { trigger_mode: "once", trigger_at: "2020-01-01T00:00:00.000Z", next_fire_at: "2020-01-01T00:00:00.000Z" })
    const m = await svc.tick()
    expect(m.armed).toBe(1)
    expect(m.launched).toBe(1)
    const t = (await tasks.getById("f1"))!
    expect(t.next_fire_at).toBeNull()
    expect(t.last_fired_at).not.toBeNull()
    // A second tick must not arm it again.
    expect((await svc.tick()).armed).toBe(0)
  })

  it("a cron task keeps firing, but only one round at a time", async () => {
    await insertTask("f2", {
      trigger_mode: "cron", cron_expression: "* * * * *", cron_timezone: "UTC",
      next_fire_at: "2020-01-01T00:00:00.000Z",
    })
    await svc.tick()
    const execId1 = latestRoot("f2")!.id
    const t1 = (await tasks.getById("f2"))!
    expect(t1.next_fire_at).not.toBeNull()
    expect(Date.parse(t1.next_fire_at!) > Date.now()).toBe(true)

    // Round 1 is live: an overdue cursor must not queue a second instance.
    await updateTask("f2", { next_fire_at: "2020-01-01T00:00:00.000Z" })
    expect((await svc.tick()).armed).toBe(0)
    expect(db.prepare("SELECT COUNT(*) c FROM executions WHERE task_id='f2'").get()).toEqual({ c: 1 })

    // Ending the round returns a periodic task to 已入队 with the cursor jumped ahead —
    // 完成 is not a state a scheduled task parks in, or the schedule would be dead.
    await complete(execId1, "completed")
    const after = (await tasks.getById("f2"))!
    expect(after.status).toBe("ready")
    expect(Date.parse(after.next_fire_at!) > Date.now()).toBe(true)

    // Next occurrence due → a fresh instance, so this is a real repeating task.
    await updateTask("f2", { next_fire_at: "2020-01-01T00:00:00.000Z" })
    expect((await svc.tick()).armed).toBe(1)
    expect(db.prepare("SELECT COUNT(*) c FROM executions WHERE task_id='f2'").get()).toEqual({ c: 2 })
  })

  it("an arm that cannot happen (broken contract) retires the cursor and reports why", async () => {
    await insertV4Task("f3", { deleteSpec: true })
    await updateTask("f3", {
      trigger_mode: "once",
      trigger_at: "2020-01-01T00:00:00.000Z",
      next_fire_at: "2020-01-01T00:00:00.000Z",
    })
    const m = await svc.tick()
    expect(m.armed).toBe(0)
    expect(m.refused).toBe(1)
    expect((await tasks.getById("f3"))!.next_fire_at).toBeNull()
    const failed = events.find((e) => String(e.event) === TASK_TRIGGER_FAILED_EVENT)
    const payload = failed!.data as Record<string, unknown>
    expect(payload.reason).toContain("phase:1:spec-missing")
    // The payload is on the shared contract now (票05): a failure the board cannot parse
    // is a failure nobody sees, and this event has exactly one consumer-side schema.
    expect(taskTriggerFailedPayloadSchema.safeParse(payload).success).toBe(true)
    expect(payload.trigger_mode).toBe("once")
    expect(payload).not.toHaveProperty("action")
  })

  it("a manual task with no cursor is invisible to the tick", async () => {
    await insertTask("f4")
    expect((await svc.tick()).armed).toBe(0)
  })

  it("a disabled trigger is skipped even when due", async () => {
    await insertTask("f5", {
      trigger_mode: "once", trigger_at: "2020-01-01T00:00:00.000Z",
      next_fire_at: "2020-01-01T00:00:00.000Z", trigger_enabled: 0,
    })
    expect((await svc.tick()).armed).toBe(0)
  })

  it("the tick's own fire is not counted as work by the gate", async () => {
    const run = new ScheduleRunDAO(db)
    await insertTask("f6"); await svc.armTask("f6")
    const before = run.countActiveWork()
    expect(before).toBe(0) // pending holds no compute slot
    await svc.launchQueued()
    expect(run.countActiveWork()).toBe(1)
  })
})

// ── abort ────────────────────────────────────────────────────────────

describePg("task-lifecycle — abort", () => {
  it("cancels a running instance through the engine", async () => {
    await insertTask("g1")
    const execId = await svc.armAndLaunch("g1")
    const { cancelled } = await svc.abortTask("g1")
    expect(cancelled).toEqual([execId])
    expect(execs.findById(execId)!.status).toBe("aborted")
    expect((await tasks.getById("g1"))!.status).toBe("running") // the caller owns the task status
  })

  it("retires a queued instance without touching the engine", async () => {
    await insertTask("g2")
    const execId = await svc.armTask("g2")
    const { retired, cancelled } = await svc.abortTask("g2")
    expect(retired).toEqual([execId])
    expect(cancelled).toEqual([])
    expect(execs.findById(execId)!.status).toBe("aborted")
    // Queue retirement must not disturb a live sibling: nothing else is running here.
    expect(new ScheduleRunDAO(db).countActiveWork()).toBe(0)
  })

  it("an abort frees the slot and the queue drains in the same breath (票05)", async () => {
    // Contract §1c applies to a slot freed by 中止 as much as to one freed by a finished
    // run: otherwise a hand-stopped task leaves its successor waiting up to a cron minute.
    await insertTask("g-drain-a")
    await insertTask("g-drain-b")
    const a = await svc.armAndLaunch("g-drain-a")
    // cap is 2 here; pin the meter just below it so B arms but cannot launch yet.
    const b = await svc.armTask("g-drain-b")
    expect(execs.findById(b)!.status).toBe("pending")
    vi.spyOn(ScheduleRunDAO.prototype, "countActiveWork").mockReturnValue(2)
    expect(await svc.launchQueued()).toEqual({ launched: 0, capped: true })
    vi.restoreAllMocks()

    await svc.abortTask("g-drain-a")
    await settleFinalizers()
    expect(execs.findById(a)!.status).toBe("aborted")
    expect(JSON.parse(execs.findById(a)!.var_pool).error).toBe("用户中止")
    // The freed slot was used immediately — not on the next tick.
    expect(stub.started).toContain(b)
    expect(execs.findById(b)!.status).toBe("running")
  })

  it("aborting twice is a no-op, not an error", async () => {
    await insertTask("g3")
    await svc.armTask("g3")
    expect((await svc.abortTask("g3")).retired).toHaveLength(1)
    const again = await svc.abortTask("g3")
    expect(again.retired).toHaveLength(0)
    expect(again.cancelled).toHaveLength(0)
  })
})

// ── the boundary itself ──────────────────────────────────────────────

describePg("task-lifecycle — the scheduler is not consulted", () => {
  it("arming writes nothing to any schedule table", async () => {
    await insertTask("h1")
    await svc.armAndLaunch("h1")
    for (const table of ["schedules", "schedule_executions", "schedule_workspaces"]) {
      expect(db.prepare(`SELECT COUNT(*) c FROM ${table}`).get()).toEqual({ c: 0 })
    }
  })

  it("the history read model comes from executions, newest first", async () => {
    await insertTask("h2")
    const first = await svc.armTask("h2")
    db.prepare("UPDATE executions SET status='completed', completed_at=datetime('now') WHERE id=?").run(first)
    const second = await svc.armTask("h2", { triggeredBy: "manual" })
    const hist = svc.history("h2")
    expect(hist.map((r) => r.id)).toEqual([second, first])
  })
})
