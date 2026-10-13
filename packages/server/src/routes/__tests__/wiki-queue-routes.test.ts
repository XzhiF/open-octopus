import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../../db/schema"
import { WikiArticleDAO } from "../../db/dao/wiki-article-dao"
import { CompileQueue } from "../../services/knowledge/wiki/compile-queue"
import { CuratorTaskService } from "../../services/knowledge/wiki/curator-task"
import type { CuratorCompileResult } from "../../services/knowledge/wiki/curator"
import { createCompileQueueRoutes } from "../wiki-queue"
import { createKnowledgeReadRoutes } from "../knowledge-read"
import { createIngestRoutes } from "../ingest"
import { RawIngestService } from "../../services/knowledge/raw"
import { Hono } from "hono"

/**
 * S2 路由契约（票06 AC8：队列可观测 API；spec 故事11「排队中 #N→编译中→已提交」）——
 * wiki-routes.test 先例：形状/错误码钉死，真队列实例（不 mock 队列本体）。
 * queueDepth 契约（票11 冻结）：**只换值不换形**——health 响应字段集零增减。
 */

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function until(cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`until 超时: ${what}`)
    await sleep(10)
  }
}

async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

const stubResult = (rawPath: string): CuratorCompileResult => ({
  rawPath,
  rawHash: "0".repeat(64),
  rawTitle: "t",
  touched: [],
  created: 0,
  updated: 0,
  contradictions: 0,
  findingIds: [],
  commit: null,
  changed: false,
  deduped: true,
  warnings: [],
})

describe("GET /api/knowledge/wiki/queue — 队列深度与位次契约（票06 AC8）", () => {
  let q: CompileQueue
  let app: Hono

  beforeEach(() => {
    q = new CompileQueue()
    app = new Hono()
    app.route("/api/knowledge/wiki", createCompileQueueRoutes(q))
  })

  it("空队列：depth=0 / running=false / tasks=[]", async () => {
    const res = await app.request("/api/knowledge/wiki/queue")
    expect(res.status).toBe(200)
    const data = await jsonOf(res)
    expect(data.depth).toBe(0)
    expect(data.running).toBe(false)
    expect(data.tasks).toEqual([])
  })

  it("排队中 #N → 编译中 → 已提交：位次在队列里逐格流转，API 可查", async () => {
    q.enqueue("ingest-compile", () => sleep(120), { taskId: "w1", label: "raw/inbox/w1.md" })
    q.enqueue("archive-compile", () => sleep(60), { taskId: "w2" })
    q.enqueue("revert", () => sleep(60), { taskId: "w3" })

    // 起跑前：三任务 queued，位次 #1/#2/#3
    let data = await jsonOf(await app.request("/api/knowledge/wiki/queue"))
    expect(data.depth).toBe(3)
    let tasks = data.tasks as Array<{ id: string; state: string; position: number | null; opKind: string }>
    expect(tasks.map(t => [t.id, t.state, t.position])).toEqual([
      ["w1", "queued", 1],
      ["w2", "queued", 2],
      ["w3", "queued", 3],
    ])

    // w1 编译中（position 让位 null），后来者重排 #1/#2
    await until(() => (q.get("w1")?.state === "running"), "w1 开跑")
    data = await jsonOf(await app.request("/api/knowledge/wiki/queue"))
    expect(data.running).toBe(true)
    expect(data.depth).toBe(3)
    tasks = data.tasks as Array<{ id: string; state: string; position: number | null }>
    expect(tasks.find(t => t.id === "w1")).toMatchObject({ state: "running", position: null })
    expect(tasks.filter(t => t.state === "queued").map(t => t.position)).toEqual([1, 2])

    // 排空后终态史仍在（committed），深度归零
    await until(() => q.depth() === 0, "队列排空")
    data = await jsonOf(await app.request("/api/knowledge/wiki/queue"))
    expect(data.depth).toBe(0)
    expect(data.running).toBe(false)
    tasks = data.tasks as Array<{ id: string; state: string; finishedAt?: string }>
    expect(tasks.map(t => [t.id, t.state])).toEqual([["w1", "committed"], ["w2", "committed"], ["w3", "committed"]])
    expect(tasks[0].finishedAt).toBeTruthy()
  })

  it("GET /queue/task/:id — 单任务可查（含错误码面）；未知 id ⇒ 404 NOT_FOUND 形状", async () => {
    q.enqueue("lint-fix", async () => {
      throw Object.assign(new Error("LINT_FAILED: 超容量"), { code: "LINT_FAILED" })
    }, { taskId: "bad-1" })
    await until(() => q.get("bad-1")?.state === "failed", "任务失败终态")

    const res = await app.request("/api/knowledge/wiki/queue/task/bad-1")
    expect(res.status).toBe(200)
    const task = ((await jsonOf(res)).task) as Record<string, unknown>
    expect(task.id).toBe("bad-1")
    expect(task.state).toBe("failed")
    expect(task.error).toMatchObject({ code: "LINT_FAILED" })

    const miss = await app.request("/api/knowledge/wiki/queue/task/nope")
    expect(miss.status).toBe(404)
    expect(await jsonOf(miss)).toEqual({ error: { code: "NOT_FOUND", message: "queue task not found: nope" } })
  })
})

describe("GET /api/knowledge/health — queueDepth 接上实值（票11 冻结契约：只换值不换形）", () => {
  let db: Database.Database
  let tmpDir: string
  let q: CompileQueue

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-health-q-"))
    q = new CompileQueue()
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const healthApp = () => {
    const app = new Hono()
    app.route(
      "/api/knowledge",
      createKnowledgeReadRoutes({ articles: new WikiArticleDAO(db) }, {
        knowledgeRoot: tmpDir,
        getQueueDepth: () => q.depth(),
      }),
    )
    return app
  }

  it("队列有活时 health 报实数；排空回 0；字段集合与票11 契约逐字一致（无新增/缺失、无「待审核」）", async () => {
    const baseline = await jsonOf(await healthApp().request("/api/knowledge/health"))
    expect(baseline.queueDepth).toBe(0)

    q.enqueue("ingest-compile", () => sleep(200), { taskId: "h1" })
    q.enqueue("revert", () => sleep(200), { taskId: "h2" })
    const busy = await jsonOf(await healthApp().request("/api/knowledge/health"))
    expect(busy.queueDepth).toBe(2)

    await until(() => q.depth() === 0, "排空")
    const drained = await jsonOf(await healthApp().request("/api/knowledge/health"))
    expect(drained.queueDepth).toBe(0)

    // 形状冻结：基线键集 == busy 键集（只换值不换形）
    expect(Object.keys(drained).sort()).toEqual(Object.keys(baseline).sort())
    expect(JSON.stringify(baseline)).not.toContain("待审核")
  })

  it("未注入队列（票05/11 测试形态）⇒ queueDepth 稳定零值——票11 契约测试零改动", async () => {
    const app = new Hono()
    app.route("/api/knowledge", createKnowledgeReadRoutes({ articles: new WikiArticleDAO(db) }, { knowledgeRoot: tmpDir }))
    const data = await jsonOf(await app.request("/api/knowledge/health"))
    expect(data.queueDepth).toBe(0)
  })
})

describe("投喂通道零改动：raw 落盘不入队；其触发的编译才入队（票06 AC5 / 票02 通道回归）", () => {
  let tmpDir: string
  let root: string
  let q: CompileQueue
  let app: Hono

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-ingest-q-"))
    root = path.join(tmpDir, "knowledge")
    fs.mkdirSync(path.join(root, "raw", "inbox"), { recursive: true })
    q = new CompileQueue()
    const svc = new CuratorTaskService({
      root,
      queue: q,
      run: async (rawPath) => {
        await sleep(100)
        return stubResult(rawPath)
      },
    })
    app = new Hono()
    app.route("/api/knowledge", createIngestRoutes(new RawIngestService({ root }), (p) => {
      const t = svc.submit(p)
      return { taskId: t.id, status: t.status }
    }))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const postIngest = (compile: boolean) =>
    app.request(`/api/knowledge/ingest${compile ? "?compile=true" : ""}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "text", text: "paste body for queue proof", title: "Queue Proof" }),
    })

  it("不带 compile=true：raw 冻结落盘、全局队列零参与（深度 0、无任务）", async () => {
    const res = await postIngest(false)
    expect(res.status).toBe(200)
    const data = await jsonOf(res)
    expect(data.compileTask).toBeUndefined()
    expect(q.depth()).toBe(0)
    expect(q.list()).toHaveLength(0)
  })

  it("带 compile=true：投喂回执 + 编译以 ingest-compile 入全局队列", async () => {
    const res = await postIngest(true)
    expect(res.status).toBe(200)
    const data = await jsonOf(res)
    const compileTask = data.compileTask as { taskId: string; status: string }
    expect(compileTask.status).toBe("queued")
    expect(compileTask.taskId).toMatch(/^crt-/)
    expect(q.get(compileTask.taskId)?.opKind).toBe("ingest-compile")
    await until(() => q.get(compileTask.taskId)?.state === "committed", "编译经队列落库")
  })
})
