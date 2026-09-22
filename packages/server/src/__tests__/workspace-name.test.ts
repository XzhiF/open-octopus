// workspace-name.test.ts — 禁中文命名收口 (2026-09-20)
//
// workspaces.name 直接进磁盘目录名 / config.json / git 分支名，非 ASCII 目录是
// Node cpSync 猝死 (0xC0000409) 的事故土壤。web 表单早已拦（NAME_PATTERN），本
// 文件钉住服务端收口：POST / 、POST /import 、PUT 改名三条手动路径一律 400，
// service.create 内部 assert 兜底。
//
// 正向 201 会真建目录 + 铺 scaffold（对测试环境敏感），故正向只验「名字过关」
// 这一层（用不存在的 org 触发下一道 400）；成功链路归 dev 手测。
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { OrgDAO, WorkspaceDAO } from "../db/dao"
import { WorkspaceService } from "../services/workspace"
import { createWorkspaceRoutes } from "../routes/workspace"
import { WorkspaceNameSchema, WORKSPACE_NAME_PATTERN } from "@octopus/shared"

const ORG = "e2e-td-wsname"

let db: Database.Database
let app: Hono
let service: WorkspaceService

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  db.prepare(`INSERT INTO orgs (name, path, created_at) VALUES (?, ?, datetime('now'))`).run(
    ORG, `~/.octopus/orgs/${ORG}`,
  )
  const wsDAO = new WorkspaceDAO(db)
  service = new WorkspaceService(wsDAO)
  app = new Hono()
  app.route("/api/workspaces", createWorkspaceRoutes(service, new OrgDAO(db), wsDAO))
})

afterAll(() => {
  db.close()
})

describe("schema 本身", () => {
  it("合法/非法名分界与 web 表单规则同源", () => {
    expect(WORKSPACE_NAME_PATTERN.test("my_ws-1")).toBe(true)
    expect(WORKSPACE_NAME_PATTERN.test("中文")).toBe(false)
    expect(WORKSPACE_NAME_PATTERN.test("has space")).toBe(false)
    expect(WORKSPACE_NAME_PATTERN.test("task:colon")).toBe(false)
    expect(WorkspaceNameSchema.safeParse("task-agent-context-0829-164512").success).toBe(true)
  })
})

describe("POST /api/workspaces — 手动创建", () => {
  it("中文 name → 400，错误信息说明合法字符集", async () => {
    const res = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "我的工作区", org: ORG }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain("仅支持英文字母")
  })

  it("带空格/冒号的名字同样 400", async () => {
    const res = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "task: my ws", org: ORG }),
    })
    expect(res.status).toBe(400)
  })

  it("合法名通过校验（下一道 org 检查才拦下 —— 证明 name gate 已放行，且不留磁盘痕迹）", async () => {
    const res = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ok_ws-1", org: "e2e-td-wsname-nope" }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain("Org")
  })
})

describe("POST /api/workspaces/import + PUT /:id — import 与改名同规矩", () => {
  it("import 中文名 → 400（先于 fs 检查）", async () => {
    const res = await app.request("/api/workspaces/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "存量中文", org: ORG }),
    })
    expect(res.status).toBe(400)
  })

  it("PUT 改名为中文 → 400（先于 404 —— 校验在存在性之前）", async () => {
    const res = await app.request("/api/workspaces/ws-not-exist", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "改成中文" }),
    })
    expect(res.status).toBe(400)
  })

  it("PUT 合法改名不触发 400（走到存在性 → 404）", async () => {
    const res = await app.request("/api/workspaces/ws-not-exist", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "good-name" }),
    })
    expect(res.status).toBe(404)
  })
})

describe("WorkspaceService.create — 内部保险（防绕过 route 的新调用方）", () => {
  it("中文名直接进 service → throw，且在触盘之前", () => {
    expect(() =>
      service.create({ name: "中文名", org: ORG, path: "/tmp/does-not-matter-e2e-td" }),
    ).toThrow(/名称非法/)
  })
})
