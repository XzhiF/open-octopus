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
