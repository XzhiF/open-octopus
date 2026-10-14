import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { spawnSync } from "child_process"
import fs from "fs"
import path from "path"
import os from "os"
import { Hono } from "hono"
import { applySchema } from "../../db/schema"
import { createWikiCompileRoutes } from "../wiki-compile"
import { createIngestRoutes } from "../ingest"
import { RawIngestService } from "../../services/knowledge/raw"
import { CuratorCompileService } from "../../services/knowledge/wiki/curator"
import { CuratorTaskService } from "../../services/knowledge/wiki/curator-task"
import type { GitRunner } from "../../services/knowledge/wiki/wiki-git"

/**
 * 票05 · S2 路由契约（spec §Testing Decisions S2 行「ingest/编译任务 API」）：
 * 投喂→编译任务状态流转（排队中 queued → 编译中 compiling → 已提交 committed / 失败 failed）
 * + 错误码（errorResponse 形状 {error:{code,message}}）。
 * 全栈装配：真 fs tmpdir + in-memory DB + 真 git + mock LLM seam——路由不打桩服务，
 * 打的是**真实编译**（薄 registry 语义 = 契约面）。
 */

const FROZEN_NOW = () => new Date("2026-10-13T08:00:00.000Z")
const realGit = (cwd: string): GitRunner => ({
  run(args: string[]) {
    const r = spawnSync("git", args, { cwd, timeout: 30000, env: { ...process.env, OCTOPUS_WIKI_COMMIT_SOURCE: "curate" } })
    return { status: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
  },
})

const PLAN = JSON.stringify({
  pages: [
    { op: "create", type: "concept", id: "con-a", title: "概念A", summary: "sA", body: "## 定义\n甲。\n" },
    { op: "create", type: "entity", id: "ent-b", title: "实体B", summary: "sB", entity_kind: "tool", body: "## 概述\n乙。\n" },
    { op: "create", type: "topic", id: "top-c", title: "主题C", summary: "sC", stability: "stable", body: "## 硬约束\n- 纪律丙 <!--#oct-NEW-->\n" },
  ],
  key_points: ["要点一"],
  contradictions: [],
})

async function waitStatus(svc: CuratorTaskService, id: string, want: "committed" | "failed", timeoutMs = 60_000): Promise<any> {
  const t0 = Date.now()
  for (;;) {
    const rec = svc.get(id)
    if (rec && (rec.status === want || rec.status === "committed" || rec.status === "failed")) {
      if (rec.status === want) return rec
      throw new Error(`task ${id} ended ${rec.status} (wanted ${want}): ${rec.error?.code} ${rec.error?.message}`)
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`task ${id} timeout in ${svc.get(id)?.status}`)
    await new Promise(r => setTimeout(r, 50))
  }
}

describe("编译任务路由 — 票05 S2", () => {
  let db: Database.Database
  let tmpDir: string
  let root: string
  let rawIngest: RawIngestService
  let tasks: CuratorTaskService
  let app: Hono

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-compile-api-"))
    root = path.join(tmpDir, "knowledge")
    rawIngest = new RawIngestService({ root, now: FROZEN_NOW })
    tasks = new CuratorTaskService({
      root,
      run: async (rawPath) => {
        const curator = new CuratorCompileService({ db, root, llm: async () => PLAN, now: FROZEN_NOW, git: realGit(path.join(root, "wiki")) })
        return curator.compileRaw(curator.resolveRawPointer(rawPath))
      },
    })
    app = new Hono()
    app.route("/api/knowledge/wiki", createWikiCompileRoutes(tasks))
    app.route("/api/knowledge", createIngestRoutes(rawIngest, (p) => {
      const t = tasks.submit(p)
      return { taskId: t.id, status: t.status }
    }))
  })

  afterEach(() => {
    db?.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function seedRaw(): Promise<string> {
    const res = rawIngest.ingestText({ text: "# Doc\n\n内容甲乙丙。\n", title: "API Doc" })
    return res.raw.path
  }

  it("POST /compile returns task id with queued status; task reaches committed with result", async () => {
    const rawPath = await seedRaw()
    const resp = await app.request("/api/knowledge/wiki/compile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: rawPath }),
    })
    expect(resp.status).toBe(202)
    const body = await resp.json() as any
    expect(typeof body.taskId).toBe("string")
    expect(body.status).toBe("queued")

    const done = await waitStatus(tasks, body.taskId, "committed")
    expect(done.status).toBe("committed")
    expect(done.result?.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(done.result?.touched.length).toBeGreaterThanOrEqual(3)

    // 状态可查（GET）——响应形状与 registry 记录一致
    const get = await app.request(`/api/knowledge/wiki/compile/task/${body.taskId}`)
    expect(get.status).toBe(200)
    const rec = await get.json() as any
    expect(rec.task.status).toBe("committed")
    expect(rec.task.rawPath).toBe(rawPath)
    expect(rec.task.result.touched.map((t: any) => t.path)).toContain("concepts/con-a.md")

    // 编译真落盘（四同步的 fs 面）
    expect(fs.existsSync(path.join(root, "wiki", "sources", "2026-10-13-api-doc.md"))).toBe(true)
  })

  it("POST /compile validates params and raw existence（错误码面）", async () => {
    let resp = await app.request("/api/knowledge/wiki/compile", { method: "POST", headers: { "content-type": "application/json" }, body: "not-json" })
    expect(resp.status).toBe(400)
    expect(((await resp.json()) as any).error.code).toBe("INVALID_PARAM")

    resp = await app.request("/api/knowledge/wiki/compile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) })
    expect(resp.status).toBe(400)
    expect(((await resp.json()) as any).error.code).toBe("INVALID_PARAM")

    resp = await app.request("/api/knowledge/wiki/compile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "raw/inbox/no-such.md" }) })
    expect(resp.status).toBe(404)
    expect(((await resp.json()) as any).error.code).toBe("NOT_FOUND")

    // 逃逸路径（../ 越出 raw/）→ 400
    resp = await app.request("/api/knowledge/wiki/compile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "raw/../secret.md" }) })
    expect(resp.status).toBe(400)

    const g = await app.request("/api/knowledge/wiki/compile/task/does-not-exist")
    expect(g.status).toBe(404)
    expect(((await g.json()) as any).error.code).toBe("NOT_FOUND")
  })

  it("compile failure ends the task in failed with stable error code（零半成品由编译通道保证）", async () => {
    const rawPath = await seedRaw()
    const badTasks = new CuratorTaskService({
      root,
      run: async (p) => {
        const curator = new CuratorCompileService({ db, root, llm: async () => "garbage not json", now: FROZEN_NOW, git: realGit(path.join(root, "wiki")) })
        return curator.compileRaw(curator.resolveRawPointer(p))
      },
    })
    const t = badTasks.submit(rawPath)
    expect(t.status).toBe("queued")
    const done = await waitStatus(badTasks, t.id, "failed")
    expect(done.status).toBe("failed")
    expect(done.error?.code).toBe("CURATOR_LLM_JSON")
    expect(done.error?.message).toBeTruthy()
  })

  it("POST /ingest with compile=true returns both the raw pointer and the task id（投喂即入编译）", async () => {
    const resp = await app.request("/api/knowledge/ingest?compile=true", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "text", text: "# Doc2\n\n丁。\n", title: "Doc Two" }),
    })
    expect(resp.status).toBe(200)
    const body = await resp.json() as any
    expect(body.raw.path).toBe("raw/inbox/2026-10-13-doc-two.md")
    expect(body.compileTask).toBeDefined()
    expect(body.compileTask.status).toBe("queued")

    const done = await waitStatus(tasks, body.compileTask.taskId, "committed")
    expect(done.result?.rawHash).toBe(body.raw.hash)

    // 不带 compile=true：票02 原契约不变（无 compileTask 字段）
    const plain = await app.request("/api/knowledge/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "text", text: "# Doc3\n\n戊。\n", title: "Doc Three" }),
    })
    const plainBody = await plain.json() as any
    expect(plainBody.compileTask).toBeUndefined()
  })

  it("re-submitting an already-compiled raw completes as deduped no-op（幂等跨任务可见）", async () => {
    const rawPath = await seedRaw()
    const t1 = tasks.submit(rawPath)
    await waitStatus(tasks, t1.id, "committed")
    const t2 = tasks.submit(rawPath)
    const done = await waitStatus(tasks, t2.id, "committed")
    expect(done.result.deduped).toBe(true)
    expect(done.result.commit).toBeNull()
    expect(done.result.changed).toBe(false)
  })

  it("D-kc15-1 重试编译入口：failed 后 POST /compile 同 path ⇒ 202 建新任务并达 committed（票07 S2 契约）", async () => {
    // 「重试编译」按钮打的 HTTP 面 = 既有 POST /compile（ingest-compile 队列通道复用，
    // 红线2 禁旁路直写）。契约钉：failed 不锁死该 raw——重投建新任务、可查、真编译到提交。
    let goodMode = false
    const retryTasks = new CuratorTaskService({
      root,
      run: async (p) => {
        const curator = new CuratorCompileService({
          db, root,
          llm: async () => (goodMode ? PLAN : "乱码，无 JSON"),
          now: FROZEN_NOW,
          git: realGit(path.join(root, "wiki")),
        })
        return curator.compileRaw(curator.resolveRawPointer(p))
      },
    })
    const retryApp = new Hono()
    retryApp.route("/api/knowledge/wiki", createWikiCompileRoutes(retryTasks))

    const post = async () => retryApp.request("/api/knowledge/wiki/compile", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: rawPath }),
    })
    const rawPath = await seedRaw()

    const ack1 = await (await post()).json() as any
    const f1 = await waitStatus(retryTasks, ack1.taskId, "failed")
    expect(f1.status).toBe("failed")

    // 重试入口可达：同 path 再 POST ⇒ 202 新任务（入口不因曾败而拒收/锁死）
    goodMode = true
    const resp2 = await post()
    expect(resp2.status).toBe(202)
    const ack2 = await resp2.json() as any
    expect(ack2.taskId).not.toBe(ack1.taskId)
    expect(ack2.status).toBe("queued")

    const done = await waitStatus(retryTasks, ack2.taskId, "committed")
    expect(done.result?.deduped).toBe(false) // 失败回滚无回执页 ⇒ 重试走真编译（非 dedup 空转）
    expect(done.result?.commit).toMatch(/^[0-9a-f]{40}$/)
  })
})
