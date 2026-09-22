// packages/server/src/__tests__/tasks-run-stats.test.ts
//
// run_stats —— 看板卡 ⏱ 与验收窗 rail「实际用时」的读模型聚合：逐条 instance 执行
// (root ∪ v4 chained round) 的 started→completed 实跑段求和；running 行计到读取刻。
// 排队 (started NULL)、暂停未闭、composite fan-out 臂（parent 行，root 跨度已含它）
// 都不进和。墙钟口径（created→now 把待验收挂的那一夜算成跑时）已废 —— 见 TaskRunStats。

import { describe, it, expect, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import { SSEService } from "../services/sse"
import { TasksService } from "../services/tasks/tasks-service"

const ORG = "run-stats"
const HOUR = 3_600_000
const MIN = 60_000

function newDb(): Database.Database {
  const db = new Database(":memory:")
  applySchema(db)
  db.prepare("INSERT OR IGNORE INTO scheduler_state (id, last_heartbeat) VALUES (1, datetime('now'))").run()
  return db
}

function seedTask(db: Database.Database, id: string, status: string) {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO tasks (id, org, name, status, source_chat_session_id, task_spec,
      authoring_resources, resources, skills, project_ids, workflow_ref, version,
      deleted_at, created_at, updated_at, completed_at, workspace_id)
    VALUES (?, ?, ?, ?, NULL, '{"goal":"g","ac":[]}', '[]', '[]', '[]', '[]', NULL, 1, NULL, ?, ?, NULL, NULL)
  `).run(id, ORG, `t-${id}`, status, now, now)
}

function seedWs(db: Database.Database, id: string) {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO workspaces (id, name, org, path, source, status, created_at, updated_at)
     VALUES (?, ?, ?, 'C:/tmp/run-stats-ws', 'manual', 'active', ?, ?)`,
  ).run(id, `ws-${id}`, ORG, now, now)
}

function seedExec(
  db: Database.Database,
  id: string,
  opts: {
    ws: string
    task: string
    status: string
    started: number | null
    completed: number | null
    parent?: string
    phaseIndex?: number | null
  },
) {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name,
      status, input_values, var_pool, org, created_at, updated_at, task_id, phase_index, round_index,
      started_at, completed_at)
    VALUES (?, ?, ?, 0, 'built-in/wf', 'wf', ?, '{}', '{}', ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    id, opts.ws, opts.parent ?? "0", opts.status, ORG, now, now, opts.task,
    opts.phaseIndex === null ? null : (opts.phaseIndex ?? 1),
    opts.started != null ? new Date(opts.started).toISOString() : null,
    opts.completed != null ? new Date(opts.completed).toISOString() : null,
  )
}

let db: Database.Database
let service: TasksService

beforeEach(() => {
  db = newDb()
  service = new TasksService(db, new SSEService())
})

describe("run_stats — 实跑用时聚合", () => {
  it("Σ 已闭轮 + running 计到读取刻；排队/暂停未闭/子臂不进和", () => {
    const base = Date.now()
    seedWs(db, "ws-1")
    seedTask(db, "t-a", "running")
    // 2h 成功轮
    seedExec(db, "e1", { ws: "ws-1", task: "t-a", status: "completed", started: base - 4 * HOUR, completed: base - 2 * HOUR })
    // 30min 失败轮（终态也实打实跑了）
    seedExec(db, "e2", { ws: "ws-1", task: "t-a", status: "failed", started: base - 1 * HOUR, completed: base - 30 * MIN })
    // 10min 在跑轮 —— 计到 now。（ux_exec_task_active 一任务一活实例，故下面的
    // 排队/未闭行用非活终态表达 —— 真实链路里它们与 running 从不同时存在。）
    seedExec(db, "e3", { ws: "ws-1", task: "t-a", status: "running", started: base - 10 * MIN, completed: null })
    // 从未起跑就被撤的轮：无 started_at → 不进
    seedExec(db, "e4", { ws: "ws-1", task: "t-a", status: "cancelled", started: null, completed: new Date(base - 2 * HOUR) })
    // 终态但缺 completed 戳（历史脏行）：running 以外不补 now → 不计
    seedExec(db, "e5", { ws: "ws-1", task: "t-a", status: "cancelled", started: base - 50 * MIN, completed: null })
    // composite 子臂：parent 置位 + phase NULL → 跨度已含在 root 里，不双计
    seedExec(db, "e6", { ws: "ws-1", task: "t-a", status: "completed", started: base - 3 * HOUR, completed: base - 170 * MIN, parent: "e1", phaseIndex: null })

    const item = service.listTasks().items.find((t) => t.id === "t-a")!
    expect(item.run_stats?.count).toBe(3)
    expect(item.run_stats!.duration_ms).toBeCloseTo(2 * HOUR + 30 * MIN + 10 * MIN, -3)

    // detail 同一口径
    const detail = service.getTask("t-a")
    expect(detail.run_stats?.count).toBe(3)
    // 徽章回归：attachInstances 改写后最新 instance 仍上卡（rowid 最大的 instance 行）
    expect(item.execution?.id).toBe("e5")
  })

  it("从未跑过的任务不带 run_stats", () => {
    seedTask(db, "t-b", "ready")
    const item = service.listTasks().items.find((t) => t.id === "t-b")!
    expect(item.run_stats).toBeUndefined()
    expect(item.execution).toBeNull()
    expect(service.getTask("t-b").run_stats).toBeUndefined()
  })
})
