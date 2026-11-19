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

// 文档查看器（2026-11-19 用户 #4）：
//   GET /:id/doc     绝对路径 → { kind, content? }（文本 2MB 上限）
//   GET /:id/doc-raw 图片 / 视频 / 音频字节（Range 支持）
// 放行根 = 本舱 cwd + 本舱任务 workspace；根外 403、相对路径 400、未知扩展 = binary。

describe("/api/cabins doc routes · 聊天产物只读查阅", () => {
  let db: Database.Database
  let app: Hono
  let tmpDir: string
  let cabin: Record<string, any>
  let taskDAO: TaskDAO
  let workspaceDAO: WorkspaceDAO

  beforeEach(async () => {
    db = new Database(":memory:")
    applySchema(db)
    const dao = new CabinDAO(db)
    const sse = new SSEService()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cabin-doc-routes-"))
    const agentSessionDAO = new AgentSessionDAO(db)
    initSessionService(agentSessionDAO)
    taskDAO = new TaskDAO(db)
    workspaceDAO = new WorkspaceDAO(db)
    const svc = new CabinService(dao)
    const initService = new CabinInitService({
      cabin: dao, sse, runOrchestratorTurn: vi.fn(async () => {}),
    })
    svc.bindInfra({
      workspaceService: new WorkspaceService(workspaceDAO),
      workspaceDAO,
      agentSessionDAO,
      taskDAO,
      executionDAO: new ExecutionDAO(db),
      acceptanceDAO: new AcceptanceDAO(db),
      initService,
    })
    app = new Hono()
    app.route("/api/cabins", createCabinRoutes(svc, initService, sse))

    const res = await app.request("/api/cabins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "文档舱", path: path.join(tmpDir, "cabin") }),
    })
    cabin = (await res.json()).cabin
    fs.mkdirSync(path.join(cabin.path, "docs"), { recursive: true })
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const doc = (p: string) =>
    app.request(`/api/cabins/${cabin.id}/doc?path=${encodeURIComponent(p)}`)

  it("md / json / yaml / html 都回文本；html 不特殊处理", async () => {
    fs.writeFileSync(path.join(cabin.path, "docs", "报告.md"), "# 报告\n\n- 结论 3/3")
    fs.writeFileSync(path.join(cabin.path, "docs", "data.json"), '{"a":1}')
    fs.writeFileSync(path.join(cabin.path, "docs", "conf.yaml"), "a: 1\n")
    fs.writeFileSync(path.join(cabin.path, "docs", "page.html"), "<h1>hi</h1>")

    for (const [file, expectText] of [
      ["报告.md", "# 报告"],
      ["data.json", '"a"'],
      ["conf.yaml", "a: 1"],
      ["page.html", "<h1>hi</h1>"],
    ] as const) {
      const res = await doc(path.join(cabin.path, "docs", file))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.kind).toBe("text")
      expect(body.content).toContain(expectText)
      expect(body.ext).toBe(path.extname(file))
      expect(body.path).toBe(path.join(cabin.path, "docs", file))
    }
  })

  it("未知扩展 = binary（无 content）；图片 / 视频回 kind + mime", async () => {
    fs.writeFileSync(path.join(cabin.path, "docs", "blob.bin"), Buffer.from([0, 1, 2, 3]))
    fs.writeFileSync(path.join(cabin.path, "docs", "shot.png"), Buffer.from([137, 80, 78, 71]))
    fs.writeFileSync(path.join(cabin.path, "docs", "clip.mp4"), Buffer.from([0, 0, 0, 24]))

    const bin = await doc(path.join(cabin.path, "docs", "blob.bin"))
    expect((await bin.json()).kind).toBe("binary")
    expect((await doc(path.join(cabin.path, "docs", "blob.bin"))).status).toBe(200)

    const png = await (await doc(path.join(cabin.path, "docs", "shot.png"))).json()
    expect(png).toMatchObject({ kind: "image", mime: "image/png" })
    expect(png.content).toBeUndefined()

    const mp4 = await (await doc(path.join(cabin.path, "docs", "clip.mp4"))).json()
    expect(mp4).toMatchObject({ kind: "video", mime: "video/mp4" })
  })

  it("相对路径 400；根外 403；不存在 404；舱不存在 404", async () => {
    expect((await doc("docs/报告.md")).status).toBe(400)
    const outside = path.join(tmpDir, "outside.md")
    fs.writeFileSync(outside, "# x")
    expect((await doc(outside)).status).toBe(403)
    expect((await doc(path.join(cabin.path, "docs", "nope.md"))).status).toBe(404)
    const res = await app.request(
      `/api/cabins/nope/doc?path=${encodeURIComponent(path.join(cabin.path, "docs", "x.md"))}`,
    )
    expect(res.status).toBe(404)
  })

  it("本舱任务的 workspace 也在放行根里", async () => {
    const wsPath = path.join(tmpDir, "task-ws")
    fs.mkdirSync(wsPath, { recursive: true })
    const now = new Date().toISOString()
    workspaceDAO.insert({
      id: "ws-doc-1", name: "task-ws", repo_group: null, description: "", status: "active",
      path: wsPath, archive_status: null, created_at: now, updated_at: now,
    })
    taskDAO.insert({ id: "task-doc-1", name: "文档任务", cabin_id: cabin.id, workspace_id: "ws-doc-1" })
    const artifact = path.join(wsPath, "artifacts", "report.md")
    fs.mkdirSync(path.dirname(artifact), { recursive: true })
    fs.writeFileSync(artifact, "# 任务产物")

    const res = await doc(artifact)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.kind).toBe("text")
    expect(body.content).toContain("任务产物")
  })

  it("doc-raw 只出媒体字节；支持 Range；非媒体 415", async () => {
    const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    fs.writeFileSync(path.join(cabin.path, "docs", "shot.png"), pngBytes)
    fs.writeFileSync(path.join(cabin.path, "docs", "a.md"), "# x")

    const raw = await app.request(
      `/api/cabins/${cabin.id}/doc-raw?path=${encodeURIComponent(path.join(cabin.path, "docs", "shot.png"))}`,
    )
    expect(raw.status).toBe(200)
    expect(raw.headers.get("content-type")).toBe("image/png")
    expect(raw.headers.get("accept-ranges")).toBe("bytes")
    expect(Buffer.from(await raw.arrayBuffer())).toEqual(pngBytes)

    const ranged = await app.request(
      `/api/cabins/${cabin.id}/doc-raw?path=${encodeURIComponent(path.join(cabin.path, "docs", "shot.png"))}`,
      { headers: { Range: "bytes=2-5" } },
    )
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get("content-range")).toBe(`bytes 2-5/${pngBytes.length}`)
    expect(Buffer.from(await ranged.arrayBuffer())).toEqual(pngBytes.subarray(2, 6))

    const notMedia = await app.request(
      `/api/cabins/${cabin.id}/doc-raw?path=${encodeURIComponent(path.join(cabin.path, "docs", "a.md"))}`,
    )
    expect(notMedia.status).toBe(415)
  })

  it("文本超过 2MB → 413", async () => {
    const big = path.join(cabin.path, "docs", "big.log")
    fs.writeFileSync(big, "x".repeat(2 * 1024 * 1024 + 16))
    expect((await doc(big)).status).toBe(413)
  })
})
