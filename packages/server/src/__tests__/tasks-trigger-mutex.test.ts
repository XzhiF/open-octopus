// packages/server/src/__tests__/tasks-trigger-mutex.test.ts
//
// ADR-0021 票03 — 人工触发 / 单次定时 / 同任务互斥，写在「任务自持 WHEN」的新形状上。
//
// 本文件是票03 的**硬闸**文件。旧版用「信封行状态机」证明一任务一实例：readyTask 停一行
// draft 信封、trigger 翻 queued、poller 领成 claimed，互斥由 ~10 处守卫 + 借
// schedule_executions 的 partial UNIQUE 共同维持。票03 之后同一件事只剩一个来源：
// `ux_exec_task_active` —— executions 根行上的 partial UNIQUE，谓词 = 非终态。所以这里
// 必须仍然证明：
//   (a) 同一任务并发触发只起**一个**活实例；
//   (b) 已排队(armed / status='pending'，等不到并发闸)的实例同样挡住第二次领取；
//   (c) 行进终态即释放槽位（人能重新入队再跑一轮）；
//   (d) 两个不同任务互不影响（闸是共享的，槽是各自的）。
// 外加 trigger / cancelTrigger / reopen 三个动词的新语义（§2/§3/§6）与 routes 层
// 400/409/200 的映射。
//
// 刻意 stub 的两个面（与 services/tasks/__tests__/task-lifecycle.test.ts 同款）：
//   - ExecutionService registry：真引擎要 git + provider；stub 写**真实 executions 行**，
//     于是闩锁是真索引在序列化，不是 mock 在被说服。start() 被记录，双启动可观测。
//   - 并发闸：钉成 2 而不是读 env —— 测的是「job 尊重闸」，不是闸的数字。
//
// Anti-fake-run: 真 better-sqlite3 + applySchema + 真 Hono request，响应 ↔ DB 交叉核对，
// E2E_TTM_ 前缀。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { AgentSessionDAO, ExecutionDAO } from "../db/dao"
import { SSEService } from "../services/sse"
import { TasksService, TaskStatusConflictError } from "../services/tasks/tasks-service"
import { TaskLifecycleError } from "../services/tasks/task-lifecycle-service"
import { createTasksRoutes } from "../routes/tasks"
import {
  TASK_STATUS_EVENT,
  TASK_TRIGGER_EVENT,
  TERMINAL_EXECUTION_STATUSES,
} from "@octopus/shared"

const ORG = "e2e-ttm"
const NOT_TERMINAL_PLACEHOLDERS = TERMINAL_EXECUTION_STATUSES.map(() => "?").join(",")

// ── Seams ────────────────────────────────────────────────────────────
const stub = vi.hoisted(() => ({
  started: [] as string[],
  live: new Set<string>(),
  callbacks: new Map<string, (status?: string) => void>(),
  seq: 0,
  db: null as Database.Database | null,
}))

vi.mock("../services/execution-service-registry", () => ({
  getExecutionService: (wsId: string) => {
    const ws = stub.db!
      .prepare("SELECT path FROM workspaces WHERE id = ?")
      .get(wsId) as { path: string } | undefined
    if (!ws) return undefined
    return {
      wsPath: ws.path,
      service: {
        create: (_workspaceId: string, input: Record<string, unknown>) => {
          // A real INSERT: task_id + ux_exec_task_active behave exactly as in production.
          const id = `ttm-exec-${stub.seq++}`
          stub.db!
            .prepare(
              `INSERT INTO executions
                 (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name, status,
                  input_values, var_pool, org, created_at, updated_at, triggered_by,
                  task_id, phase_index, round_index)
               VALUES (?, ?, '0', 0, ?, ?, 'pending', ?, ?, ?, datetime('now'), datetime('now'), ?, ?, ?, ?)`,
            )
            .run(
              id, _workspaceId, String(input.workflow_ref ?? ""), String(input.workflow_ref ?? ""),
              JSON.stringify(input.input_values ?? {}), JSON.stringify(input.initial_var_pool ?? {}),
              ORG, String(input.triggered_by ?? ""),
              input.task_id ?? null, input.phase_index ?? null, input.round_index ?? null,
            )
          return { id }
        },
        start: async (id: string) => {
          stub.started.push(id)
          stub.live.add(id)
          stub.db!
            .prepare("UPDATE executions SET status='running', started_at=datetime('now') WHERE id=?")
            .run(id)
        },
        registerExternalCallbacks: (cbs: { onComplete?: (s?: string) => void }, id: string) => {
          if (cbs.onComplete) stub.callbacks.set(id, cbs.onComplete as (s?: string) => void)
        },
        clearExternalCallbacks: (id: string) => {
          stub.callbacks.delete(id)
          stub.live.delete(id)
        },
        cancel: (id: string) => {
          stub.live.delete(id)
          return { id }
        },
        hasLiveEngine: (id: string) => stub.live.has(id),
      },
    }
  },
}))

vi.mock("../services/scheduler/concurrency", () => ({
  MAX_PARALLEL_WORKSPACES: 2,
  MAX_AGENT_CONCURRENCY: 10,
  STALE_CLAIMED_THRESHOLD_MS: 600_000,
}))

// ── Fixtures ─────────────────────────────────────────────────────────
let db: Database.Database
let sse: SSEService
let service: TasksService
let execs: ExecutionDAO
let app: Hono
let wsDir: string
let wsSeq = 0
let events: Array<Record<string, unknown>>

function newDb(): Database.Database {
  const d = new Database(":memory:")
  d.pragma("foreign_keys = ON")
  applySchema(d)
  d.prepare(
    "INSERT OR IGNORE INTO scheduler_state (id, last_heartbeat) VALUES (1, datetime('now'))",
  ).run()
  return d
}

/** A legacy (no task_type / no format) task: the ready gate is vacuous, the launch plan
 *  is just `tasks.workflow_ref`, so arming needs no task home and no built-in registry. */
function makeTaskRow(
  overrides: Partial<{ id: string; status: string; workflow_ref: string | null }> = {},
): string {
  const id = overrides.id ?? `e2e-ttm-${Math.random().toString(36).slice(2, 8)}`
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO tasks (id, org, name, status, source_chat_session_id, task_spec,
      authoring_resources, resources, skills, project_ids, workflow_ref, version,
      deleted_at, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, NULL, ?, '[]', '[]', '[]', '[]', ?, 1, NULL, ?, ?, NULL)`,
  ).run(
    id, ORG, `E2E_TTM ${id}`, overrides.status ?? "draft",
    JSON.stringify({ goal: "g", ac: ["a"] }),
    overrides.workflow_ref === undefined ? "built-in/w" : overrides.workflow_ref,
    now, now,
  )
  return id
}

/** Structural fake of WorkspaceService (only what prepareWorkspace touches). Typed as
 *  never so a future call to a real method fails here rather than returning undefined. */
function fakeWorkspaceService() {
  return {
    getById: (id: string) =>
      (db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as never) ?? undefined,
    ensureWorktreesForReuse: () => ({ rebuilt: [] }),
    createFromSpec: (input: Record<string, unknown>) => {
      const id = `ttm-ws-${wsSeq++}`
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

function insertJobFire(fireId: string, scheduleId: string, status = "running"): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO schedules (id, org, name, cron_expression, timezone, enabled, job_type,
       config, created_at, updated_at)
     VALUES (?, ?, ?, '* * * * *', 'UTC', 1, 'workflow', '{}', ?, ?)`,
  ).run(scheduleId, ORG, `S-${scheduleId}`, now, now)
  db.prepare(
    `INSERT INTO schedule_executions (id, schedule_id, status, trigger_type, triggered_at,
       timezone_offset, timezone_iana, created_at, triggered_by)
     VALUES (?, ?, ?, 'scheduled', datetime('now'), '+00:00', 'UTC', datetime('now'), 'scheduler')`,
  ).run(fireId, scheduleId, status)
}

function liveInstances(taskId: string): number {
  return (
    db.prepare(
      `SELECT COUNT(*) c FROM executions
        WHERE task_id = ? AND parent_id = '0' AND status NOT IN (${NOT_TERMINAL_PLACEHOLDERS})`,
    ).get(taskId, ...TERMINAL_EXECUTION_STATUSES) as { c: number }
  ).c
}

function rowsOf(taskId: string) {
  return db
    .prepare("SELECT id, status, workflow_ref, triggered_by FROM executions WHERE task_id = ? ORDER BY rowid")
    .all(taskId) as Array<{ id: string; status: string; workflow_ref: string; triggered_by: string }>
}

function scheduleRowCount(): number {
  return (db.prepare("SELECT COUNT(*) c FROM schedules").get() as { c: number }).c
}

beforeEach(() => {
  db = newDb()
  stub.db = db
  stub.started = []
  stub.live = new Set()
  stub.callbacks = new Map()
  stub.seq = 0
  wsSeq = 0
  events = []
  execs = new ExecutionDAO(db)
  wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttm-ws-"))
  sse = new SSEService()
  sse.subscribe("taskpool", (e) => events.push(e as Record<string, unknown>))
  service = new TasksService(
    db, sse, new AgentSessionDAO(db), undefined, undefined, null, null,
    fakeWorkspaceService() as never,
  )
  app = new Hono()
  app.route("/api/tasks", createTasksRoutes(service, sse))
})

afterEach(() => {
  fs.rmSync(wsDir, { recursive: true, force: true })
  db.close()
})

// ── 1. enqueue ───────────────────────────────────────────────────────
describe("票03 §1 — 入队不再停放信封", () => {
  it("readyTask = gate + draft→ready，任何 schedule 表都不写一行", () => {
    const id = makeTaskRow()
    const dto = service.readyTask(id)
    expect(dto.status).toBe("ready")
    for (const table of ["schedules", "schedule_executions", "schedule_workspaces"]) {
      expect(db.prepare(`SELECT COUNT(*) c FROM ${table}`).get()).toEqual({ c: 0 })
    }
    // 没有实例，也没有到点游标 —— 入队只声明了「可以跑」，没声明「何时跑」。
    expect(db.prepare("SELECT COUNT(*) c FROM executions").get()).toEqual({ c: 0 })
    expect(dto.next_fire_at).toBeNull()
  })

  it("重复入队仍拒（ready 不是 draft）；活实例存在时入队与否由 currentInstance 决定", () => {
    const id = makeTaskRow()
    service.readyTask(id)
    expect(() => service.readyTask(id)).toThrow(/only draft→ready/)
  })
})

// ── 2. 立即触发 = 当场建实例并领取 ───────────────────────────────────
describe("票03 §2 — triggerTask(立即)", () => {
  it("建工作区 + 插 executions(pending) + 在闸内 start；任务 running；零 schedule 行", async () => {
    const id = makeTaskRow()
    service.readyTask(id)
    const before = Date.now()

    const dto = await service.triggerTask(id)
    expect(dto.status).toBe("running")

    const root = execs.findLatestTaskRoot(id)!
    expect(root.status).toBe("running")
    expect(root.parent_id).toBe("0")
    expect(root.workflow_ref).toBe("built-in/w")
    expect(root.triggered_by).toBe("manual")
    expect(stub.started).toEqual([root.id])
    // 一次运行 = 一行 execution，不再经信封 + schedule_executions 两跳。
    expect(rowsOf(id)).toHaveLength(1)
    expect(scheduleRowCount()).toBe(0)
    // 工作区属于任务（workspaces.task_id 直连，反查不再走 origin_id 桥）。
    expect(db.prepare("SELECT task_id FROM workspaces WHERE id = ?").get(root.workspace_id)).toEqual({
      task_id: id,
    })
    expect(dto.execution).toMatchObject({ id: root.id, status: "running" })

    const evs = events.map((e) => `${e.event}:${(e.data as { status?: string }).status ?? ""}`)
    expect(evs).toContain(`task_execution:pending`)
    expect(evs).toContain(`task_execution:running`)
    expect(
      events.some((e) => e.event === TASK_STATUS_EVENT && (e.data as { status: string }).status === "running"),
    ).toBe(true)
    expect(Date.now() - before).toBeLessThan(5000)
  })

  it("排队中(pending)与执行中(running)是两种事实：闸满时行留 pending，卡片不再谎报执行中", async () => {
    // 两个 cron 作业 fire 占满 cap=2 → 领取必须原地排队。
    insertJobFire("f-1", "s-1")
    insertJobFire("f-2", "s-2")
    const id = makeTaskRow()
    service.readyTask(id)
    await service.triggerTask(id)

    const root = execs.findLatestTaskRoot(id)!
    expect(root.status).toBe("pending")
    expect(db.prepare("SELECT status FROM tasks WHERE id=?").get(id)).toEqual({ status: "ready" })
    expect(stub.started).toEqual([])
  })
})

// ── 3. 同任务互斥（硬闸 a/b/c/d）─────────────────────────────────────
describe("票03 — 同任务互斥：ux_exec_task_active 是唯一序列化者", () => {
  // (a)
  it("同一任务并发触发只起一个实例（第二个拿到 409 而非第二行）", async () => {
    // 占满闸，让两次触发都停在「卡片还是 ready」的窗口上 —— 否则第二次会先被
    // ready-only 守卫弹回，测的就不是闩锁而是状态门了。
    insertJobFire("f-0a", "s-0a")
    insertJobFire("f-0b", "s-0b")
    const id = makeTaskRow()
    service.readyTask(id)
    const settled = await Promise.allSettled([service.triggerTask(id), service.triggerTask(id)])
    const ok = settled.filter((r) => r.status === "fulfilled")
    const failed = settled.filter((r) => r.status === "rejected")
    expect(ok).toHaveLength(1)
    expect(failed).toHaveLength(1)
    const err = (failed[0] as PromiseRejectedResult).reason
    expect(err).toBeInstanceOf(TaskStatusConflictError)
    expect((err as Error).message).toContain("已有进行中的实例")
    // 只有一个活实例、一次 start、总共一行（拒绝不留下半途行）。
    expect(liveInstances(id)).toBe(1)
    expect(stub.started).toHaveLength(0) // 闸满，谁都没 start
    expect(rowsOf(id)).toHaveLength(1)
  })

  // (a) — the latch itself, not the pre-check.
  it("绕过预检的第二次插入由索引挡下（SQLITE_CONSTRAINT_UNIQUE，不是记账）", () => {
    const id = makeTaskRow()
    service.readyTask(id)
    const first = service.taskLifecycle.armTask(id)
    const wsId = execs.findById(first)!.workspace_id
    expect(() =>
      db
        .prepare(
          `INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name,
             status, org, created_at, updated_at, task_id)
           VALUES ('ttm-raw', ?, '0', 'w', 'w', 'pending', ?, datetime('now'), datetime('now'), ?)`,
        )
        .run(wsId, ORG, id),
    ).toThrow(/UNIQUE/)
    expect(() => service.taskLifecycle.armTask(id)).toThrow(TaskLifecycleError)
  })

  // (b)
  it("已排队(armed)未 start 的实例照样挡住第二次领取，且拒绝文案说明是排队中", async () => {
    insertJobFire("f-3", "s-3")
    insertJobFire("f-4", "s-4") // cap=2 占满 → 领取后仍是 pending
    const id = makeTaskRow()
    service.readyTask(id)
    const armedId = service.taskLifecycle.armTask(id)
    expect(execs.findById(armedId)!.status).toBe("pending")

    let caught: TaskLifecycleError | undefined
    try {
      service.taskLifecycle.armTask(id)
    } catch (err) {
      caught = err as TaskLifecycleError
    }
    expect(caught?.reason).toBe("in-flight")
    expect(caught?.message).toContain("排队中")
    await expect(service.triggerTask(id)).rejects.toThrow(TaskStatusConflictError)
    expect(liveInstances(id)).toBe(1)
  })

  // (c)
  it("终态行释放槽位 —— 跑完一轮后同一任务可再入队再触发（历史行保留）", async () => {
    const id = makeTaskRow()
    service.readyTask(id)
    const first = await service.triggerTask(id)
    const firstId = first.execution!.id
    stub.callbacks.get(firstId)!("completed")
    await new Promise((r) => setImmediate(r))

    expect(execs.findById(firstId)!.status).toBe("completed")
    expect(liveInstances(id)).toBe(0)
    // v3/legacy：一轮就是任务结局 → done；人重新入队才能再跑。
    expect(db.prepare("SELECT status FROM tasks WHERE id=?").get(id)).toEqual({ status: "done" })
    db.prepare("UPDATE tasks SET status='ready' WHERE id=?").run(id)
    await service.triggerTask(id)
    const all = rowsOf(id)
    expect(all).toHaveLength(2)
    expect(all[1].status).toBe("running")
    expect(liveInstances(id)).toBe(1)
  })

  it("中止也释放槽位（行 aborted → 重新入队可再触发）", async () => {
    const id = makeTaskRow()
    service.readyTask(id)
    const dto = await service.triggerTask(id)
    service.abortTask(id)
    expect(execs.findById(dto.execution!.id)!.status).toBe("aborted")
    expect(liveInstances(id)).toBe(0)
    db.prepare("UPDATE tasks SET status='ready' WHERE id=?").run(id)
    await service.triggerTask(id)
    expect(liveInstances(id)).toBe(1)
  })

  // (d)
  it("两个不同任务互不影响；闸满时第三个排队而不是被锁死", async () => {
    const a = makeTaskRow()
    const b = makeTaskRow()
    const c = makeTaskRow()
    for (const id of [a, b, c]) service.readyTask(id)
    await Promise.all([service.triggerTask(a), service.triggerTask(b), service.triggerTask(c)])

    // cap=2 → 前两个 running，第三个 armed 排队（不是失败）。
    expect(execs.findLatestTaskRoot(a)!.status).toBe("running")
    expect(execs.findLatestTaskRoot(b)!.status).toBe("running")
    expect(execs.findLatestTaskRoot(c)!.status).toBe("pending")
    // 排队不占算力槽（否则队列自己堵自己）。
    expect(liveInstances(c)).toBe(1)
    // 腾出一个槽 → 队列自己续领，不需要任何人再点按钮，也不用等下一个 cron 分钟:
    // 终态回调在释放槽位后顺手 drain 一次(launchQueued(1))。
    stub.callbacks.get(execs.findLatestTaskRoot(a)!.id)!("completed")
    await new Promise((r) => setImmediate(r))
    expect(execs.findLatestTaskRoot(c)!.status).toBe("running")
    expect(stub.started).toHaveLength(3)
    // 排空后再手动领一次必须是 0 —— 证明续领不重复起(finished 的行不会被再次 claim)。
    const second = service.taskLifecycle.launchQueued()
    expect(second.launched).toBe(0)
    expect(second.capped).toBe(false)
    expect(stub.started).toHaveLength(3)
  })
})

// ── 4. 单次定时 = 写游标，到点由内置 job 领 ─────────────────────────
describe("票03 §2 — triggerTask(未来)", () => {
  it("未来 at 只 armOnce：不建实例、状态留 ready、next_fire_at=at", async () => {
    const id = makeTaskRow()
    service.readyTask(id)
    const at = new Date(Date.now() + 300_000).toISOString()
    const dto = await service.triggerTask(id, at)

    expect(dto.status).toBe("ready")
    expect(dto.next_fire_at).toBe(at)
    expect(dto.trigger_mode).toBe("once")
    expect(rowsOf(id)).toHaveLength(0)
    expect(scheduleRowCount()).toBe(0)
    expect(events.some((e) => e.event === TASK_TRIGGER_EVENT && (e.data as { action: string }).action === "scheduled")).toBe(true)
    // 未到期的一刻：tick 什么都不做。
    expect(service.taskLifecycle.tick().armed).toBe(0)
  })

  it("到点由 job 的 tick 起（没人再按按钮），once 燃尽后不再复燃", async () => {
    const id = makeTaskRow()
    service.readyTask(id)
    const at = new Date(Date.now() + 120_000).toISOString()
    await service.triggerTask(id, at) // 只写游标
    expect(rowsOf(id)).toHaveLength(0)

    // 未到点 → tick 什么都不起（单源是 next_fire_at 一列）。
    expect(service.taskLifecycle.tick(new Date(Date.now() + 1_000).toISOString()).armed).toBe(0)

    // 到点 → 内置 job 自己领取起跑。
    const m = service.taskLifecycle.tick(new Date(Date.now() + 180_000).toISOString())
    expect(m.armed).toBe(1)
    expect(m.launched).toBe(1)
    expect(rowsOf(id)).toHaveLength(1)
    const t = db.prepare("SELECT status, next_fire_at, last_fired_at FROM tasks WHERE id=?").get(id) as {
      status: string
      next_fire_at: string | null
      last_fired_at: string | null
    }
    expect(t.status).toBe("running")
    expect(t.next_fire_at).toBeNull() // once 燃尽 —— 泵永远不会替它重新入队
    expect(t.last_fired_at).not.toBeNull()
    expect(service.taskLifecycle.tick().armed).toBe(0)
  })
})

// ── 5. cancelTaskTrigger ─────────────────────────────────────────────
describe("票03 §3 — cancelTaskTrigger", () => {
  it("未到点：只清游标，回 ready，没有实例可撤", async () => {
    const id = makeTaskRow()
    service.readyTask(id)
    await service.triggerTask(id, new Date(Date.now() + 300_000).toISOString())

    const dto = service.cancelTaskTrigger(id)
    expect(dto.status).toBe("ready")
    expect(dto.next_fire_at).toBeNull()
    expect(dto.trigger_mode).toBe("manual")
    expect(rowsOf(id)).toHaveLength(0)
    const actions = events
      .filter((e) => e.event === TASK_TRIGGER_EVENT)
      .map((e) => (e.data as { action: string }).action)
    expect(actions).toEqual(["scheduled", "cancelled"])
  })

  it("已被 job 领取但没 start（pending）：retire 那一行 + 清游标 + 回 ready", async () => {
    insertJobFire("f-5", "s-5")
    insertJobFire("f-6", "s-6")
    const id = makeTaskRow()
    service.readyTask(id)
    await service.triggerTask(id, new Date(Date.now() + 60_000).toISOString())
    // 到点：job 领取成 pending 行，但闸满 start 不了。
    const m = service.taskLifecycle.tick(new Date(Date.now() + 120_000).toISOString())
    expect(m.armed).toBe(1)
    expect(m.launched).toBe(0)
    const row = execs.findLatestTaskRoot(id)!
    expect(row.status).toBe("pending")

    const dto = service.cancelTaskTrigger(id)
    expect(dto.status).toBe("ready")
    expect(execs.findById(row.id)!.status).toBe("aborted")
    expect(liveInstances(id)).toBe(0)
    expect(dto.next_fire_at).toBeNull()
  })

  it("已 start → 409，答案是「改用中止」而不是静默撤回", async () => {
    const id = makeTaskRow()
    service.readyTask(id)
    await service.triggerTask(id)
    expect(() => service.cancelTaskTrigger(id)).toThrow(/已开始执行/)
    expect(execs.findLatestTaskRoot(id)!.status).toBe("running")
  })

  it("没有可取消的定时触发 → 409（不是静默成功）", () => {
    const id = makeTaskRow()
    service.readyTask(id)
    expect(() => service.cancelTaskTrigger(id)).toThrow(/没有可取消的定时触发/)
  })
})

// ── 6. reopen ────────────────────────────────────────────────────────
describe("票03 §6 — reopenTask 的守卫换成了「没有活实例」", () => {
  it("ready→draft + SSE；不再软删任何信封（无信封可删）", () => {
    const id = makeTaskRow()
    service.readyTask(id)
    const dto = service.reopenTask(id)
    expect(dto.status).toBe("draft")
    expect(scheduleRowCount()).toBe(0)
    expect(
      events.some((e) => e.event === TASK_STATUS_EVENT && (e.data as { status: string }).status === "draft"),
    ).toBe(true)
    // 重新入队不产生第二份定义 —— 因为从来没产生过第一份。
    service.readyTask(id)
    expect(scheduleRowCount()).toBe(0)
  })

  it("running 卡片被状态守卫先拒；镜像滞后的卡片由 currentInstance 守卫兜住", async () => {
    const id = makeTaskRow()
    service.readyTask(id)
    await service.triggerTask(id)
    expect(() => service.reopenTask(id)).toThrow(/only ready→draft/)
    // 旧版这里是「看信封是不是 claimed」；信封没了，守卫改成直接看这个任务的实例行。
    db.prepare("UPDATE tasks SET status='ready' WHERE id=?").run(id)
    expect(() => service.reopenTask(id)).toThrow(/无法退回草稿/)
    expect(db.prepare("SELECT status FROM tasks WHERE id=?").get(id)).toEqual({ status: "ready" })
  })

  it("已排队的实例同样挡住 reopen（旧版靠信封 claimed，现在看行）", () => {
    insertJobFire("f-7", "s-7")
    insertJobFire("f-8", "s-8")
    const id = makeTaskRow()
    service.readyTask(id)
    service.taskLifecycle.armTask(id)
    expect(() => service.reopenTask(id)).toThrow(/无法退回草稿/)
  })

  it("跑完的那一轮不挡 reopen（行是历史），reopen 只是解锁编辑", async () => {
    const id = makeTaskRow()
    service.readyTask(id)
    const dto = await service.triggerTask(id)
    stub.callbacks.get(dto.execution!.id)!("completed")
    await new Promise((r) => setImmediate(r))
    db.prepare("UPDATE tasks SET status='ready' WHERE id=?").run(id)
    expect(service.reopenTask(id).status).toBe("draft")
    expect(rowsOf(id)).toHaveLength(1) // 历史留在 executions，不随 reopen 消失
  })

  it("非 ready 直接拒", () => {
    const id = makeTaskRow()
    expect(() => service.reopenTask(id)).toThrow(/only ready→draft/)
  })
})

// ── 7. routes ────────────────────────────────────────────────────────
describe("routes — 票03 的状态码映射", () => {
  async function post(url: string, body?: unknown) {
    return app.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    })
  }

  it("POST /:id/trigger — 非法 at → 400；未来 at → 200 且 DTO 是 ready+游标", async () => {
    const id = makeTaskRow()
    service.readyTask(id)
    expect((await post(`/api/tasks/${id}/trigger`, { at: "tomorrow-ish" })).status).toBe(400)

    const at = new Date(Date.now() + 60_000).toISOString()
    const res = await post(`/api/tasks/${id}/trigger`, { at })
    expect(res.status).toBe(200)
    const dto = (await res.json()) as { status: string; next_fire_at: string; execution: unknown }
    expect(dto.status).toBe("ready") // 定时不等于已开跑（旧版这里报 running）
    expect(dto.next_fire_at).toBe(at)
    expect(dto.execution).toBeNull()
  })

  it("POST /:id/trigger — 非 ready → 409（服务端文案）", async () => {
    const id = makeTaskRow()
    const res = await post(`/api/tasks/${id}/trigger`)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toMatch(/ready/)
  })

  it("POST /:id/trigger — 在飞实例（卡片仍是 ready，因为还没 start）→ 409 带「已有进行中的实例」", async () => {
    insertJobFire("f-9", "s-9")
    insertJobFire("f-10", "s-10") // 闸满 → 实例停在 pending，任务状态没镜像
    const id = makeTaskRow()
    service.readyTask(id)
    await post(`/api/tasks/${id}/trigger`)
    const res = await post(`/api/tasks/${id}/trigger`)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toContain("已有进行中的实例")
    expect(liveInstances(id)).toBe(1)
  })

  it("POST /:id/trigger — 已开跑（卡片 running）→ 409，答案是「只有已入队可以触发」", async () => {
    const id = makeTaskRow()
    service.readyTask(id)
    await post(`/api/tasks/${id}/trigger`)
    const res = await post(`/api/tasks/${id}/trigger`)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toMatch(/ready/)
  })

  it("POST /:id/trigger/cancel — 定时后撤回 → 200 ready", async () => {
    const id = makeTaskRow()
    service.readyTask(id)
    await post(`/api/tasks/${id}/trigger`, { at: new Date(Date.now() + 60_000).toISOString() })
    const res = await post(`/api/tasks/${id}/trigger/cancel`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { status: string }).status).toBe("ready")
  })

  it("POST /:id/reopen — ready→draft；再 reopen → 409", async () => {
    const id = makeTaskRow()
    service.readyTask(id)
    const res = await post(`/api/tasks/${id}/reopen`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { status: string }).status).toBe("draft")
    expect((await post(`/api/tasks/${id}/reopen`)).status).toBe(409)
  })

  it("GET /api/tasks — DTO 带 trigger_* 与 execution 徽标（替代 schedule_status/scheduled_at）", async () => {
    const id = makeTaskRow()
    service.readyTask(id)
    await service.triggerTask(id, new Date(Date.now() + 300_000).toISOString())
    const res = await app.request("/api/tasks")
    const { items } = (await res.json()) as {
      items: Array<Record<string, unknown> & { id: string }>
    }
    const dto = items.find((t) => t.id === id)!
    expect(dto.trigger_mode).toBe("once")
    expect(dto.next_fire_at).toBeTruthy()
    expect("schedule_status" in dto).toBe(false)
    expect("scheduled_at" in dto).toBe(false)
    expect(dto.execution).toBeNull()

    // 触发一次后徽标出现在行上（pending/running 由行状态给）。
    await service.triggerTask(id)
    const after = ((await (await app.request("/api/tasks")).json()) as {
      items: Array<Record<string, unknown> & { id: string }>
    }).items.find((t) => t.id === id)!
    expect(after.execution).toMatchObject({ status: "running" })
  })

  it("GET /api/tasks/:id — 详情用 executions[] 取代 children[]", async () => {
    const id = makeTaskRow()
    service.readyTask(id)
    await service.triggerTask(id)
    const detail = (await (await app.request(`/api/tasks/${id}`)).json()) as {
      children?: unknown
      executions?: Array<{ status: string }>
    }
    expect(detail.children).toBeUndefined()
    expect(detail.executions).toHaveLength(1)
    expect(detail.executions![0].status).toBe("running")
  })

  it("触发只依赖 DB 状态：换一个 service 实例（=重启）照样能领", async () => {
    const id = makeTaskRow()
    service.readyTask(id)
    const revived = new TasksService(
      db, sse, new AgentSessionDAO(db), undefined, undefined, null, null,
      fakeWorkspaceService() as never,
    )
    const dto = await revived.triggerTask(id, new Date(Date.now() + 60_000).toISOString())
    expect(dto.status).toBe("ready")
    expect(dto.next_fire_at).toBeTruthy()
  })
})
