// 舱内事项 API（2026-11-24 用户）：CRUD + 投递 / 关项 / 重开。
//   一条事项 = 零散小待办；投递给主对话即 delivered；人确认「完成 / 搁置」才关项。
//   覆盖：舱内自增序号、未决计数、状态流转时间戳、舱隔离 / 未知 id。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { Hono } from "hono"
import { applySchema } from "../../db/schema"
import {
  CabinDAO, WorkspaceDAO, AgentSessionDAO, TaskDAO, ExecutionDAO, AcceptanceDAO,
} from "../../db/dao"
import { WorkspaceService } from "../../services/workspace"
import { initSessionService } from "../../services/agent/session-service"
import { SSEService } from "../../services/sse"
import { CabinService } from "../../services/cabin/cabin-service"
import { CabinInitService } from "../../services/cabin/cabin-init-service"
import { createCabinRoutes } from "../cabins"

describe("/api/cabins/:id/items", () => {
  let db: Database.Database
  let app: Hono
  let tmpDir: string

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    const dao = new CabinDAO(db)
    const sse = new SSEService()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cabin-items-test-"))
    const agentSessionDAO = new AgentSessionDAO(db)
    initSessionService(agentSessionDAO)
    const svc = new CabinService(dao)
    const initService = new CabinInitService({
      cabin: dao, sse, runOrchestratorTurn: vi.fn(async () => {}),
    })
    svc.bindInfra({
      workspaceService: new WorkspaceService(new WorkspaceDAO(db)),
      workspaceDAO: new WorkspaceDAO(db),
      agentSessionDAO,
      taskDAO: new TaskDAO(db),
      executionDAO: new ExecutionDAO(db),
      acceptanceDAO: new AcceptanceDAO(db),
      initService,
    })
    app = new Hono()
    app.route("/api/cabins", createCabinRoutes(svc, initService, sse))
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const post = (url: string, body?: unknown) =>
    app.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const patch = (url: string, body: unknown) =>
    app.request(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  const del = (url: string) => app.request(url, { method: "DELETE" })

  async function createCabin(name = "事项舱", dir = tmpDir): Promise<string> {
    const res = await post("/api/cabins", { name, path: dir })
    expect(res.status).toBe(201)
    return (await res.json()).cabin.id as string
  }

  async function createItem(cabinId: string, body: Record<string, unknown>) {
    const res = await post(`/api/cabins/${cabinId}/items`, body)
    expect(res.status).toBe(201)
    return (await res.json()).item as Record<string, any>
  }

  it("创建 / 列表 / 编辑：舱内序号自增，未决计数 = todo + delivered", async () => {
    const cabinId = await createCabin()

    const a = await createItem(cabinId, { title: "设置页保存要点两次", kind: "optimize" })
    const b = await createItem(cabinId, { title: "Esc 后焦点丢失", body: "细节", kind: "fix" })
    expect(a.seq).toBe(1)
    expect(b.seq).toBe(2)
    expect(a.status).toBe("todo")
    expect(a.cabin_id).toBe(cabinId)

    const list = await app.request(`/api/cabins/${cabinId}/items`)
    expect(list.status).toBe(200)
    const body = await list.json()
    expect(body.items).toHaveLength(2)
    expect(body.open).toBe(2)

    const edited = await patch(`/api/cabins/${cabinId}/items/${a.id}`, {
      title: "设置页保存一次就生效",
      kind: "idea",
    })
    expect(edited.status).toBe(200)
    const updated = (await edited.json()).item
    expect(updated.title).toBe("设置页保存一次就生效")
    expect(updated.kind).toBe("idea")
    expect(updated.body).toBe("")
  })

  it("投递 → 交付中；关项 → 已完成 / 已搁置（写时间戳）；重开回未决", async () => {
    const cabinId = await createCabin()
    const one = await createItem(cabinId, { title: "时间列太窄" })
    const two = await createItem(cabinId, { title: "头像偶尔不加载" })

    const delivered = await post(`/api/cabins/${cabinId}/items/deliver`, { ids: [one.id, two.id] })
    expect(delivered.status).toBe(200)
    const deliveredRows = (await delivered.json()).items as Array<Record<string, any>>
    expect(deliveredRows.map((row) => row.status)).toEqual(["delivered", "delivered"])
    expect(deliveredRows[0].delivered_at).toBeTruthy()

    const closed = await post(`/api/cabins/${cabinId}/items/close`, {
      ids: [one.id], outcome: "done",
    })
    expect(closed.status).toBe(200)
    const done = (await closed.json()).items[0]
    expect(done.status).toBe("done")
    expect(done.closed_at).toBeTruthy()

    const dropped = await post(`/api/cabins/${cabinId}/items/close`, {
      ids: [two.id], outcome: "dropped",
    })
    expect(dropped.status).toBe(200)
    expect((await dropped.json()).items[0].status).toBe("dropped")

    const list = await app.request(`/api/cabins/${cabinId}/items`)
    expect((await list.json()).open).toBe(0)

    const reopened = await post(`/api/cabins/${cabinId}/items/${one.id}/reopen`)
    expect(reopened.status).toBe(200)
    const openRow = (await reopened.json()).item
    expect(openRow.status).toBe("todo")
    expect(openRow.closed_at).toBeNull()
  })

  it("删除；未知舱 / 未知事项 404；跨舱拿不到别人的事项", async () => {
    const dirA = fs.mkdtempSync(path.join(tmpDir, "a-"))
    const dirB = fs.mkdtempSync(path.join(tmpDir, "b-"))
    const cabinA = await createCabin("A 舱", dirA)
    const cabinB = await createCabin("B 舱", dirB)
    const item = await createItem(cabinA, { title: "A 的事项" })
    await createItem(cabinB, { title: "B 的事项" })

    const listB = await app.request(`/api/cabins/${cabinB}/items`)
    const itemsB = (await listB.json()).items as Array<Record<string, any>>
    expect(itemsB.map((row) => row.title)).toEqual(["B 的事项"])

    const wrongCabin = await patch(`/api/cabins/${cabinB}/items/${item.id}`, { title: "越舱" })
    expect(wrongCabin.status).toBe(404)

    const delRes = await del(`/api/cabins/${cabinA}/items/${item.id}`)
    expect(delRes.status).toBe(200)
    const after = await app.request(`/api/cabins/${cabinA}/items`)
    expect((await after.json()).items).toHaveLength(0)

    const missingCabin = await app.request("/api/cabins/nope/items")
    expect(missingCabin.status).toBe(404)
  })
})
