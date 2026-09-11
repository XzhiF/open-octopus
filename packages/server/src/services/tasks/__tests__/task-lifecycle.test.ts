import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"

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
          const id = `lc-exec-${stub.seq++}`
          stub.db!.prepare(
            `INSERT INTO executions
               (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name, status,
                input_values, var_pool, org, created_at, updated_at, task_id, phase_index, round_index)
             VALUES (?, ?, '0', 0, ?, ?, 'pending', ?, ?, ?, datetime('now'), datetime('now'), ?, ?, ?)`,
          ).run(
            id, _workspaceId, String(input.workflow_ref ?? ""), String(input.workflow_ref ?? ""),
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

beforeEach(() => {
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  applySchema(db)
  db.prepare("INSERT OR IGNORE INTO scheduler_state (id, last_heartbeat) VALUES (1, datetime('now'))").run()
  stub.db = db
  stub.started = []
  stub.live = new Set()
  stub.created = []
  stub.callbacks = new Map()
  stub.failStart = false
  stub.seq = 0
  wsSeq = 0
  events = []
  tasks = new TaskDAO(db)
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

function insertTask(id: string, overrides: Partial<TaskRow> = {}, spec?: Partial<TaskSpec>): TaskRow {
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
  tasks.insert(row)
  return row
}

/** A v4 task whose phase 1 spec file exists under the home (the gate checks the disk). */
function insertV4Task(id: string, opts: { phases?: number; deleteSpec?: boolean } = {}): TaskRow {
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

function bindWorkspace(taskId: string): string {
  const id = `lc-ws-${wsSeq++}`
  const p = path.join(wsDir, id)
  fs.mkdirSync(path.join(p, "workflows"), { recursive: true })
  db.prepare(
    `INSERT INTO workspaces (id, name, org, status, path, source, task_id, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, 'task', ?, datetime('now'), datetime('now'))`,
  ).run(id, `ws-${taskId}`, ORG, p, taskId)
  db.prepare("UPDATE tasks SET workspace_id = ? WHERE id = ?").run(id, taskId)
  return id
}

function latestRoot(taskId: string) {
  return execs.findLatestTaskRoot(taskId)
}

/** Fire the terminal callback the way the engine does, and await the async tail. */
async function complete(execId: string, status?: string): Promise<void> {
  stub.callbacks.get(execId)?.(status)
  await new Promise((r) => setImmediate(r))
}

// ── ① arm ────────────────────────────────────────────────────────────

describe("task-lifecycle — arming creates the instance row", () => {
  it("arms a v3 task as a PENDING root row carrying task_id", () => {
    insertTask("a1")
    const execId = svc.armTask("a1")
    const row = execs.findById(execId)!
    expect(row.task_id).toBe("a1")
    expect(row.status).toBe("pending")
    expect(row.parent_id).toBe("0")
    expect(row.workflow_ref).toBe("built-in/demo")
    // No round tags on a v3 task — the board distinguishes by their absence.
    expect([row.phase_index, row.round_index]).toEqual([null, null])
  })

  it("arms a v4 task at phase 1 round 1 and stamps the round coordinates", () => {
    insertV4Task("a2")
    const execId = svc.armTask("a2")
    const row = execs.findById(execId)!
    expect([row.phase_index, row.round_index]).toEqual([1, 1])
    const iv = JSON.parse(row.input_values) as Record<string, string>
    expect(iv._phase_index).toBe("1")
    expect(iv._round_index).toBe("1")
  })

  it("arms a later phase/round when asked (验收打回 → 新一轮)", () => {
    insertV4Task("a3", { phases: 3 })
    const execId = svc.armTask("a3", { phaseIndex: 2, roundIndex: 3, feedback: "重做" })
    const row = execs.findById(execId)!
    expect([row.phase_index, row.round_index]).toEqual([2, 3])
    expect(JSON.parse(row.input_values).feedback).toBe("重做")
  })

  it("refuses to arm a second instance while one is live — and the refusal is the LATCH", () => {
    insertTask("a4")
    svc.armTask("a4")
    let caught: unknown
    try {
      svc.armTask("a4")
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

  it("the latch itself blocks a row inserted without going through the pre-check", () => {
    insertTask("a5")
    const wsId = bindWorkspace("a5")
    // Written straight to SQL, bypassing armTask entirely: what is under test is that the
    // index — not the pre-check — is the serializer.
    db.prepare(
      `INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, org, created_at, updated_at, task_id)
       VALUES ('x1', ?, '0', 'w', 'w', 'pending', 'xzf', datetime('now'), datetime('now'), 'a5')`,
    ).run(wsId)
    expect(() => svc.armTask("a5")).toThrow(TaskLifecycleError)
  })

  it("two DIFFERENT tasks arm independently (the latch is per task, not global)", () => {
    insertTask("a6"); insertTask("a7")
    svc.armTask("a6")
    svc.armTask("a7")
    expect(stub.created).toHaveLength(2)
  })

  it("refuses a task that is not enqueued, and one that is gone", () => {
    insertTask("a8", { status: "draft" })
    expect(() => svc.armTask("a8")).toThrow(/ready/)
    expect(() => svc.armTask("nope")).toThrow(/不存在/)
  })

  it("refuses when nothing is bound to run (rather than launching an empty workflow)", () => {
    insertTask("a9", { workflow_ref: null })
    let caught: TaskLifecycleError | undefined
    try {
      svc.armTask("a9")
    } catch (err) { caught = err as TaskLifecycleError }
    expect(caught?.reason).toBe("no-workflow")
  })

  it("re-checks the v4 contract at launch: a deleted phase spec refuses instead of running blind", () => {
    insertV4Task("a10", { deleteSpec: true })
    let caught: TaskLifecycleError | undefined
    try {
      svc.armTask("a10")
    } catch (err) { caught = err as TaskLifecycleError }
    expect(caught?.reason).toBe("gate")
    expect(caught?.message).toContain("phase:1:spec-missing")
  })

  it("reuses the bound workspace instead of building a second one per round", () => {
    insertTask("b1")
    const wsId = bindWorkspace("b1")
    svc.armTask("b1")
    expect(db.prepare("SELECT COUNT(*) c FROM workspaces WHERE task_id='b1'").get()).toEqual({ c: 1 })
    expect(execs.findLatestTaskRoot("b1")!.workspace_id).toBe(wsId)
  })

  it("builds and binds a workspace on first arm (task_id written, no schedule anywhere)", () => {
    insertTask("b2")
    const execId = svc.armTask("b2")
    const ws = db.prepare("SELECT * FROM workspaces WHERE task_id='b2'").get() as { id: string }
    expect(ws).toBeTruthy()
    expect(execs.findById(execId)!.workspace_id).toBe(ws.id)
    expect(tasks.getById("b2")!.workspace_id).toBe(ws.id)
  })
})

// ── ② claim + the shared cap (hard gate) ─────────────────────────────

describe("task-lifecycle — the claim queue and the concurrency gate", () => {
  it("launches armed rows and flips them pending → running", () => {
    insertTask("c1")
    svc.armTask("c1")
    const { launched } = svc.launchQueued()
    expect(launched).toBe(1)
    expect(stub.started).toHaveLength(1)
    expect(latestRoot("c1")!.status).toBe("running")
  })

  it("never launches past the shared cap — job fires count against it too", () => {
    for (const id of ["c2", "c3", "c4"]) {
      insertTask(id)
      svc.armTask(id)
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

    const { launched, capped } = svc.launchQueued()
    expect(launched).toBe(1)
    expect(capped).toBe(true)
    expect(latestRoot("c2")!.status).toBe("running")
    // FIFO: the queue is not starved or reordered — later rows wait.
    expect(latestRoot("c3")!.status).toBe("pending")
  })

  it("the built-in job's OWN fire does not eat a slot", () => {
    // Two armed tasks, cap 2, one task-lifecycle fire running → both must still launch.
    insertTask("c5"); insertTask("c6")
    svc.armTask("c5"); svc.armTask("c6")
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
    expect(svc.launchQueued().launched).toBe(2)
  })

  it("re-entering the claim loop never starts a row twice (guarded claim)", () => {
    insertTask("c7")
    svc.armTask("c7")
    svc.launchQueued()
    svc.launchQueued()
    svc.launchQueued()
    expect(stub.started).toHaveLength(1)
  })

  it("two overlapping owners: the loser of the claim sees changes===0", () => {
    insertTask("c8")
    const execId = svc.armTask("c8")
    expect(execs.claimLaunch(execId).changes).toBe(1)
    expect(execs.claimLaunch(execId).changes).toBe(0)
  })

  it("a row whose workspace vanished fails loudly and releases the task slot", () => {
    insertTask("c9")
    const execId = svc.armTask("c9")
    db.pragma("foreign_keys = OFF") // a ws deleted out of band ≡ a row pointing at a gone ws
    db.prepare("UPDATE executions SET workspace_id = 'ws-deleted-out-of-band' WHERE id = ?").run(execId)
    db.pragma("foreign_keys = ON")
    const { launched } = svc.launchQueued()
    expect(launched).toBe(0)
    expect(execs.findById(execId)!.status).toBe("failed")
    expect(tasks.getById("c9")!.status).toBe("failed")
    // Released: re-enqueued, the same task can be armed again (the latch let go).
    db.prepare("UPDATE tasks SET status='ready' WHERE id='c9'").run()
    expect(() => svc.armTask("c9")).not.toThrow()
  })

  it("an engine that refuses to start does not leave the row running forever", async () => {
    insertTask("c10")
    const execId = svc.armTask("c10")
    stub.failStart = true
    svc.launchQueued()
    await new Promise((r) => setImmediate(r))
    expect(execs.findById(execId)!.status).toBe("failed")
  })
})

// ── ③ finalize ───────────────────────────────────────────────────────

describe("task-lifecycle — a round ending", () => {
  it("mirrors done onto a v3 task and releases the slot", async () => {
    insertTask("d1")
    const execId = svc.armAndLaunch("d1", { triggeredBy: "manual" })
    await complete(execId, "completed")
    expect(execs.findById(execId)!.status).toBe("completed")
    expect(tasks.getById("d1")!.status).toBe("done")
    // The slot is released (the latch no longer holds it) — proven by re-arming once the
    // task is enqueued again, which is what a human does after a run finishes.
    db.prepare("UPDATE tasks SET status='ready' WHERE id='d1'").run()
    expect(() => svc.armTask("d1")).not.toThrow()
  })

  it("a v4 round ending does NOT decide the task — 待验收 is derived, not stored", async () => {
    insertV4Task("d2")
    const execId = svc.armAndLaunch("d2")
    await complete(execId, "completed")
    expect(tasks.getById("d2")!.status).toBe("running")
    const awaiting = events.filter((e) => String(e.event).includes("phase_status_update"))
    expect(awaiting.length).toBeGreaterThan(0)
    expect(awaiting.at(-1)!.data).toMatchObject({ task_id: "d2", phase_index: 1, status: "awaiting_review" })
  })

  it("a failed round mirrors failed", async () => {
    insertTask("d3")
    const execId = svc.armAndLaunch("d3")
    await complete(execId, "failed")
    expect(tasks.getById("d3")!.status).toBe("failed")
  })

  it("an approval/interaction pause is not an ending", async () => {
    insertTask("d4")
    const execId = svc.armAndLaunch("d4")
    db.prepare("UPDATE executions SET status='pending_approval' WHERE id=?").run(execId)
    await complete(execId, "completed")
    expect(execs.findById(execId)!.status).toBe("pending_approval")
    expect(tasks.getById("d4")!.status).toBe("running")
  })

  it("the persisted status is not overwritten by the engine's later opinion", async () => {
    insertTask("d5")
    const execId = svc.armAndLaunch("d5")
    db.prepare("UPDATE executions SET status='cancelled' WHERE id=?").run(execId)
    await complete(execId, "completed")
    expect(execs.findById(execId)!.status).toBe("cancelled")
  })

  it("a task whose run ended out of band is resynced by the tick, not the callback", async () => {
    // Cancelled through the generic execution UI (no task-side abort involved): the row
    // is terminal, the card is still 执行中, and nothing calls finalize for it.
    insertTask("d5b")
    const execId = svc.armAndLaunch("d5b")
    db.prepare("UPDATE executions SET status='cancelled' WHERE id=?").run(execId)
    db.prepare("UPDATE tasks SET status='running' WHERE id='d5b'").run()
    svc.tick()
    expect(tasks.getById("d5b")!.status).toBe("failed")
    // The slot is free — proven once a human re-enqueues (a one-shot task's run ending IS
    // its outcome; only a cron task returns to 已入队 by itself, see the cron test).
    db.prepare("UPDATE tasks SET status='ready' WHERE id='d5b'").run()
    expect(svc.armTask("d5b")).toBeTruthy()
  })

  it("finalize is idempotent — the callback and the tick can both arrive", async () => {
    insertTask("d6")
    const execId = svc.armAndLaunch("d6")
    await complete(execId, "completed")
    const first = events.filter((e) => String(e.event) === "task_execution").length
    svc.finalizeLaunch(execId, "completed")
    await new Promise((r) => setImmediate(r))
    expect(events.filter((e) => String(e.event) === "task_execution").length).toBe(first)
  })
})

describe("task-lifecycle — finalize resolves the way the executor used to", () => {
  it("goal-task-dev T6 parity: an engine 'completed' over zero completed nodes is a failure", async () => {
    // The rule the executor used to own (and the reason this file exists): onComplete
    // fires inside run(), BEFORE the lifecycle persists the final status, so a pure DB
    // read sees a stale 'running'. Trusting the engine then needs the allSkipped guard —
    // a run that completed nothing but skipped everything achieved nothing.
    insertTask("d7")
    const execId = svc.armAndLaunch("d7")
    const addNode = (id: string, status: string) =>
      db.prepare("INSERT INTO node_executions (id, execution_id, node_id, node_type, status) VALUES (?, ?, ?, 'agent', ?)")
        .run(`n-${id}`, execId, id, status)
    addNode("a", "skipped")
    addNode("b", "skipped")
    await complete(execId, "completed")
    expect(execs.findById(execId)!.status).toBe("failed")

    // And the guard's own boundary: zero node rows at all stays completed (the lifecycle
    // rule has a length>0 guard; without it an empty workflow would fail).
    insertTask("d8")
    const bare = svc.armAndLaunch("d8")
    await complete(bare, "completed")
    expect(execs.findById(bare)!.status).toBe("completed")
  })

  it("a completed_with_failures round counts as done for the card", async () => {
    insertTask("d9")
    const execId = svc.armAndLaunch("d9")
    await complete(execId, "completed_with_failures")
    expect(execs.findById(execId)!.status).toBe("completed_with_failures")
    expect(tasks.getById("d9")!.status).toBe("done")
  })

  it("an unknown engine status is never written verbatim onto the task", async () => {
    insertTask("d10")
    const execId = svc.armAndLaunch("d10")
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
describe("task-lifecycle — every red run carries its reason (票05)", () => {
  const reasonOn = (execId: string): unknown =>
    JSON.parse(execs.findById(execId)!.var_pool).error

  it("a reap stores why it reaped, on the row and in the event", () => {
    const execId = armRunning("r1")
    age(execId, 30)
    stub.live.delete(execId)
    const { reaped } = svc.reconcile()
    expect(reaped).toBe(1)
    expect(String(reasonOn(execId))).toContain("失去引擎进程")
    const ev = events.filter((e) => e.event === "task_execution").at(-1)
    expect(ev?.data).toMatchObject({ execution_id: execId, status: "aborted" })
    expect((ev?.data as Record<string, unknown>).reason).toContain("失去引擎进程")
  })

  it("a user abort says 用户中止, not nothing", () => {
    const execId = armRunning("r2")
    svc.abortTask("r2")
    expect(String(reasonOn(execId))).toBe("用户中止")
    // The row is not the whole story: the board reads task_execution, so an abort that
    // only writes the row leaves the card showing 'running' until the next poll — and
    // the poll has no reason to show, because only this event carries one.
    const ev = events.filter((e) => e.event === "task_execution").at(-1)
    expect(ev?.data).toMatchObject({ task_id: "r2", execution_id: execId, status: "aborted" })
    expect((ev?.data as Record<string, unknown>).reason).toBe("用户中止")
  })

  it("a queued abort announces the retirement too", () => {
    // 排队中 rows never started, so there is no engine event for them from anywhere else —
    // if this path stays silent the badge sits on 'pending' and the user has no idea their
    // 中止 landed.
    insertTask("r2b")
    const execId = svc.armTask("r2b")
    events.length = 0
    expect(svc.abortTask("r2b").retired).toEqual([execId])
    const ev = events.filter((e) => e.event === "task_execution")
    expect(ev).toHaveLength(1)
    expect((ev[0].data as Record<string, unknown>).reason).toContain("排队中")
    // Idempotence holds on the wire as well as in the table: a second abort is terminal
    // and emits nothing.
    events.length = 0
    svc.abortTask("r2b")
    expect(events.filter((e) => e.event === "task_execution")).toHaveLength(0)
  })

  it("an engine that refuses to start puts its message on the row", async () => {
    insertTask("r3")
    stub.failStart = true
    const execId = svc.armTask("r3")
    svc.launchQueued()
    await new Promise((r) => setImmediate(r))
    expect(execs.findById(execId)!.status).toBe("failed")
    expect(String(reasonOn(execId))).toContain("provider 挂了")
  })

  it("a run the engine failed with no stored reason lifts the failing node's error", async () => {
    const execId = armRunning("r4")
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
    const execId = armRunning("r5")
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
    const execId = armRunning("r6")
    db.prepare("UPDATE executions SET var_pool = ? WHERE id = ?")
      .run(JSON.stringify({ error: "上一轮遗留" }), execId)
    await complete(execId, "completed")
    expect(execs.findById(execId)!.status).toBe("completed")
    expect(JSON.parse(execs.findById(execId)!.var_pool).error).toBe("上一轮遗留")
  })
})

/** Arm + launch a task and return its live root execution (the shape a run has when it
 *  can be ended red). */
function armRunning(taskId: string): string {
  insertTask(taskId)
  const execId = svc.armAndLaunch(taskId)
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

describe("task-lifecycle — reconciliation (the orphan path, now task-side)", () => {
  function stranded(taskId: string, ageMinutes: number, status = "running") {
    insertTask(taskId)
    const execId = svc.armTask(taskId)
    db.prepare("UPDATE executions SET status=?, started_at=?, updated_at=? WHERE id=?")
      .run(status, new Date(Date.now() - ageMinutes * 60_000).toISOString(),
        new Date(Date.now() - ageMinutes * 60_000).toISOString(), execId)
    return execId
  }

  it("reaps a stale running row whose engine is gone", () => {
    const execId = stranded("e1", 30)
    const { reaped } = svc.reconcile()
    expect(reaped).toBe(1)
    expect(execs.findById(execId)!.status).toBe("aborted")
    expect(tasks.getById("e1")!.status).toBe("aborted")
  })

  it("leaves a young row alone — another tick may still be starting it", () => {
    const execId = stranded("e2", 1)
    expect(svc.reconcile().reaped).toBe(0)
    expect(execs.findById(execId)!.status).toBe("running")
  })

  it("leaves an alive engine alone", () => {
    const execId = stranded("e3", 30)
    stub.live.add(execId)
    expect(svc.reconcile().reaped).toBe(0)
  })

  it("never reaps a QUEUED row — waiting for a slot is the queue working", () => {
    insertTask("e4")
    const execId = svc.armTask("e4")
    db.prepare("UPDATE executions SET created_at=datetime('now','-90 minutes') WHERE id=?").run(execId)
    expect(svc.reconcile().reaped).toBe(0)
    expect(execs.findById(execId)!.status).toBe("pending")
  })

  it("resyncs a task whose row finished but whose status never mirrored (died callback)", () => {
    insertTask("e5")
    const execId = svc.armAndLaunch("e5")
    // Simulate the crash window: the execution row is terminal, tasks.status is stuck.
    db.prepare("UPDATE executions SET status='completed' WHERE id=?").run(execId)
    db.prepare("UPDATE tasks SET status='running' WHERE id='e5'").run()
    const { resynced } = svc.reconcile()
    expect(resynced).toBe(1)
    expect(tasks.getById("e5")!.status).toBe("done")
  })

  it("after a reap the slot is free — the task can be armed again", () => {
    stranded("e6", 30)
    svc.reconcile()
    db.prepare("UPDATE tasks SET status='ready' WHERE id='e6'").run()
    expect(() => svc.armTask("e6")).not.toThrow()
  })
})

// ── the tick: due-scan, cursor, suppression ──────────────────────────

describe("task-lifecycle — tick (what the cron cadence drives)", () => {
  it("arms a due once-task, launches it, and retires the cursor permanently", () => {
    insertTask("f1", { trigger_mode: "once", trigger_at: "2020-01-01T00:00:00.000Z", next_fire_at: "2020-01-01T00:00:00.000Z" })
    const m = svc.tick()
    expect(m.armed).toBe(1)
    expect(m.launched).toBe(1)
    const t = tasks.getById("f1")!
    expect(t.next_fire_at).toBeNull()
    expect(t.last_fired_at).not.toBeNull()
    // A second tick must not arm it again.
    expect(svc.tick().armed).toBe(0)
  })

  it("a cron task keeps firing, but only one round at a time", async () => {
    insertTask("f2", {
      trigger_mode: "cron", cron_expression: "* * * * *", cron_timezone: "UTC",
      next_fire_at: "2020-01-01T00:00:00.000Z",
    })
    const execId1 = svc.tick() && latestRoot("f2")!.id
    const t1 = tasks.getById("f2")!
    expect(t1.next_fire_at).not.toBeNull()
    expect(Date.parse(t1.next_fire_at!) > Date.now()).toBe(true)

    // Round 1 is live: an overdue cursor must not queue a second instance.
    db.prepare("UPDATE tasks SET next_fire_at='2020-01-01T00:00:00.000Z' WHERE id='f2'").run()
    expect(svc.tick().armed).toBe(0)
    expect(db.prepare("SELECT COUNT(*) c FROM executions WHERE task_id='f2'").get()).toEqual({ c: 1 })

    // Ending the round returns a periodic task to 已入队 with the cursor jumped ahead —
    // 完成 is not a state a scheduled task parks in, or the schedule would be dead.
    await complete(execId1, "completed")
    const after = tasks.getById("f2")!
    expect(after.status).toBe("ready")
    expect(Date.parse(after.next_fire_at!) > Date.now()).toBe(true)

    // Next occurrence due → a fresh instance, so this is a real repeating task.
    db.prepare("UPDATE tasks SET next_fire_at='2020-01-01T00:00:00.000Z' WHERE id='f2'").run()
    expect(svc.tick().armed).toBe(1)
    expect(db.prepare("SELECT COUNT(*) c FROM executions WHERE task_id='f2'").get()).toEqual({ c: 2 })
  })

  it("an arm that cannot happen (broken contract) retires the cursor and reports why", () => {
    insertV4Task("f3", { deleteSpec: true })
    db.prepare(
      "UPDATE tasks SET trigger_mode='once', trigger_at='2020-01-01T00:00:00.000Z', next_fire_at='2020-01-01T00:00:00.000Z' WHERE id='f3'",
    ).run()
    const m = svc.tick()
    expect(m.armed).toBe(0)
    expect(m.refused).toBe(1)
    expect(tasks.getById("f3")!.next_fire_at).toBeNull()
    const failed = events.find((e) => String(e.event) === TASK_TRIGGER_FAILED_EVENT)
    const payload = failed!.data as Record<string, unknown>
    expect(payload.reason).toContain("phase:1:spec-missing")
    // The payload is on the shared contract now (票05): a failure the board cannot parse
    // is a failure nobody sees, and this event has exactly one consumer-side schema.
    expect(taskTriggerFailedPayloadSchema.safeParse(payload).success).toBe(true)
    expect(payload.trigger_mode).toBe("once")
    expect(payload).not.toHaveProperty("action")
  })

  it("a manual task with no cursor is invisible to the tick", () => {
    insertTask("f4")
    expect(svc.tick().armed).toBe(0)
  })

  it("a disabled trigger is skipped even when due", () => {
    insertTask("f5", {
      trigger_mode: "once", trigger_at: "2020-01-01T00:00:00.000Z",
      next_fire_at: "2020-01-01T00:00:00.000Z", trigger_enabled: 0,
    })
    expect(svc.tick().armed).toBe(0)
  })

  it("the tick's own fire is not counted as work by the gate", () => {
    const run = new ScheduleRunDAO(db)
    insertTask("f6"); svc.armTask("f6")
    const before = run.countActiveWork()
    expect(before).toBe(0) // pending holds no compute slot
    svc.launchQueued()
    expect(run.countActiveWork()).toBe(1)
  })
})

// ── abort ────────────────────────────────────────────────────────────

describe("task-lifecycle — abort", () => {
  it("cancels a running instance through the engine", async () => {
    insertTask("g1")
    const execId = svc.armAndLaunch("g1")
    const { cancelled } = svc.abortTask("g1")
    expect(cancelled).toEqual([execId])
    expect(execs.findById(execId)!.status).toBe("aborted")
    expect(tasks.getById("g1")!.status).toBe("running") // the caller owns the task status
  })

  it("retires a queued instance without touching the engine", () => {
    insertTask("g2")
    const execId = svc.armTask("g2")
    const { retired, cancelled } = svc.abortTask("g2")
    expect(retired).toEqual([execId])
    expect(cancelled).toEqual([])
    expect(execs.findById(execId)!.status).toBe("aborted")
    // Queue retirement must not disturb a live sibling: nothing else is running here.
    expect(new ScheduleRunDAO(db).countActiveWork()).toBe(0)
  })

  it("an abort frees the slot and the queue drains in the same breath (票05)", async () => {
    // Contract §1c applies to a slot freed by 中止 as much as to one freed by a finished
    // run: otherwise a hand-stopped task leaves its successor waiting up to a cron minute.
    insertTask("g-drain-a")
    insertTask("g-drain-b")
    const a = svc.armAndLaunch("g-drain-a")
    // cap is 2 here; pin the meter just below it so B arms but cannot launch yet.
    const b = svc.armTask("g-drain-b")
    expect(execs.findById(b)!.status).toBe("pending")
    vi.spyOn(ScheduleRunDAO.prototype, "countActiveWork").mockReturnValue(2)
    expect(svc.launchQueued()).toEqual({ launched: 0, capped: true })
    vi.restoreAllMocks()

    svc.abortTask("g-drain-a")
    await new Promise((r) => setImmediate(r))
    expect(execs.findById(a)!.status).toBe("aborted")
    expect(JSON.parse(execs.findById(a)!.var_pool).error).toBe("用户中止")
    // The freed slot was used immediately — not on the next tick.
    expect(stub.started).toContain(b)
    expect(execs.findById(b)!.status).toBe("running")
  })

  it("aborting twice is a no-op, not an error", () => {
    insertTask("g3")
    svc.armTask("g3")
    expect(svc.abortTask("g3").retired).toHaveLength(1)
    const again = svc.abortTask("g3")
    expect(again.retired).toHaveLength(0)
    expect(again.cancelled).toHaveLength(0)
  })
})

// ── the boundary itself ──────────────────────────────────────────────

describe("task-lifecycle — the scheduler is not consulted", () => {
  it("arming writes nothing to any schedule table", () => {
    insertTask("h1")
    svc.armAndLaunch("h1")
    for (const table of ["schedules", "schedule_executions", "schedule_workspaces"]) {
      expect(db.prepare(`SELECT COUNT(*) c FROM ${table}`).get()).toEqual({ c: 0 })
    }
  })

  it("the history read model comes from executions, newest first", () => {
    insertTask("h2")
    const first = svc.armTask("h2")
    db.prepare("UPDATE executions SET status='completed', completed_at=datetime('now') WHERE id=?").run(first)
    const second = svc.armTask("h2", { triggeredBy: "manual" })
    const hist = svc.history("h2")
    expect(hist.map((r) => r.id)).toEqual([second, first])
  })
})
