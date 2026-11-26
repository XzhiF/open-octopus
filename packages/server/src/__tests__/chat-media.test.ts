// 对话图片字节流（2026-11-26 用户 · 无工具版缩略图）：
//   <img src> 带不了 Authorization，独立挂在 /api/chat-media 鉴权闸外；
//   白名单按会话解析（cwd / workspace / 舱任务目录 / chat-media），只出图片。

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { AgentSessionDAO } from "../db/dao"
import { chatMediaRoots, createChatMediaRoutes } from "../routes/chat-media"

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03])

describe("/api/chat-media/:sessionId/image", () => {
  let db: Database.Database
  let dao: AgentSessionDAO
  let app: Hono
  let tmp: string
  let cwd: string
  const sessionId = "s-1"

  const get = (query: string, id = sessionId) =>
    app.request(`/api/chat-media/${id}/image?${query}`)

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    dao = new AgentSessionDAO(db)
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chat-media-test-"))
    cwd = path.join(tmp, "ws")
    fs.mkdirSync(path.join(cwd, "shots"), { recursive: true })
    fs.writeFileSync(path.join(cwd, "shots", "qr.png"), PNG)
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO sessions (id, title, cwd, created_at, updated_at) VALUES (?,?,?,?,?)",
    ).run(sessionId, "t", cwd, now, now)
    app = new Hono()
    app.route("/api/chat-media", createChatMediaRoutes(dao))
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("会话 cwd 里的图片 → 200 + 正确 Content-Type + 不缓存", async () => {
    const res = await get(`path=${encodeURIComponent(path.join(cwd, "shots", "qr.png"))}`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("image/png")
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG)
  })

  it("未知会话 404；相对路径 400；非图片扩展 415", async () => {
    const file = path.join(cwd, "shots", "qr.png")
    expect((await get(`path=${encodeURIComponent(file)}`, "nope")).status).toBe(404)
    expect((await get(`path=${encodeURIComponent("shots/qr.png")}`)).status).toBe(400)
    expect((await get(`path=${encodeURIComponent(path.join(cwd, "shots", "a.txt"))}`)).status).toBe(415)
  })

  it("白名单外的路径 403；白名单内缺文件 404", async () => {
    const outside = path.join(tmp, "outside.png")
    fs.writeFileSync(outside, PNG)
    expect((await get(`path=${encodeURIComponent(outside)}`)).status).toBe(403)
    expect((await get(`path=${encodeURIComponent(path.join(cwd, "shots", "missing.png"))}`)).status).toBe(404)
  })

  it("chatMediaRoots：cwd / chat-media / 舱任务工作区都在白名单里", () => {
    const now = new Date().toISOString()
    db.prepare("INSERT INTO cabins (id, name, path, created_at, updated_at) VALUES (?,?,?,?,?)")
      .run("c1", "舱", path.join(tmp, "cabin"), now, now)
    db.prepare("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?,?,?,?,?)")
      .run("w-task", "task-ws", path.join(tmp, "task-ws"), now, now)
    db.prepare(
      "INSERT INTO tasks (id, name, status, cabin_id, workspace_id, task_spec, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run("t1", "task", "draft", "c1", "w-task", "{}", now, now)
    db.prepare("UPDATE sessions SET cabin_id = ? WHERE id = ?").run("c1", sessionId)

    const roots = chatMediaRoots(db, dao.findById(sessionId)!)
    const norm = (p: string) => path.resolve(p).toLowerCase()
    expect(roots.map(norm)).toContain(norm(cwd))
    expect(roots.map(norm)).toContain(norm(path.join(os.homedir(), ".octopus", "chat-media", sessionId)))
    expect(roots.map(norm)).toContain(norm(path.join(tmp, "task-ws")))
    expect(roots.map(norm)).toContain(norm(path.join(os.homedir(), ".octopus", "tasks", "t1")))
  })
})
