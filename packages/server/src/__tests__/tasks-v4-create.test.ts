// packages/server/src/__tests__/tasks-v4-create.test.ts
//
// 契约修复 (POST 直建 v4) + home-file GET/PUT (v4 batch spec 审阅/编辑面)。
// 背景: PR #56 把 v4 消费面做齐了，但 POST /api/tasks 丢弃 body.task_spec/
// project_ids —— 而 task-author SKILL §1 与 persona 的 curl 配方都依赖它们。
// 本套件锁死修复后的契约：
//   A. POST 直建: format:"v4" → 201，行 spec 带旗标（无 task_type 键）、
//      project_ids 列、home + context.md + spec.json 快照即带 format。
//   B. POST 校验: 非法 task_spec → 400；非法 project_ids → 400。
//   C. 向后兼容: 不带 task_spec 的 POST 行为与基线 byte 一致（v2/v3 路径零变化，
//      task_type 注入顺序：task_type 赢过 body 伪造）。
//   D. format-stamp: spec-field(phases) 写进无旗标壳 → 自动补 format:"v4" +
//      best-effort 补建 home（否则 readyTask 两头 gate 落空走 legacy）。
//   E. 黄金链: POST 直建 → PUT home-file 写 spec.md → spec-field(phases) →
//      ready 200 + 信封 config.phases 形状（贯通直建与 gate 的端到端）。
// （home-file 守卫矩阵在 tasks-home-file.test.ts。）
//
// Anti-fake-run: real better-sqlite3 + applySchema, 真 Hono app.request, 真 tmp
// task home, E2E_TD_ 前缀, 断言 response body + SQL + fs。

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { AgentSessionDAO } from "../db/dao"
import { SSEService } from "../services/sse"
import { TasksService } from "../services/tasks/tasks-service"
import { createTasksRoutes } from "../routes/tasks"
import { TaskHomeService } from "../services/tasks/task-home-service"
import path from "path"
import os from "os"
import fs from "fs"

const ORG = "e2e-td-v4create"

const WORKFLOW_YAML = `
apiVersion: octopus/v1
kind: Workflow
name: v4-required-flow
inputs:
  idea:
    description: "The idea"
    required: true
  spec_dir:
    description: "Phase spec dir"
    required: true
`

let db: Database.Database
let app: Hono
let tmpDir: string
let taskHome: TaskHomeService

function readTaskRow(id: string): {
  task_spec: string
  project_ids: string
  status: string
  name: string
} {
  return db
    .prepare(`SELECT task_spec, project_ids, status, name FROM tasks WHERE id = ?`)
    .get(id) as { task_spec: string; project_ids: string; status: string; name: string }
}

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  const sse = new SSEService()
  tmpDir = path.join(os.tmpdir(), `test-v4-create-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  taskHome = new TaskHomeService(tmpDir)
  const stubBuiltIn = {
    get(ref: string) {
      if (ref.includes("v4-required-flow")) return { ref, content: WORKFLOW_YAML }
      return null
    },
  } as any
  const service = new TasksService(
    db, sse, new AgentSessionDAO(db), taskHome, undefined, stubBuiltIn,
  )
  app = new Hono()
  app.route("/api/tasks", createTasksRoutes(service, sse))
})

afterAll(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ── A. POST 直建 v4 ────────────────────────────────────────────────

describe("A. POST 直建 v4 draft（契约修复主案）", () => {
  it("A1: {task_spec:{format:'v4'}, project_ids} → 201；spec 带旗标、无 task_type 键、project_ids 落列、home+快照+context.md 全就位", async () => {
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        org: ORG,
        name: "E2E_TD direct-v4",
        task_spec: { format: "v4" },
        project_ids: ["p-alpha"],
        skills: [],
        resources: [],
        authoring_resources: [],
      }),
    })
    expect(res.status).toBe(201)
    const dto = (await res.json()) as { id: string; task_spec: Record<string, unknown>; project_ids: string[] }
    expect(dto.task_spec.format).toBe("v4")
    expect("task_type" in dto.task_spec).toBe(false) // 无 v3 壳
    expect(dto.project_ids).toEqual(["p-alpha"])

    const row = readTaskRow(dto.id)
    expect(JSON.parse(row.task_spec).format).toBe("v4")
    expect(JSON.parse(row.project_ids)).toEqual(["p-alpha"])

    // home 三件套：目录 / spec.json 快照带旗标 / context.md 含项目名
    const home = taskHome.homePath(dto.id)
    expect(fs.existsSync(home)).toBe(true)
    const snapshot = JSON.parse(fs.readFileSync(path.join(home, "spec.json"), "utf-8")) as {
      version: number
      spec: Record<string, unknown>
    }
    expect(snapshot.spec.format).toBe("v4")
    const context = fs.readFileSync(path.join(home, "context.md"), "utf-8")
    expect(context).toContain("p-alpha")
  })

  it("A2: task_spec + task_type 共存 → task_type 注入赢（home 照建，旗标并存）", async () => {
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        org: ORG,
        task_type: "coding",
        task_spec: { format: "v4" },
        preset: { org: ORG, projects: ["p-beta"] },
      }),
    })
    expect(res.status).toBe(201)
    const dto = (await res.json()) as { id: string; task_spec: Record<string, unknown> }
    expect(dto.task_spec.format).toBe("v4")
    expect(dto.task_spec.task_type).toBe("coding")
    expect(fs.existsSync(taskHome.homePath(dto.id))).toBe(true)
    expect(JSON.parse(readTaskRow(dto.id).project_ids)).toEqual(["p-beta"])
  })

  it("A3: session 绑定（D15 会话优先）→ scope_id 反链生效，autosave 命中不另建", async () => {
    const session = db
      .prepare(
        `INSERT INTO sessions (id, org, clone_name, title, scope_id, created_at, updated_at)
         VALUES ('e2e-td-s1', ?, 'task-author', '', NULL, ?, ?)`,
      )
      .run(ORG, new Date().toISOString(), new Date().toISOString())
    expect(session.changes).toBe(1)
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        org: ORG,
        source_chat_session_id: "e2e-td-s1",
        task_spec: { format: "v4" },
      }),
    })
    expect(res.status).toBe(201)
    const dto = (await res.json()) as { id: string }
    const linked = db.prepare("SELECT scope_id FROM sessions WHERE id = 'e2e-td-s1'").get() as {
      scope_id: string
    }
    expect(linked.scope_id).toBe(dto.id)
  })
})

// ── B. POST 校验 ───────────────────────────────────────────────────

describe("B. POST 校验（body 缺陷 = 400）", () => {
  it("B1: task_spec.phases=[] 违反 min(1) → 400", async () => {
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ org: ORG, task_spec: { format: "v4", phases: [] } }),
    })
    expect(res.status).toBe(400)
  })

  it("B2: goal 空串（v4 也不放行 min(1) 违例）→ 400", async () => {
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ org: ORG, task_spec: { goal: "" } }),
    })
    expect(res.status).toBe(400)
  })

  it("B3: project_ids 非字符串数组 → 400（路由 zod parse）", async () => {
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ org: ORG, project_ids: [42] }),
    })
    expect(res.status).toBe(400)
  })

  it("B4: 合法 phases 随 body 直建 → 201 且旗标+phase 全在", async () => {
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        org: ORG,
        task_spec: {
          format: "v4",
          phases: [
            {
              index: 1,
              name: "P1",
              slug: "p1",
              specPath: ".scratch/v4d/p1/spec.md",
              workflowRef: "built-in/v4-required-flow",
              inputValues: { idea: "x", spec_dir: "y" },
            },
          ],
        },
      }),
    })
    expect(res.status).toBe(201)
    const dto = (await res.json()) as { task_spec: { phases: unknown[] } }
    expect(dto.task_spec.phases).toHaveLength(1)
  })
})

// ── C. 向后兼容 ────────────────────────────────────────────────────

describe("C. 向后兼容（旧调用零变化）", () => {
  it("C1: 无 task_spec 的 v2 POST → 基线 {goal:'',ac:[]}、无 home", async () => {
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ org: ORG, name: "E2E_TD legacy-v2" }),
    })
    expect(res.status).toBe(201)
    const dto = (await res.json()) as { id: string; task_spec: Record<string, unknown> }
    expect(dto.task_spec.goal).toBe("")
    expect(dto.task_spec.ac).toEqual([])
    expect("format" in dto.task_spec).toBe(false)
    expect(fs.existsSync(taskHome.homePath(dto.id))).toBe(false)
  })

  it("C2: v3 coding POST（task_type 路径）→ 基线 spec + task_type/skill_groups 注入，home 建", async () => {
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ org: ORG, task_type: "generic", skill_groups: [] }),
    })
    expect(res.status).toBe(201)
    const dto = (await res.json()) as { id: string; task_spec: Record<string, unknown> }
    expect(dto.task_spec.goal).toBe("") // v3 基线不 parse（goal:"" 是合法初值）
    expect(dto.task_spec.task_type).toBe("generic")
    expect(fs.existsSync(taskHome.homePath(dto.id))).toBe(true)
  })
})

// ── D. format-stamp ────────────────────────────────────────────────

describe("D. spec-field(phases) 的 v4 旗标补写（autosave 壳自救）", () => {
  it("D1: 无旗标无 task_type 的壳（autosave 形状）写 phases → format 盖章 + home 补建", async () => {
    // 模拟 autosave 隐式建 draft：直插一行 task_spec='{}' 且无 home
    const id = "e2e-td-d1-shell"
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO tasks (id, org, name, status, task_spec, authoring_resources, resources,
        skills, project_ids, version, created_at, updated_at)
       VALUES (?, ?, 'E2E_TD shell', 'draft', '{}', '[]', '[]', '[]', '[]', 1, ?, ?)`,
    ).run(id, ORG, now, now)
    expect(fs.existsSync(taskHome.homePath(id))).toBe(false)

    const res = await app.request(`/api/tasks/${id}/spec-field`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        field: "phases",
        value: [
          {
            index: 1,
            name: "P1",
            slug: "p1",
            specPath: ".scratch/v4d/p1/spec.md",
            workflowRef: "built-in/v4-required-flow",
            inputValues: { idea: "x", spec_dir: "y" },
          },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const spec = JSON.parse(readTaskRow(id).task_spec)
    expect(spec.format).toBe("v4")
    expect(spec.phases).toHaveLength(1)
    // 补建的 home 立即可承接批次文件
    expect(fs.existsSync(taskHome.homePath(id))).toBe(true)
    const put = await app.request(`/api/tasks/${id}/home-file`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: ".scratch/v4d/p1/spec.md", content: "# D1 skeleton\n" }),
    })
    expect(put.status).toBe(200)
  })

  it("D2: 已是 v4 的行写 phases → 旗标不动（不重复盖章，整数组替换）", async () => {
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ org: ORG, task_spec: { format: "v4" } }),
    })
    const dto = (await res.json()) as { id: string; version: number }
    const put = await app.request(`/api/tasks/${dto.id}/spec-field`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        field: "phases",
        value: [
          {
            index: 1, name: "P1", slug: "p1",
            specPath: ".scratch/v4d/p1/spec.md",
            workflowRef: "built-in/v4-required-flow",
            inputValues: {},
          },
        ],
      }),
    })
    expect(put.status).toBe(200)
    const spec = JSON.parse(readTaskRow(dto.id).task_spec)
    expect(spec.format).toBe("v4")
    expect(spec.phases).toHaveLength(1)
  })
})

// ── E. 黄金链 ──────────────────────────────────────────────────────

describe("E. 黄金链：直建 → home-file 写 spec → phases → ready 物化", () => {
  it("E1: 全链贯通，信封 config 带 format/phases 且 phase1 预载 chain[0]", async () => {
    // ① POST 直建 v4（UI 形状，无 task_type）
    const created = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ org: ORG, name: "E2E_TD golden", task_spec: { format: "v4" } }),
    })
    expect(created.status).toBe(201)
    const dto = (await created.json()) as { id: string }
    const id = dto.id

    // ② PUT home-file 写 phase 的 spec.md（父目录连带建出）
    const specRel = ".scratch/v4d/golden/spec.md"
    const fileRes = await app.request(`/api/tasks/${id}/home-file`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: specRel, content: "# Phase 1: golden\n" }),
    })
    expect(fileRes.status).toBe(200)
    const wr = (await fileRes.json()) as { bytes: number }
    expect(wr.bytes).toBeGreaterThan(0)

    // ③ spec-field(phases) 整数组写回
    const ph = await app.request(`/api/tasks/${id}/spec-field`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        field: "phases",
        value: [
          {
            index: 1, name: "golden", slug: "golden", specPath: specRel,
            workflowRef: "built-in/v4-required-flow",
            inputValues: { idea: "${phase.slug} idea", spec_dir: "${phase.spec_dir}" },
          },
        ],
      }),
    })
    expect(ph.status).toBe(200)

    // ④ ready 过闸 → parked 信封
    const ready = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    expect(ready.status).toBe(200)
    expect(readTaskRow(id).status).toBe("ready")

    const sched = db
      .prepare(`SELECT config FROM schedules WHERE origin_type='task' AND origin_id=? AND origin_role='primary'`)
      .get(id) as { config: string } | undefined
    expect(sched).toBeTruthy()
    const config = JSON.parse(sched!.config)
    expect(config.format).toBe("v4")
    expect(config.phases).toHaveLength(1)
    expect(path.isAbsolute(config.phases[0].specPath) || config.phases[0].specPath.includes("v4d")).toBe(true)
    expect(config.workflow_chain?.[0]).toBeTruthy()
  })
})
