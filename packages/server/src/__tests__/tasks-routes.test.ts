// packages/server/src/__tests__/tasks-routes.test.ts
//
// 03 — tasks service + /api/tasks routes integration (AC1/AC2/AC4).
//
// Verifies:
//   AC1: /api/tasks CRUD + spec-field + ready + abort endpoints work
//   AC2 (票03 改写): ready 是**纯状态动作** —— 过闸 + draft→ready，不建任何
//        schedules 信封行（simple/composite 都一样；composite 的子单元是运行时
//        的 executions 行，见 ADR-0021 §11，不是入队时的协调者行）。
//   AC4 (票03 改写): abort → 该任务的实例行被停 + tasks.status=aborted + SSE，
//        且不碰 schedule 表。
//
// AC3（TaskScheduleStatusListener 把 schedules.status 镜像到 tasks.status）随
// 监听器一起退役：任务状态推进现在是内置 task-lifecycle job 自己的职责，
// 那半边由 services/tasks/__tests__/task-lifecycle.test.ts（launch→running、
// 终态→done/failed、reconcile resync）钉住。
//
// Anti-fake-run: real better-sqlite3 DB + applySchema (R1/R3/R4/R5), Hono app
// request (R3 API↔DB), data prefix E2E_TD_ (R7), assert response+SQL (R4).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { AgentSessionDAO, TaskDAO } from "../db/dao"
import { SSEService } from "../services/sse"
import { TasksService } from "../services/tasks/tasks-service"
import { createTasksRoutes } from "../routes/tasks"
import { TASK_STATUS_EVENT, SPEC_FIELD_UPDATE_EVENT } from "@octopus/shared"

const ORG = "e2e-td-03"

type TaskStatusEvent = { task_id: string; status: string; schedule_id?: string }
type SpecFieldEvent = { task_id: string; field: string; value: unknown; version: number }

function makeSSECollector() {
  const sse = new SSEService()
  const taskEvents: TaskStatusEvent[] = []
  const specEvents: SpecFieldEvent[] = []
  sse.subscribe("taskpool", (e) => {
    if (e.event === TASK_STATUS_EVENT) {
      taskEvents.push(e.data as TaskStatusEvent)
    } else if (e.event === SPEC_FIELD_UPDATE_EVENT) {
      specEvents.push(e.data as SpecFieldEvent)
    }
  })
  return { sse, taskEvents, specEvents }
}

function newDb(): Database.Database {
  const db = new Database(":memory:")
  applySchema(db)
  return db
}

/** Insert a task row directly (bypass the service) to set up non-draft states. */
function insertTask(
  db: Database.Database,
  overrides: Partial<{
    id: string
    name: string
    status: string
    task_spec: string
    project_ids: string
    skills: string
    version: number
  }> = {},
) {
  const id = overrides.id ?? `e2e-td-task-${Math.random().toString(36).slice(2, 8)}`
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO tasks (id, org, name, status, source_chat_session_id, task_spec,
      authoring_resources, resources, skills, project_ids, workflow_ref, version,
      deleted_at, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, ?, NULL, ?, '[]', '[]', ?, ?, NULL, ?, NULL, ?, ?, NULL)
  `).run(
    id,
    ORG,
    overrides.name ?? "E2E_TD task",
    overrides.status ?? "draft",
    overrides.task_spec ?? JSON.stringify({ goal: "build X", ac: ["ac1"] }),
    overrides.skills ?? "[]",
    overrides.project_ids ?? "[]",
    overrides.version ?? 1,
    now,
    now,
  )
  return id
}

function readTaskStatus(db: Database.Database, id: string) {
  return db.prepare("SELECT status, version, completed_at FROM tasks WHERE id = ?").get(id) as
    { status: string; version: number; completed_at: string | null }
}

/** 票03 boundary: a task must never touch the scheduler\'s tables. */
function scheduleTableCounts(db: Database.Database) {
  const one = (t: string) => (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c
  return {
    schedules: one("schedules"),
    executions: one("schedule_executions"),
    workspaces: one("schedule_workspaces"),
  }
}

/** Seed the task\'s current instance the way the job would have armed it. */
function seedInstanceRow(
  db: Database.Database,
  taskId: string,
  status: string,
  opts: { id?: string; workspaceId?: string } = {},
): string {
  const id = opts.id ?? `e2e-td-exec-${Math.random().toString(36).slice(2, 8)}`
  const wsId = opts.workspaceId ?? `e2e-td-ws-${Math.random().toString(36).slice(2, 8)}`
  if (opts.workspaceId ?? true) {
    const exists = db.prepare("SELECT id FROM workspaces WHERE id = ?").get(wsId)
    if (!exists) {
      db.prepare(
        `INSERT INTO workspaces (id, name, org, status, path, source, task_id, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, 'task', ?, datetime('now'), datetime('now'))`,
      ).run(wsId, `ws-${taskId}`, ORG, `/tmp/e2e-td-${wsId}`, taskId)
    }
  }
  db.prepare(
    `INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status,
       org, created_at, updated_at, task_id)
     VALUES (?, ?, '0', 'built-in/flow', 'flow', ?, ?, datetime('now'), datetime('now'), ?)`,
  ).run(id, wsId, status, ORG, taskId)
  return id
}

async function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>
}

describe("03: /api/tasks routes + TasksService (integration)", () => {
  let db: Database.Database
  let app: Hono
  let sse: SSEService
  let taskEvents: TaskStatusEvent[]
  let specEvents: SpecFieldEvent[]
  let taskDAO: TaskDAO

  beforeAll(() => {
    db = newDb()
    const collector = makeSSECollector()
    sse = collector.sse
    taskEvents = collector.taskEvents
    specEvents = collector.specEvents
    taskDAO = new TaskDAO(db)
    const service = new TasksService(db, sse, new AgentSessionDAO(db))
    app = new Hono()
    app.route("/api/tasks", createTasksRoutes(service, sse))
  })

  afterAll(() => {
    db.close()
  })

  beforeEach(() => {
    // Clear SSE collectors between tests
    taskEvents.length = 0
    specEvents.length = 0
  })

  // ── AC1: CRUD ────────────────────────────────────────────────────────

  it("POST /api/tasks creates a draft task (201 + DB row)", async () => {
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ org: ORG, name: "E2E_TD_crud" }),
    })
    expect(res.status).toBe(201)
    const task = await json<{ id: string; status: string; name: string; version: number }>(res)
    expect(task.status).toBe("draft")
    expect(task.name).toBe("E2E_TD_crud")
    expect(task.version).toBe(1)
    // DB assert (R3/R4)
    const row = readTaskStatus(db, task.id)
    expect(row.status).toBe("draft")
  })

  it("GET /api/tasks returns the kanban list", async () => {
    const res = await app.request(`/api/tasks?org=${ORG}`)
    expect(res.status).toBe(200)
    const data = await json<{ items: Array<{ status: string; org: string }> }>(res)
    expect(data.items.length).toBeGreaterThan(0)
    expect(data.items.every((t) => t.org === ORG)).toBe(true)
  })

  it("GET /api/tasks/:id returns task detail with executions[] (children[] is gone)", async () => {
    const id = insertTask(db, { name: "E2E_TD_detail" })
    seedInstanceRow(db, id, "completed")
    const res = await app.request(`/api/tasks/${id}`)
    expect(res.status).toBe(200)
    const detail = await json<{
      id: string
      children?: unknown
      executions: Array<{ status: string }>
      execution: { status: string } | null
      derived: { isV4: boolean }
    }>(res)
    expect(detail.id).toBe(id)
    // 运行历史直连 executions.task_id —— 不再经信封 + schedule_executions 两跳。
    expect(detail.children).toBeUndefined()
    expect(detail.executions).toHaveLength(1)
    expect(detail.executions[0].status).toBe("completed")
    expect(detail.execution).toMatchObject({ status: "completed" })
    expect(detail.derived.isV4).toBe(false)
  })

  // ── 票05 (ADR-0021): the run read model — fan-out labels + a red run's reason ──
  it("detail + history project the composite fan-out and the failure reason (票05 read model)", async () => {
    const id = insertTask(db, { name: "E2E_TD_readmodel" })
    const rootId = seedInstanceRow(db, id, "failed")
    // The reason a failure writer leaves on the row (var_pool.error) — setLaunchStatus /
    // retireLaunch both write this key, which is what error_summary reads.
    db.prepare("UPDATE executions SET var_pool = ?, name = ? WHERE id = ?")
      .run(JSON.stringify({ error: "启动失败: worktree 不可用" }), "coordinator", rootId)
    // Two subunit arms: child executions of the root, task-bound, each with its own ws.
    const arm = (n: string, status: string) => {
      const wsId = `e2e-td-child-ws-${n}`
      db.prepare(
        `INSERT INTO workspaces (id, name, org, status, path, source, task_id, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, 'task', ?, datetime('now'), datetime('now'))`,
      ).run(wsId, `child-${n}`, ORG, `/tmp/e2e-td-${wsId}`, id)
      db.prepare(
        `INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name,
           name, status, org, created_at, updated_at, task_id)
         VALUES (?, ?, ?, ?, 'wf/x', 'x', ?, ?, ?, datetime('now'), datetime('now'), ?)`,
      ).run(`e2e-td-child-${n}`, wsId, rootId, Number(n), `subunit-${n}`, status, ORG, id)
    }
    arm("0", "completed")
    arm("1", "failed")

    const res = await app.request(`/api/tasks/${id}`)
    const detail = await json<{
      executions: Array<{
        id: string; status: string; name: string | null; error_summary: string | null
        children?: Array<{ id: string; name: string | null }>
      }>
      trigger_enabled: boolean
      trigger_mode: string
    }>(res)
    expect(res.status).toBe(200)

    const root = detail.executions.find((e) => e.id === rootId)!
    // error_summary: the badge's one-liner, previously only on the history endpoint.
    expect(root.error_summary).toBe("启动失败: worktree 不可用")
    // The fan-out is nested under the round that dispatched it, labelled by `name` —
    // 票04's row shape plus this field is what replaced schedules.origin_role='subunit'.
    expect(root.children?.map((c) => c.name).sort()).toEqual(["subunit-0", "subunit-1"])
    // Wire types the envelope forced into strings: the switch is a boolean, the mode an
    // enum member, both read off the task's own columns.
    expect(typeof detail.trigger_enabled).toBe("boolean")
    expect(detail.trigger_mode).toBe("manual")

    // The history endpoint is the SAME projection (one function feeds both), so a badge
    // cannot show something the history tab contradicts.
    const hist = await json<{
      executions?: never
      items: Array<{ id: string; current: boolean; error_summary: string | null; children?: unknown[] }>
    }>(await app.request(`/api/tasks/${id}/executions`))
    const histRoot = hist.items.find((e) => e.id === rootId)!
    expect(histRoot.error_summary).toBe(root.error_summary)
    expect(histRoot.current).toBe(true)
    expect(histRoot.children).toHaveLength(2)
  })

  it("a green run never surfaces a stale error key (error_summary is terminal-failure only)", async () => {
    const id = insertTask(db, { name: "E2E_TD_greenreason" })
    const rootId = seedInstanceRow(db, id, "completed")
    db.prepare("UPDATE executions SET var_pool = ? WHERE id = ?")
      .run(JSON.stringify({ error: "上一轮遗留" }), rootId)
    const detail = await json<{ executions: Array<{ id: string; error_summary: string | null }> }>(
      await app.request(`/api/tasks/${id}`),
    )
    expect(detail.executions.find((e) => e.id === rootId)!.error_summary).toBeNull()
  })

  it("PUT /api/tasks/:id updates with If-Match (save draft) + bumps version", async () => {
    const id = insertTask(db, { name: "E2E_TD_put" })
    const res = await app.request(`/api/tasks/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": "1" },
      body: JSON.stringify({ name: "E2E_TD_put-renamed" }),
    })
    expect(res.status).toBe(200)
    const task = await json<{ name: string; version: number }>(res)
    expect(task.name).toBe("E2E_TD_put-renamed")
    expect(task.version).toBe(2)
  })

  it("PUT rejects stale If-Match with 409", async () => {
    const id = insertTask(db, { name: "E2E_TD_stale", version: 2 })
    const res = await app.request(`/api/tasks/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": "1" },
      body: JSON.stringify({ name: "E2E_TD_stale-x" }),
    })
    expect(res.status).toBe(409)
  })

  it("DELETE /api/tasks/:id soft-deletes (discard draft)", async () => {
    const id = insertTask(db, { name: "E2E_TD_del" })
    const res = await app.request(`/api/tasks/${id}`, { method: "DELETE" })
    expect(res.status).toBe(200)
    // getById excludes soft-deleted
    expect(taskDAO.getById(id)).toBeNull()
  })

  // ── AC1: spec-field ─────────────────────────────────────────────────

  it("POST /:id/spec-field merges field + bumps version + emits spec_field_update SSE", async () => {
    const id = insertTask(db, { name: "E2E_TD_spec" })
    const res = await app.request(`/api/tasks/${id}/spec-field`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: "goal", value: "E2E_TD new goal" }),
    })
    expect(res.status).toBe(200)
    const result = await json<{ version: number }>(res)
    expect(result.version).toBe(2)
    // DB assert: task_spec.goal updated (R3/R4)
    const spec = JSON.parse(
      (db.prepare("SELECT task_spec FROM tasks WHERE id = ?").get(id) as { task_spec: string }).task_spec,
    ) as { goal: string }
    expect(spec.goal).toBe("E2E_TD new goal")
    // SSE assert (R3)
    expect(specEvents).toContainEqual({
      task_id: id,
      field: "goal",
      value: "E2E_TD new goal",
      version: 2,
    })
  })

  it("POST /:id/spec-field rejects invalid field value with 400", async () => {
    const id = insertTask(db, { name: "E2E_TD_invalid" })
    const res = await app.request(`/api/tasks/${id}/spec-field`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: "goal", value: "" }),
    })
    expect(res.status).toBe(400)
  })

  it("POST /:id/spec-field maps skills→skills column, projects→project_ids", async () => {
    const id = insertTask(db, { name: "E2E_TD_skills" })
    // skills
    let res = await app.request(`/api/tasks/${id}/spec-field`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: "skills", value: ["octo-backend", "octo-frontend"] }),
    })
    expect(res.status).toBe(200)
    // projects
    res = await app.request(`/api/tasks/${id}/spec-field`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: "projects", value: ["proj-A", "proj-B"] }),
    })
    expect(res.status).toBe(200)
    // DB assert
    const row = db
      .prepare("SELECT skills, project_ids FROM tasks WHERE id = ?")
      .get(id) as { skills: string; project_ids: string }
    expect(JSON.parse(row.skills)).toEqual(["octo-backend", "octo-frontend"])
    expect(JSON.parse(row.project_ids)).toEqual(["proj-A", "proj-B"])
  })

  // ── AC2 (票03): ready 是纯状态动作 ──────────────────────────────────

  it("POST /:id/ready (simple) → draft→ready 且三张 schedule 表零行", async () => {
    const id = insertTask(db, {
      name: "E2E_TD_ready_simple",
      task_spec: JSON.stringify({ goal: "simple task", ac: ["ac1"] }),
      project_ids: JSON.stringify(["proj-A"]),
    })
    const res = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    expect(res.status).toBe(200)
    const task = await json<{ status: string }>(res)
    expect(task.status).toBe("ready")
    expect(readTaskStatus(db, id).status).toBe("ready")
    // v39 的「停放信封」不存在了：入队既不建 schedules 行，也就没有 draft 停放态、
    // 没有 orphan 可漏、没有 status='queued' 的领取入口。
    expect(scheduleTableCounts(db)).toEqual({ schedules: 0, executions: 0, workspaces: 0 })
    // 「何时跑」是任务自己的列，入队不写游标（等人工触发或 setCronTrigger）。
    const trig = db.prepare("SELECT trigger_mode, next_fire_at FROM tasks WHERE id = ?").get(id) as {
      trigger_mode: string
      next_fire_at: string | null
    }
    expect(trig).toEqual({ trigger_mode: "manual", next_fire_at: null })
  })

  it("POST /:id/ready (composite, 2+ subunits) → 同样零信封（子单元是运行时执行行）", async () => {
    const id = insertTask(db, {
      name: "E2E_TD_ready_composite",
      task_spec: JSON.stringify({
        goal: "composite task",
        ac: ["ac1"],
        subunits: [
          {
            name: "sub-A",
            workspace_spec: {
              org: ORG,
              branch_prefix: "suba",
              projects: [{ name: "proj-A", source_path: "", group: "" }],
            },
            workflow_ref: "built-in/sub-a.yaml",
            input_values: {},
            skills: [],
            resources: [],
          },
          {
            name: "sub-B",
            workspace_spec: {
              org: ORG,
              branch_prefix: "subb",
              projects: [{ name: "proj-B", source_path: "", group: "" }],
            },
            workflow_ref: "built-in/sub-b.yaml",
            input_values: {},
            skills: [],
            resources: [],
          },
        ],
      }),
      project_ids: JSON.stringify(["proj-A"]),
    })
    const res = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    expect(res.status).toBe(200)
    // 旧版这里断言「1 个 coordinator 信封行」——composite 的协调者是**一轮执行**
    // （executions 行，chain[0]=composition wf），子单元是它的 child 行（§11），
    // 都发生在领取之后，入队一行都不写。
    expect(scheduleTableCounts(db)).toEqual({ schedules: 0, executions: 0, workspaces: 0 })
    expect(db.prepare("SELECT COUNT(*) c FROM executions WHERE task_id=?").get(id)).toEqual({ c: 0 })
  })

  it("POST /:id/ready rejects non-draft with 409", async () => {
    const id = insertTask(db, { name: "E2E_TD_ready_reject", status: "ready" })
    const res = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    expect(res.status).toBe(409)
  })

  // ── AC4 (票03): abort ────────────────────────────────────────────────

  it("POST /:id/abort (running) → 实例行 aborted + tasks.status=aborted + SSE，不碰 schedule 表", async () => {
    const id = insertTask(db, { name: "E2E_TD_abort", status: "running" })
    // 该任务的活实例（票03：一次运行就是一行 executions，parent_id='0' 即根）。
    const execId = seedInstanceRow(db, id, "running")
    const res = await app.request(`/api/tasks/${id}/abort`, { method: "POST" })
    expect(res.status).toBe(200)
    const task = await json<{ status: string }>(res)
    expect(task.status).toBe("aborted")
    expect(readTaskStatus(db, id).status).toBe("aborted")
    // 闩锁自己松开：行进入终态即不再占这个任务的槽位。
    expect(
      db.prepare("SELECT status FROM executions WHERE id = ?").get(execId),
    ).toEqual({ status: "aborted" })
    // 「所有子作业」不再是遍历 origin_id 找信封 —— 中止一个任务只停它自己的实例。
    expect(scheduleTableCounts(db)).toEqual({ schedules: 0, executions: 0, workspaces: 0 })
    expect(taskEvents).toContainEqual({ task_id: id, status: "aborted" })
  })

  it("POST /:id/abort — 排队中(pending)的实例被 retire，不是被 engine cancel", async () => {
    const id = insertTask(db, { name: "E2E_TD_abort_queued", status: "ready" })
    const execId = seedInstanceRow(db, id, "pending")
    const res = await app.request(`/api/tasks/${id}/abort`, { method: "POST" })
    expect(res.status).toBe(200)
    expect(
      db.prepare("SELECT status FROM executions WHERE id = ?").get(execId),
    ).toEqual({ status: "aborted" })
  })

  it("POST /:id/abort rejects non-running/non-ready with 409", async () => {
    const id = insertTask(db, { name: "E2E_TD_abort_reject", status: "done" })
    const res = await app.request(`/api/tasks/${id}/abort`, { method: "POST" })
    expect(res.status).toBe(409)
  })

  // ── Delete (票03 §5): 软删任务，级联清信封那一步随信封一起消失 ──────────
  //
  // 旧版这里有「DELETE cascade-reaps child schedules (origin_type=task)」——它守的是
  // R-INT「origin_id 无 FK，应用层是唯一防线」。票03 之后任务没有私有定义行可漏，
  // 该回归问题不再成立（orphan-reaper.ts 同批删除），所以只保留「运行历史随任务
  // 软删而留存」这条新事实。

  it("DELETE /:id 软删任务；它的运行历史留在 executions（没有信封可级联清）", async () => {
    const id = insertTask(db, { name: "E2E_TD_reap", status: "ready" })
    const execId = seedInstanceRow(db, id, "completed")
    const res = await app.request(`/api/tasks/${id}`, { method: "DELETE" })
    expect(res.status).toBe(200)
    expect(taskDAO.getById(id)).toBeNull()
    expect(db.prepare("SELECT COUNT(*) c FROM executions WHERE id = ?").get(execId)).toEqual({ c: 1 })
    expect(scheduleTableCounts(db)).toEqual({ schedules: 0, executions: 0, workspaces: 0 })
  })
})
