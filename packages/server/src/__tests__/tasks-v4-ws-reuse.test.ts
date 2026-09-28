// packages/server/src/__tests__/tasks-v4-ws-reuse.test.ts
//
// task-phase-redesign ticket 05 — dispatchPhaseRound + same-task workspace reuse,
// rewritten onto ADR-0021 票03's data shape.
//
// What is under test is unchanged (K4/K12): one task has ONE workspace, a round
// never swaps it, a same-name collision is a loud error, and retention must never
// reclaim a task's ws. What changed is who does it: `WorkflowExecutor`'s
// requirement/v4 branches are gone, so the ws is prepared by the built-in
// task-lifecycle job (`prepareWorkspace`) on EVERY arm — first round and later
// rounds alike. Everything below therefore drives the real new path
// (`TasksService.dispatchPhaseRound` / `taskLifecycle.armTask`), not the executor.
//
//   AC1: first trigger → createFromSpec + tasks.workspace_id write-back +
//        workspaces.task_id + the row tagged (1,1); a later round → workspaces
//        count STILL 1 and the ws DIRECTORY survives untouched (marker + inode —
//        the anti-rmSync regression tripwire).
//   AC2: a second dispatch while one is live → explainable TaskStatusConflictError;
//        `ux_exec_task_active` itself is proven to be the structural gate (a raw
//        second live root for the same task throws SQLITE_CONSTRAINT).
//   AC3: same-name createFromSpec THROWS (was silent rmSync overwrite — 暗雷#3)
//        and existing contents survive.
//   AC4: retention can no longer reach a task workspace at all — it is not a
//        schedule_workspaces candidate (structural 豁免, K12), while a job's own
//        completed workspaces still get reclaimed.
//   ⑥: abortTask keeps tasks.workspace_id bound (round 打回现场不作废) — the next
//        round reuses the SAME ws, and abort cancels the live ENGINE execution
//        (the 2026-09-08 ordering regression: capture before the row mutation).
//
// E2E_WR_ data prefix; fs assertions all under mkdtemp tmp HOMEs (cleaned, and
// HOME/USERPROFILE are restored with `delete` — assigning undefined stringifies).

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest"
import type Database from "better-sqlite3"
import os from "os"
import path from "path"
import fs from "fs"
import { closeDb, initDb } from "../db/connection"
import {
  ExecutionDAO, ScheduleConfigDAO, ScheduleRunDAO, WorkspaceDAO,
} from "../db/dao"
import { SSEService } from "../services/sse"
import { WorkspaceService } from "../services/workspace"
import { WorkflowExecutor } from "../services/scheduler/executors/workflow-executor"
import { TasksService, TaskStatusConflictError } from "../services/tasks/tasks-service"
import { TaskHomeService } from "../services/tasks/task-home-service"
import { describePg, setupRegisteredPgSchema, type PgFixture } from "../db/pg/__tests__/dao-fixture"

const ORG = "e2e-wr"
const BATCH = "20260908"

// P1 B2：tasks 落 PG（每用例 truncate 隔离）；executions/workspaces/schedules 仍
// SQLite（beforeEach 重建 :memory:）。ux_exec_task_active 闩锁断言留在 SQLite 侧。
let pg: PgFixture | null = null

// ── ExecutionService registry stub ────────────────────────────────────
// service.create writes a REAL armed ('pending') root row, so the claim loop, the
// (phase, round) tags and ux_exec_task_active are the production ones.
const stubService = {
  create: vi.fn((workspaceId: string, input: Record<string, unknown>) => {
    const id = `e2e-wr-exec-${execSeq++}`
    mockHooks.db!
      .prepare(
        `INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name,
           status, input_values, var_pool, org, created_at, updated_at, task_id, phase_index, round_index)
         VALUES (?, ?, '0', 0, ?, ?, 'pending', ?, '{}', ?, datetime('now'), datetime('now'), ?, ?, ?)`,
      )
      .run(
        id, workspaceId, String(input.workflow_ref ?? ""), String(input.workflow_ref ?? ""),
        JSON.stringify(input.input_values ?? {}), ORG,
        input.task_id ?? null, input.phase_index ?? null, input.round_index ?? null,
      )
    return { id }
  }),
  start: vi.fn(async (id: string) => {
    mockHooks.db!.prepare("UPDATE executions SET status='running', started_at=datetime('now') WHERE id=?").run(id)
  }),
  cancel: vi.fn(async (id: string) => ({ id })),
  registerExternalCallbacks: vi.fn(),
  clearExternalCallbacks: vi.fn(),
  hasLiveEngine: () => false,
}
let execSeq = 0
const mockHooks: { db: Database.Database | null } = { db: null }

vi.mock("../services/execution-service-registry", () => ({
  getExecutionService: (wsId: string) => {
    const ws = mockHooks.db!
      .prepare("SELECT path FROM workspaces WHERE id = ?")
      .get(wsId) as { path: string } | undefined
    return ws ? { service: stubService, wsPath: ws.path } : undefined
  },
}))

// ── Fixture helpers ───────────────────────────────────────────────────

function newDb(): Database.Database {
  const db = initDb(":memory:")
  db.pragma("foreign_keys = ON")
  db.prepare(
    "INSERT OR IGNORE INTO scheduler_state (id, last_heartbeat) VALUES (1, datetime('now'))",
  ).run()
  return db
}

let seq = 0
let taskHome: TaskHomeService
// Module scope because the fixture helpers below are module-level functions —
// a `db` declared inside the describe() would not be visible to them.
let db: Database.Database

/** A v4 task with TWO phases whose batch spec.md files exist under the home —
 *  票03 re-checks the v4 contract at every arm (there is no frozen envelope copy
 *  to fall back on), so the home layout is part of the fixture, not optional.
 *  P1 B2: tasks 落 PG。 */
async function insertV4Task(status = "ready"): Promise<string> {
  const id = `e2e-wr-task-${seq++}`
  const now = new Date().toISOString()
  const phases = [1, 2].map((n) => ({
    index: n,
    name: `Phase ${n}`,
    slug: `p${n}`,
    specPath: path.join(".scratch", BATCH, `p${n}`, "spec.md"),
    workflowRef: `built-in/flow-p${n}`,
    inputValues: {},
  }))
  for (const p of phases) {
    const dir = path.join(taskHome.homePath(id), ".scratch", BATCH, `p${p.index}`)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "spec.md"), `# ${p.name}\n`)
  }
  await pg!.sql.unsafe(`
    INSERT INTO tasks (id, org, name, status, source_chat_session_id, task_spec,
      authoring_resources, resources, skills, project_ids, workflow_ref, version,
      deleted_at, created_at, updated_at, completed_at, workspace_id)
    VALUES ($1, $2, $3, $4, NULL, $5, '[]', '[]', '[]', '[]', NULL, 1, NULL, $6, $7, NULL, NULL)
  `, [id, ORG, `E2E_WR ${id}`, status, JSON.stringify({ format: "v4", task_type: "coding", phases }), now, now])
  return id
}

function wsCount(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) as c FROM workspaces").get() as { c: number }).c
}

/** 票03: the run's own row is the read model (no join through schedules). */
function latestRoot(db: Database.Database, taskId: string) {
  return new ExecutionDAO(db).findLatestTaskInstance(taskId)
}

/** Free the task's slot the way reality does: the round reached a terminal status
 *  and a human re-enqueued it (`readyTask` is draft-only, so the row is nudged).
 *  P1 B2: executions 仍 SQLite；tasks 状态改写落 PG。 */
async function endRoundAndRequeue(db: Database.Database, taskId: string, status = "completed"): Promise<void> {
  db.prepare("UPDATE executions SET status=?, completed_at=datetime('now') WHERE task_id=?")
    .run(status, taskId)
  await pg!.sql`UPDATE tasks SET status = 'ready' WHERE id = ${taskId}`
}

/** P1 B2 生产疑点：armNow（tasks-service.ts:2013）对 lifecycle.armAndLaunch 不 await
 *  （dispatchPhaseRound 同批加了 await，这里漏了）—— PG 化之后 arm 链真异步，
 *  triggerTask 返回时 ws 绑定/实例行还没落地。测试侧先等链收敛再继续断言
 *  （语义不变：「触发 ⇒ 首建绑定 + 起一行实例」仍是断言目标，只是读点挪到收敛后）。 */
async function drainArmChain(taskId: string): Promise<void> {
  await vi.waitFor(async () => {
    const t = ((await pg!.sql`SELECT workspace_id, status FROM tasks WHERE id = ${taskId}`)[0]) as
      { workspace_id: string | null; status: string }
    expect(t.workspace_id).toBeTruthy()
    expect(t.status).toBe("running")
  }, { timeout: 5_000 })
}

describePg("ticket 05 (票03 形状) — v4 workspace reuse + dispatchPhaseRound", () => {
  let fakeHome: string
  let realHome: string | undefined
  let realUserProfile: string | undefined
  let workspaceService: WorkspaceService
  let executor: WorkflowExecutor
  let sse: SSEService
  let service: TasksService

  beforeAll(async () => {
    // P1 B2: PG 随机测试库每文件一座、注册为全局池（service/job 内部 pgSql() 取用）。
    pg = await setupRegisteredPgSchema()
  })

  afterAll(async () => {
    await pg?.close()
    pg = null
  })

  beforeEach(async () => {
    await pg!.truncate("tasks", "task_phase_acceptances")
    db = newDb()
    mockHooks.db = db
    // 不重置 seq/execSeq：id 每用例全局唯一，杜绝「上一用例残留的异步写」
    // 别名命中本用例刚重新插入的同 id 行（PG 跨用例不 close，泄漏只可能来自这里）。
    vi.clearAllMocks()
    realHome = process.env.HOME
    realUserProfile = process.env.USERPROFILE
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-wr-home-"))
    // Fake BOTH env vars: os.homedir() reads $HOME on POSIX but %USERPROFILE%
    // on Windows — without the latter the REAL user home was used here, the
    // root cause of the Windows baseline-red (colon ENOENT + same-second name
    // collisions against the real workspaces dir).
    process.env.HOME = fakeHome
    process.env.USERPROFILE = fakeHome
    sse = new SSEService()
    taskHome = new TaskHomeService(path.join(fakeHome, ".octopus"))
    workspaceService = new WorkspaceService(new WorkspaceDAO(db))
    // The executor stays only for AC4 (retention is still the pump's own job —
    // 票03 removed its task branches, not its workspace lifecycle).
    executor = new WorkflowExecutor(
      sse,
      new ScheduleConfigDAO(db),
      new ScheduleRunDAO(db),
      new ExecutionDAO(db),
      workspaceService,
    )
    const builtIn = {
      get: (ref: string) => ({ ref, content: "name: demo\nnodes: []\n", name: "demo" }),
    } as never
    service = new TasksService(
      db, sse, undefined, taskHome, undefined, builtIn, null, workspaceService,
    )
  })

  afterEach(async () => {
    // startRow 里 `service.start(...)` 是 fire-and-forget（生产代码，不动）：
    // 让它的 microtask 在关库前落地，避免对已 close 的 sqlite 句柄操作。
    await new Promise((r) => setTimeout(r, 0))
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    if (realUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = realUserProfile
    fs.rmSync(fakeHome, { recursive: true, force: true })
    closeDb()
  })

  // ── AC3 — same-name dir is an ERROR, not a silent rmSync rebuild ─────
  describe("AC3: createFromSpec same-name conflict", () => {
    function specInput(name: string) {
      return {
        org: ORG,
        name,
        projects: [],
        branch_prefix: "taskpool-x",
        branch_suffix: "bs1",
        source: "scheduler" as const,
        source_schedule_id: "s-conflict",
        workflow_chain: [],
      }
    }

    it("throws on an existing same-name dir and PRESERVES its contents", () => {
      const ws = workspaceService.createFromSpec(specInput("task:dup-0902-010000"))
      const marker = path.join(ws.path, "fix-feedback-r1.md")
      fs.writeFileSync(marker, "round-1 evidence")

      expect(() => workspaceService.createFromSpec(specInput("task:dup-0902-010000"))).toThrow(
        /already exists/i,
      )
      // The old rmSync path would have wiped this file.
      expect(fs.readFileSync(marker, "utf-8")).toBe("round-1 evidence")
      // No second DB row for the refused creation.
      expect(wsCount(db)).toBe(1)
    })
  })

  // ── AC1 — first arm creates+binds+tags; a later round reuses ──────────
  describe("AC1: 首建绑定 / 后续轮复用（job 的 prepareWorkspace）", () => {
    it("first trigger: createFromSpec + tasks.workspace_id write-back + workspaces.task_id + 行标 (1,1)", async () => {
      const taskId = await insertV4Task()
      const spy = vi.spyOn(workspaceService, "createFromSpec")

      await service.triggerTask(taskId)
      await drainArmChain(taskId)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(wsCount(db)).toBe(1)

      // tasks.workspace_id binding (系统事件写法 — version 不 bump). P1 B2: 读 PG。
      const task = ((await pg!.sql`SELECT workspace_id, version::int AS version FROM tasks WHERE id = ${taskId}`)[0]) as
        { workspace_id: string | null; version: number }
      expect(task.workspace_id).toBeTruthy()
      expect(task.version).toBe(1)

      // ws 名 = task-{ASCII core}-{MMDD-HHmmss}（首建拼名；禁中文命名 2026-09-20，
      // 标题剥成合法英文名），目录真实落盘。
      const ws = db.prepare("SELECT name, path, task_id, source FROM workspaces WHERE id = ?").get(task.workspace_id!) as
        { name: string; path: string; task_id: string | null; source: string }
      expect(ws.name).toMatch(/^task-E2E_WR.+-\d{4}-\d{6}$/)
      // v41 反向指针：「这个工作区属于哪个任务」是一次列读，不是 origin_id 反查桥。
      expect(ws.task_id).toBe(taskId)
      expect(ws.source).toBe("task")
      expect(fs.existsSync(ws.path)).toBe(true)
      expect(ws.path.startsWith(fakeHome)).toBe(true)

      // 首执行打标 (1,1)，且它就是这一行本身。
      const exec = latestRoot(db, taskId)
      expect(exec).toBeDefined()
      expect(exec!.phase_index).toBe(1)
      expect(exec!.round_index).toBe(1)
      expect(exec!.status).toBe("running")
      expect(exec!.workspace_id).toBe(task.workspace_id)
      spy.mockRestore()
    })

    it("re-claim with tasks.workspace_id set: NO second createFromSpec — same ws dir, round 2 tags (1,2)", async () => {
      const taskId = await insertV4Task()
      await service.triggerTask(taskId)
      await drainArmChain(taskId)
      const boundId = ((await pg!.sql`SELECT workspace_id FROM tasks WHERE id = ${taskId}`)[0] as
        { workspace_id: string }).workspace_id!
      const wsPath = (db.prepare("SELECT path FROM workspaces WHERE id = ?").get(boundId) as
        { path: string }).path

      // A marker file + the dir inode — the rmSync-regression tripwire.
      const marker = path.join(wsPath, "round1-report.md")
      fs.writeFileSync(marker, "phase 1 evidence")
      const inoBefore = fs.statSync(wsPath).ino

      await endRoundAndRequeue(db, taskId)
      const spy = vi.spyOn(workspaceService, "createFromSpec")
      const execId = await service.taskLifecycle.armTask(taskId, { phaseIndex: 1, roundIndex: 2 })
      expect(spy).not.toHaveBeenCalled()
      expect(wsCount(db)).toBe(1)
      // 目录未被重建 — 同 inode、marker 存活。
      expect(fs.statSync(wsPath).ino).toBe(inoBefore)
      expect(fs.readFileSync(marker, "utf-8")).toBe("phase 1 evidence")
      // 复用执行仍绑同一 ws，轮次坐标由调用方给（旧版靠 executor 自增信封游标）。
      const row = new ExecutionDAO(db).findById(execId)!
      expect(row.workspace_id).toBe(boundId)
      expect(row.phase_index).toBe(1)
      expect(row.round_index).toBe(2)
      spy.mockRestore()
    })

    it("复用不换绑：绑定行被带外改成不存在的 ws 时，arm 明确拒绝而不是悄悄建第二个", async () => {
      const taskId = await insertV4Task()
      await service.triggerTask(taskId)
      await drainArmChain(taskId)
      const boundId = ((await pg!.sql`SELECT workspace_id FROM tasks WHERE id = ${taskId}`)[0] as
        { workspace_id: string }).workspace_id
      expect(boundId).toBeTruthy()
      await endRoundAndRequeue(db, taskId)
      // 带外改写绑定（≙ 旧数据 / 手工清库）：绑定指向查无此行的 ws。
      await pg!.sql`UPDATE tasks SET workspace_id = 'ws-gone' WHERE id = ${taskId}`

      let message = "<no throw>"
      try {
        await service.taskLifecycle.armTask(taskId)
      } catch (err: unknown) {
        message = (err as Error).message
      }
      // 复用优先于新建（K4 一 task 一 ws）：坏绑定必须响，不能静默换绑第二个 ws。
      expect(message).toMatch(/不可用|预建工作区失败/)
      expect((db.prepare("SELECT COUNT(*) c FROM workspaces WHERE id=?").get(boundId) as { c: number }).c).toBe(1)
    })
  })

  // ── AC1 (part 2) + AC2 — dispatchPhaseRound on the bound ws ──────────
  describe("AC1/AC2: dispatchPhaseRound — 同一 ws、同一任务、按轮打标", () => {
    it("dispatches phase 2 on the BOUND ws: ws count=1, dir untouched, row tagged (2,1)", async () => {
      const taskId = await insertV4Task()
      await service.triggerTask(taskId) // phase 1 round 1
      await drainArmChain(taskId)
      await endRoundAndRequeue(db, taskId)
      const boundWsId = ((await pg!.sql`SELECT workspace_id FROM tasks WHERE id = ${taskId}`)[0] as
        { workspace_id: string }).workspace_id!
      const wsPath = (db.prepare("SELECT path FROM workspaces WHERE id=?").get(boundWsId) as
        { path: string }).path
      const marker = path.join(wsPath, "phase1-report.md")
      fs.writeFileSync(marker, "keep me")
      const inoBefore = fs.statSync(wsPath).ino
      const spy = vi.spyOn(workspaceService, "createFromSpec")

      const res = await service.dispatchPhaseRound(taskId, 2, 1, "fix the login redirect")

      expect(res.workspaceId).toBe(boundWsId)
      expect(spy).not.toHaveBeenCalled()
      expect(wsCount(db)).toBe(1)
      expect(fs.statSync(wsPath).ino).toBe(inoBefore)
      expect(fs.readFileSync(marker, "utf-8")).toBe("keep me")

      // service.create ran on the BOUND ws with the phase-2 ref + feedback +
      // recovery stamps (management keys).
      const createCall = stubService.create.mock.calls.at(-1)!
      expect(createCall[0]).toBe(boundWsId)
      const iv = createCall[1].input_values as Record<string, string>
      expect(createCall[1].workflow_ref).toBe("built-in/flow-p2")
      expect(iv.feedback).toBe("fix the login redirect")
      expect(iv._phase_index).toBe("2")
      expect(iv._round_index).toBe("1")
      // 票03: 轮次坐标长在行上 —— 不再改写任何定义（旧版这里读信封 chain[0]）。
      expect(createCall[1].task_id).toBe(taskId)
      expect(createCall[1].phase_index).toBe(2)
      expect(createCall[1].round_index).toBe(1)

      const exec = latestRoot(db, taskId)
      expect(exec).toBeDefined()
      expect(exec!.phase_index).toBe(2)
      expect(exec!.round_index).toBe(1)
      expect(exec!.workspace_id).toBe(boundWsId)
      expect(res.executionId).toBe(exec!.id)
      // schedule 三张表全程零行。
      for (const t of ["schedules", "schedule_executions", "schedule_workspaces"]) {
        expect(db.prepare(`SELECT COUNT(*) c FROM ${t}`).get()).toEqual({ c: 0 })
      }
      spy.mockRestore()
    })

    it("AC2: concurrent second dispatch → explainable conflict; ux_exec_task_active itself rejects the raw insert too", async () => {
      const taskId = await insertV4Task()
      await service.taskLifecycle.armTask(taskId) // live (armed) root on the bound ws
      const boundWsId = ((await pg!.sql`SELECT workspace_id FROM tasks WHERE id = ${taskId}`)[0] as
        { workspace_id: string }).workspace_id!

      // Still live — a parallel second dispatch must be refused by the latch, not
      // silently queued behind it (卡片还是 ready，所以挡下它的只可能是闩锁)。
      await expect(service.dispatchPhaseRound(taskId, 2, 1)).rejects.toThrow(TaskStatusConflictError)
      await expect(service.dispatchPhaseRound(taskId, 2, 1)).rejects.toThrow(/已有进行中的实例/)
      expect(wsCount(db)).toBe(1)
      // No row leaked from the refused attempts.
      expect((db.prepare("SELECT COUNT(*) c FROM executions WHERE task_id=?").get(taskId) as { c: number }).c).toBe(1)

      // The structural backstop: ux_exec_task_active (partial UNIQUE over the root,
      // predicate = 非终态) — a raw second live root collides, even bypassing armTask.
      expect(() =>
        db
          .prepare(
            `INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name,
               status, org, created_at, updated_at, task_id)
             VALUES ('e2e-wr-raw', ?, '0', 'w', 'w', 'pending', ?, datetime('now'), datetime('now'), ?)`,
          )
          .run(boundWsId, ORG, taskId),
      ).toThrow(/UNIQUE/)
      // ...and a TERMINAL one does not (that is how a finished round releases the slot).
      db.prepare("UPDATE executions SET status='completed' WHERE task_id=?").run(taskId)
      expect(() =>
        db
          .prepare(
            `INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name,
               status, org, created_at, updated_at, task_id)
             VALUES ('e2e-wr-raw2', ?, '0', 'w', 'w', 'pending', ?, datetime('now'), datetime('now'), ?)`,
          )
          .run(boundWsId, ORG, taskId),
      ).not.toThrow()
    })

    // 信封时代由 dispatchPhaseRound 明确抛「phase N 不在 phases[]」；票03 之后 phase
    // 从 task_spec 现推，resolveTaskLaunchStep 找不到时会**静默落回通用链**（跑 phase 1
    // 且不打轮次标 —— 那条行会永久占住闩锁，derive 与账本又看不见它）。所以 armTask
    // 必须在解析步骤之前先校验 phase index，这条就是钉住那个前置校验。
    it("guards: 未知 phase index → 明确拒绝（不许静默跑 phase 1 且不带轮次标）", async () => {
      const taskId = await insertV4Task()
      let message = "<no throw>"
      try {
        await service.dispatchPhaseRound(taskId, 3, 1)
      } catch (err: unknown) {
        message = (err as Error).message
      }
      expect(message).toMatch(/phase 3/)
      // 而且不能留下一行未打标活实例（那会占死这个任务的槽位）。
      expect(latestRoot(db, taskId)).toBeNull()
    })
  })

  // ── AC4 — a task workspace is out of retention's reach ────────────────
  describe("AC4: retention 够不到任务 ws（K12 由结构保证）", () => {
    function seedSchedulerWs(id: string, name: string): string {
      const p = path.join(fakeHome, ".octopus", "orgs", ORG, "workspaces", name)
      fs.mkdirSync(p, { recursive: true })
      db.prepare(
        "INSERT INTO workspaces (id, name, org, path, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'scheduler', 'active', datetime('now'), datetime('now'))",
      ).run(id, name, ORG, p)
      return p
    }
    function seedCompletedAssoc(scheduleId: string, wsId: string): void {
      db.prepare(
        "INSERT INTO schedule_workspaces (id, schedule_id, workspace_id, status, branch_suffix, started_at) VALUES (?, ?, ?, 'completed', 'bs', datetime('now'))",
      ).run(`sws-${wsId}-${seq++}`, scheduleId, wsId)
    }
    function wsExists(id: string): boolean {
      return !!db.prepare("SELECT id FROM workspaces WHERE id = ?").get(id)
    }

    it("作业自己的 completed ws 照常回收；任务 ws 从来不是候选", async () => {
      const taskId = await insertV4Task()
      // NOTE: name doubles as the dir name here (test seeds the fs directly) —
      // no `:` (illegal on Windows); the retention logic keys off the DB row.
      seedSchedulerWs("ws-free-a", "taskpool-free-a")
      seedSchedulerWs("ws-free-b", "taskpool-free-b")
      const now = new Date().toISOString()
      db.prepare(
        `INSERT INTO schedules (id, org, name, cron_expression, timezone, enabled, job_type,
           config, created_at, updated_at, status)
         VALUES ('s-job', ?, 'S-job', '* * * * *', 'UTC', 1, 'workflow', '{}', ?, ?, 'queued')`,
      ).run(ORG, now, now)
      seedCompletedAssoc("s-job", "ws-free-a")
      seedCompletedAssoc("s-job", "ws-free-b")

      // 任务 ws 走真实首建路径 ⇒ 它带 task_id，且**不在** schedule_workspaces 里。
      await service.triggerTask(taskId)
      await drainArmChain(taskId)
      const taskWsId = ((await pg!.sql`SELECT workspace_id FROM tasks WHERE id = ${taskId}`)[0] as
        { workspace_id: string }).workspace_id
      expect(
        db.prepare("SELECT COUNT(*) c FROM schedule_workspaces WHERE workspace_id=?").get(taskWsId),
      ).toEqual({ c: 0 })

      // maxRetain=0 → every completed association is an eviction candidate.
      ;(executor as unknown as { enforceRetention(id: string, max: number): void }).enforceRetention("s-job", 0)

      expect(wsExists("ws-free-a")).toBe(false) // job ws → reclaimed
      expect(wsExists("ws-free-b")).toBe(false)
      expect(wsExists(taskWsId)).toBe(true) // 任务 ws：结构上不在候选集里（K12）
    })
  })

  // ── ⑥ — abort keeps the scene: binding + ws survive, next round reuses ──
  describe("⑥ abortTask × ws reuse semantics", () => {
    it("abort releases the latch but KEEPS the binding; the next round runs on the same ws", async () => {
      const taskId = await insertV4Task()
      await service.dispatchPhaseRound(taskId, 1, 1)
      const boundWsId = ((await pg!.sql`SELECT workspace_id FROM tasks WHERE id = ${taskId}`)[0] as
        { workspace_id: string }).workspace_id!
      const wsPath = (db.prepare("SELECT path FROM workspaces WHERE id=?").get(boundWsId) as
        { path: string }).path
      const marker = path.join(wsPath, "half-done-work.md")
      fs.writeFileSync(marker, "round scene")

      await service.abortTask(taskId)

      // Binding + ws row + files SURVIVE the abort (round 打回现场不作废).
      const task = ((await pg!.sql`SELECT workspace_id, status FROM tasks WHERE id = ${taskId}`)[0]) as
        { workspace_id: string | null; status: string }
      expect(task.workspace_id).toBe(boundWsId)
      expect(task.status).toBe("aborted")
      expect(fs.readFileSync(marker, "utf-8")).toBe("round scene")
      // The instance row is terminal ⇒ the latch let go; nothing lives in schedules.
      expect(latestRoot(db, taskId)!.status).toBe("aborted")
      expect((db.prepare("SELECT COUNT(*) c FROM schedules").get() as { c: number }).c).toBe(0)

      // And the mechanism-level promise: a fresh round reuses the SAME ws (人重新入队)。
      await pg!.sql`UPDATE tasks SET status = 'ready' WHERE id = ${taskId}`
      const res = await service.dispatchPhaseRound(taskId, 2, 1)
      expect(res.workspaceId).toBe(boundWsId)
      expect(wsCount(db)).toBe(1)
      expect(fs.readFileSync(marker, "utf-8")).toBe("round scene")
    })

    // Regression (2026-09-08): the row used to be flipped to a terminal status
    // BEFORE the engine-cancel lookup — and the lookup queried exactly the live
    // statuses — so the engine execution was never cancelled and kept burning
    // tokens until stopped by hand. Capture must happen BEFORE the mutation.
    it("abortTask cancels the IN-FLIGHT engine execution, not just the DB row", async () => {
      const taskId = await insertV4Task()
      await service.dispatchPhaseRound(taskId, 1, 1)
      const live = latestRoot(db, taskId)!
      expect(live.status).toBe("running")
      stubService.cancel.mockClear()

      await service.abortTask(taskId)
      await new Promise((r) => setImmediate(r))

      expect(stubService.cancel).toHaveBeenCalledWith(live.id)
      expect(db.prepare("SELECT status FROM executions WHERE id=?").get(live.id)).toEqual({
        status: "aborted",
      })
    })

    it("abort of a QUEUED (pending) instance retires the row without touching the engine", async () => {
      const taskId = await insertV4Task()
      const execId = await service.taskLifecycle.armTask(taskId) // armed, not started
      stubService.cancel.mockClear()

      const { cancelled, retired } = await service.taskLifecycle.abortTask(taskId)
      expect(retired).toEqual([execId])
      expect(cancelled).toEqual([])
      expect(stubService.cancel).not.toHaveBeenCalled()
      expect(new ExecutionDAO(db).findById(execId)!.status).toBe("aborted")
    })
  })
})
