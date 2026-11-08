import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../../schema"
import { ExecutionDAO } from "../execution-dao"

function seedWorkspace(db: Database.Database, id: string): void {
  const now = new Date().toISOString()
  db.prepare(
    "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, id, `/tmp/${id}`, now, now)
}

/**
 * listWorkspaceRuns —— 作业坞「运行」面板的顶层口径。
 *
 * 与 task instance 读模型同一谓词（roots + v4 链式轮次），额外排除调度器空容器
 * `scheduler-root`。验收规划行 task_id=NULL 但 parent_id='0'，必须出现在列表里。
 */

describe("ExecutionDAO.listWorkspaceRuns — 工作区顶层运行", () => {
  let db: Database.Database
  let dao: ExecutionDAO

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    dao = new ExecutionDAO(db)
    seedWorkspace(db, "ws-1")
    seedWorkspace(db, "ws-2")
  })

  afterEach(() => {
    db?.close()
  })

  const seed = (overrides: Partial<Parameters<ExecutionDAO["insertExecution"]>[0]> = {}) => {
    const id = overrides.id ?? `exec-${Math.random().toString(36).slice(2, 10)}`
    dao.insertExecution({
      id,
      workspace_id: "ws-1",
      workflow_ref: "built-in/demo",
      workflow_name: "demo",
      ...overrides,
    })
    return id
  }

  it("包含验收规划行（task_id=NULL、parent_id='0'、无 phase）", () => {
    const id = seed({
      status: "running",
      parent_id: "0",
      task_id: null,
      triggered_by: "acceptance-plan",
    })

    const runs = dao.listWorkspaceRuns("ws-1")
    expect(runs.map((r) => r.id)).toContain(id)
  })

  it("包含 v4 链式轮次（parent_id 指向前一轮，但有 phase_index）", () => {
    const prev = seed({ id: "prev", status: "completed" })
    const round = seed({
      id: "round-2",
      parent_id: prev,
      status: "completed",
      phase_index: 1,
      round_index: 2,
      task_id: "t-1",
    })

    const runs = dao.listWorkspaceRuns("ws-1")
    expect(runs.map((r) => r.id)).toContain(round)
  })

  it("排除链式子步骤（parent_id != '0' 且无 phase）与调度器空容器", () => {
    const root = seed({ id: "root", status: "completed" })
    seed({ id: "child-step", parent_id: root, status: "completed" })
    seed({ id: "container", parent_id: "0", node_type: "scheduler-root", status: "completed" })

    const ids = dao.listWorkspaceRuns("ws-1").map((r) => r.id)
    expect(ids).toEqual(["root"])
  })

  it("运行中排在最前，其余按 created_at 倒序", () => {
    seed({ id: "done-old", status: "completed", created_at: "2026-11-01T10:00:00.000Z" })
    seed({ id: "done-new", status: "completed", created_at: "2026-11-01T12:00:00.000Z" })
    seed({ id: "live", status: "running", created_at: "2026-11-01T09:00:00.000Z" })
    seed({ id: "queued", status: "pending", created_at: "2026-11-01T11:00:00.000Z" })

    expect(dao.listWorkspaceRuns("ws-1").map((r) => r.id)).toEqual([
      "live",
      "queued",
      "done-new",
      "done-old",
    ])
  })

  it("按工作区隔离，并支持 limit", () => {
    seed({ id: "a", status: "completed", created_at: "2026-11-01T10:00:00.000Z" })
    seed({ id: "b", status: "completed", created_at: "2026-11-01T11:00:00.000Z" })
    seed({ id: "other", workspace_id: "ws-2", status: "completed" })

    expect(dao.listWorkspaceRuns("ws-1", 1).map((r) => r.id)).toEqual(["b"])
    expect(dao.listWorkspaceRuns("ws-2").map((r) => r.id)).toEqual(["other"])
  })
})

/**
 * listLiveRuns —— header「运行中工作流」指示（2026-11-04）。
 *
 * 跨工作区、只要顶层 `running` 行；排队/暂停不亮。LEFT JOIN tasks 带任务名，
 * 验收规划这类系统运行 task_id=NULL（坐标由路由层按 execution_links 补）。
 */
describe("ExecutionDAO.listLiveRuns — 跨工作区运行中执行", () => {
  let db: Database.Database
  let dao: ExecutionDAO

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    dao = new ExecutionDAO(db)
    seedWorkspace(db, "ws-1")
    seedWorkspace(db, "ws-2")
  })

  afterEach(() => {
    db?.close()
  })

  const seed = (overrides: Partial<Parameters<ExecutionDAO["insertExecution"]>[0]> = {}) => {
    const id = overrides.id ?? `exec-${Math.random().toString(36).slice(2, 10)}`
    dao.insertExecution({
      id,
      workspace_id: "ws-1",
      workflow_ref: "built-in/demo",
      workflow_name: "demo",
      ...overrides,
    })
    return id
  }

  const seedTask = (id: string, name: string) => {
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO tasks (id, name, status, created_at, updated_at) VALUES (?, ?, 'running', ?, ?)",
    ).run(id, name, now, now)
  }

  it("跨工作区收集 running 顶层行，带出任务名", () => {
    seedTask("t-1", "MySQL 落库")
    seed({
      id: "round", workspace_id: "ws-2", status: "running", task_id: "t-1",
      phase_index: 2, round_index: 1, started_at: "2026-11-04T01:36:16.000Z",
    })

    const runs = dao.listLiveRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      id: "round",
      workspace_id: "ws-2",
      task_id: "t-1",
      task_name: "MySQL 落库",
      phase_index: 2,
      round_index: 1,
    })
  })

  it("排除排队/暂停/终态、子步骤与调度器空容器", () => {
    seed({ id: "live", status: "running" })
    seed({ id: "queued", status: "pending" })
    seed({ id: "paused", status: "paused" })
    seed({ id: "done", status: "completed" })
    seed({ id: "child-step", parent_id: "live", status: "running" })
    seed({ id: "container", node_type: "scheduler-root", status: "running" })

    expect(dao.listLiveRuns().map((r) => r.id)).toEqual(["live"])
  })

  it("验收规划系统运行（task_id=NULL）在列，任务名为空", () => {
    seed({
      id: "plan", status: "running", triggered_by: "acceptance-plan",
      workflow_ref: "built-in/acceptance-plan", workflow_name: "acceptance-plan",
      task_id: null, started_at: "2026-11-04T02:00:00.000Z",
    })

    const [run] = dao.listLiveRuns()
    expect(run).toMatchObject({ id: "plan", task_id: null, task_name: null })
  })
})

/**
 * retireOrphanedPendingExecutions —— 启动回收（2026-11-05）。
 *
 * pending 对任务实例是**合法排队态**（launchQueued 每 tick 领），启动回收只能
 * 收「非任务 + 从未启动 + 早于宽限期」的孤儿，否则会把排队中的任务判死。
 */
describe("ExecutionDAO.retireOrphanedPendingExecutions — 启动回收孤儿", () => {
  let db: Database.Database
  let dao: ExecutionDAO

  const CUTOFF = "2026-11-05T02:00:00.000Z"
  const REASON = "启动回收：执行行创建后未启动"

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    dao = new ExecutionDAO(db)
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws-1", "ws-1", "/tmp/ws-1", CUTOFF, CUTOFF)
  })

  afterEach(() => {
    db?.close()
  })

  const seed = (overrides: Partial<Parameters<ExecutionDAO["insertExecution"]>[0]>) =>
    dao.insertExecution({
      id: "x",
      workspace_id: "ws-1",
      workflow_ref: "built-in/acceptance-plan",
      workflow_name: "acceptance-plan",
      ...overrides,
    })

  it("回收 task_id=NULL、未启动、早于 cutoff 的 pending 行", () => {
    seed({ id: "orphan", status: "pending", task_id: null, started_at: null, created_at: "2026-11-05T01:00:00.000Z" })

    expect(dao.retireOrphanedPendingExecutions(CUTOFF, REASON)).toBe(1)

    const row = dao.findById("orphan")!
    expect(row.status).toBe("interrupted")
    expect(row.completed_at).toBeTruthy()
    expect(JSON.parse(row.var_pool ?? "{}").error).toBe(REASON)
  })

  it("跳过任务的排队行（task_id 非空，等并发闸的合法 pending）", () => {
    seed({ id: "armed", status: "pending", task_id: "t-1", started_at: null, created_at: "2026-11-05T01:00:00.000Z" })

    expect(dao.retireOrphanedPendingExecutions(CUTOFF, REASON)).toBe(0)
    expect(dao.findById("armed")!.status).toBe("pending")
  })

  it("跳过已 claim（started_at 非空）、终态与宽限期内的行", () => {
    seed({ id: "claimed", status: "pending", task_id: null, started_at: "2026-11-05T01:30:00.000Z", created_at: "2026-11-05T01:00:00.000Z" })
    seed({ id: "done", status: "completed", task_id: null, started_at: null, created_at: "2026-11-05T01:00:00.000Z" })
    seed({ id: "fresh", status: "pending", task_id: null, started_at: null, created_at: "2026-11-05T02:01:00.000Z" })

    expect(dao.retireOrphanedPendingExecutions(CUTOFF, REASON)).toBe(0)
  })
})

/** A（2026-11-05）依赖的守卫：retireLaunch 只能收 pending，绝不覆盖已跑起来的行。 */
describe("ExecutionDAO.retireLaunch — 守卫 status='pending'", () => {
  let db: Database.Database
  let dao: ExecutionDAO

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    dao = new ExecutionDAO(db)
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws-1", "ws-1", "/tmp/ws-1", new Date().toISOString(), new Date().toISOString())
  })

  afterEach(() => {
    db?.close()
  })

  const seed = (id: string, status: string) =>
    dao.insertExecution({ id, workspace_id: "ws-1", workflow_ref: "built-in/x", status })

  it("pending → failed 并落 error", () => {
    seed("pending-row", "pending")
    expect(dao.retireLaunch("pending-row", "failed", "启动失败").changes).toBe(1)
    const row = dao.findById("pending-row")!
    expect(row.status).toBe("failed")
    expect(JSON.parse(row.var_pool ?? "{}").error).toBe("启动失败")
  })

  it("running 行原样不动", () => {
    seed("running-row", "running")
    expect(dao.retireLaunch("running-row", "failed", "启动失败").changes).toBe(0)
    expect(dao.findById("running-row")!.status).toBe("running")
  })
})
