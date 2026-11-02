import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Hono } from "hono"
import Database from "better-sqlite3"
import { applySchema } from "../../db/schema"
import { ExecutionDAO } from "../../db/dao/execution-dao"
import { createWorkflowOpsRoutes, type WorkspaceRunWire } from "../workflow-ops"

/**
 * GET /api/workspaces/:id/workflows/runs —— 作业坞运行面板的只读列表。
 * 验收规划行 task_id=NULL，坐标从 pipeline_config 补；isSystem 由 triggered_by 判。
 */

describe("workflow-ops · GET /runs", () => {
  let db: Database.Database
  let dao: ExecutionDAO
  let app: Hono

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    dao = new ExecutionDAO(db)
    const now = new Date().toISOString()
    for (const id of ["ws-1", "ws-2"]) {
      db.prepare(
        "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run(id, id, `/tmp/${id}`, now, now)
    }
    app = new Hono()
    app.route("/api/workspaces/:id/workflows", createWorkflowOpsRoutes({} as never, dao))
  })

  afterEach(() => {
    db?.close()
  })

  it("返回顶层运行行，验收规划带 system 标记与 pipeline_config 坐标", async () => {
    dao.insertExecution({
      id: "plan-exec",
      workspace_id: "ws-1",
      workflow_ref: "built-in/acceptance-plan",
      workflow_name: "acceptance-plan",
      name: "acceptance-plan-t1234567-p1-r1",
      status: "running",
      triggered_by: "acceptance-plan",
      task_id: null,
      started_at: "2026-11-01T10:00:00.000Z",
    })
    // pipeline_config 只走 updateExecution（insertExecution 不含该列）——与
    // AcceptancePlanService.generate 的写法一致。
    dao.updateExecution("plan-exec", {
      pipeline_config: JSON.stringify({
        acceptance_plan: true,
        task_id: "t-123",
        phase_index: 1,
        round_index: 1,
      }),
    })

    const res = await app.request("/api/workspaces/ws-1/workflows/runs")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { runs: WorkspaceRunWire[] }
    expect(body.runs).toHaveLength(1)
    const [run] = body.runs
    expect(run).toMatchObject({
      id: "plan-exec",
      workspaceId: "ws-1",
      workflowRef: "built-in/acceptance-plan",
      status: "running",
      triggeredBy: "acceptance-plan",
      taskId: "t-123",
      phaseIndex: 1,
      roundIndex: 1,
      isSystem: true,
      startedAt: "2026-11-01T10:00:00.000Z",
    })
  })

  it("任务轮次不标 system；缺 duration 时由起止时间补毫秒差", async () => {
    dao.insertExecution({
      id: "round-exec",
      workspace_id: "ws-1",
      workflow_ref: "built-in/matt-spec-dev",
      workflow_name: "matt-spec-dev",
      status: "completed",
      triggered_by: "task",
      task_id: "t-123",
      phase_index: 1,
      round_index: 2,
      started_at: "2026-11-01T10:00:00.000Z",
      completed_at: "2026-11-01T10:02:30.000Z",
    })

    const res = await app.request("/api/workspaces/ws-1/workflows/runs")
    const body = (await res.json()) as { runs: WorkspaceRunWire[] }
    expect(body.runs[0]).toMatchObject({
      id: "round-exec",
      taskId: "t-123",
      phaseIndex: 1,
      roundIndex: 2,
      isSystem: false,
      duration: 150_000,
    })
  })

  it("工作区隔离 + limit 参数", async () => {
    for (const [id, ws] of [["a", "ws-1"], ["b", "ws-1"], ["c", "ws-2"]] as const) {
      dao.insertExecution({
        id,
        workspace_id: ws,
        workflow_ref: "built-in/demo",
        status: "completed",
        created_at: `2026-11-01T1${id === "a" ? 0 : 1}:00:00.000Z`,
      })
    }

    const res = await app.request("/api/workspaces/ws-1/workflows/runs?limit=1")
    const body = (await res.json()) as { runs: WorkspaceRunWire[] }
    expect(body.runs.map((r) => r.id)).toEqual(["b"])
  })
})
