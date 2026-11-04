// GET /api/agent/executions/running —— header「运行中工作流」指示的数据源。
//
// 与 workflow-ops 的 /runs 同口径（顶层 running 行），但跨工作区，且给 header
// 一个可点的执行坐标：任务轮次读行上的 task_id/phase/round；验收规划这类
// task_id=NULL 的系统运行，坐标从 execution_links 补。

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Hono } from "hono"
import Database from "better-sqlite3"
import { applySchema } from "../../db/schema"
import { ExecutionDAO } from "../../db/dao/execution-dao"
import { ExecutionLinkDAO } from "../../db/dao/execution-link-dao"
import { createRunningRoutes, type RunningExecutionWire } from "../agent/running"

describe("agent running · GET /executions/running", () => {
  let db: Database.Database
  let dao: ExecutionDAO
  let app: Hono

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    dao = new ExecutionDAO(db)
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES ('ws-1', 'ws-1', '/tmp/ws-1', ?, ?)",
    ).run(now, now)
    db.prepare(
      "INSERT INTO tasks (id, name, status, created_at, updated_at) VALUES ('t-1', 'MySQL 落库', 'running', ?, ?)",
    ).run(now, now)
    app = new Hono()
    app.route("/api/agent", createRunningRoutes(dao))
  })

  afterEach(() => {
    db?.close()
  })

  it("任务轮次：标题取任务名，坐标读执行行", async () => {
    dao.insertExecution({
      id: "round-exec",
      workspace_id: "ws-1",
      workflow_ref: "built-in/matt-spec-dev",
      workflow_name: "matt-spec-dev",
      status: "running",
      task_id: "t-1",
      phase_index: 2,
      round_index: 1,
      started_at: "2026-11-04T01:36:16.000Z",
    })

    const res = await app.request("/api/agent/executions/running")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { runs: RunningExecutionWire[] }
    expect(body.runs).toHaveLength(1)
    expect(body.runs[0]).toMatchObject({
      id: "round-exec",
      workspaceId: "ws-1",
      title: "MySQL 落库",
      taskId: "t-1",
      taskName: "MySQL 落库",
      phaseIndex: 2,
      roundIndex: 1,
      status: "running",
      startedAt: "2026-11-04T01:36:16.000Z",
    })
  })

  it("验收规划（task_id=NULL）：标题回退工作流名，坐标从 execution_links 补", async () => {
    dao.insertExecution({
      id: "plan-exec",
      workspace_id: "ws-1",
      workflow_ref: "built-in/acceptance-plan",
      workflow_name: "acceptance-plan",
      status: "running",
      task_id: null,
    })
    new ExecutionLinkDAO(db).link({
      executionId: "plan-exec",
      sessionId: "s-main",
      taskId: "t-1",
      kind: "task_aux",
      phaseIndex: 2,
      roundIndex: 1,
    })

    const res = await app.request("/api/agent/executions/running")
    const body = (await res.json()) as { runs: RunningExecutionWire[] }
    expect(body.runs[0]).toMatchObject({
      id: "plan-exec",
      title: "acceptance-plan",
      taskId: "t-1",
      taskName: null,
      phaseIndex: 2,
      roundIndex: 1,
    })
  })

  it("只收 running；limit 收口到 1..100", async () => {
    dao.insertExecution({ id: "live", workspace_id: "ws-1", status: "running", started_at: "2026-11-04T02:00:00.000Z" })
    dao.insertExecution({ id: "done", workspace_id: "ws-1", status: "completed" })
    dao.insertExecution({ id: "queued", workspace_id: "ws-1", status: "pending" })

    const res = await app.request("/api/agent/executions/running?limit=999")
    const body = (await res.json()) as { runs: RunningExecutionWire[] }
    expect(body.runs.map((r) => r.id)).toEqual(["live"])
  })
})
