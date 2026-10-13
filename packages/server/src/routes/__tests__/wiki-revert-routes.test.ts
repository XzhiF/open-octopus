import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { spawnSync } from "child_process"
import fs from "fs"
import path from "path"
import os from "os"
import { Hono } from "hono"
import { applySchema } from "../../db/schema"
import { createWikiRevertRoutes } from "../wiki-revert"
import { RevertTaskService } from "../../services/knowledge/wiki/revert"
import { RawIngestService } from "../../services/knowledge/raw"
import { CuratorCompileService } from "../../services/knowledge/wiki/curator"
import { CuratorTaskService } from "../../services/knowledge/wiki/curator-task"
import type { GitRunner } from "../../services/knowledge/wiki/wiki-git"

/**
 * 票12 · S2 revert 路由契约（spec §知识中心 UI「回滚」；票面 AC5）：
 *   POST /api/knowledge/wiki/revert { commit } → 202 回执（rvt-… 任务，经票06 全局队列
 *   opKind="revert" 串行执行）；GET /revert/task/:id → 状态流转 queued→running→committed/failed。
 *   committed 后断言四同步：git 单 revert commit / 页文件回退 / INDEX 重建 /
 *   LOG 追加 `## [date] revert | …` 行且原 compile 行随回退消失 / DB+FTS 与盘一致。
 * 错误码面：INVALID_PARAM 400（缺参/坏形）· NOT_FOUND 404（目标 commit 不存在/任务不存在）·
 *   任务级 failed 码：REVERT_CONFLICT（后续提交与回退互斥）· LOCK_HELD（锁占用，注入锁）。
 * 全栈装配同票05 先例：真 fs tmpdir + in-memory DB + 真 git + mock LLM seam。
 */

const FROZEN_NOW = () => new Date("2026-10-13T08:00:00.000Z")
const realGit = (cwd: string, source = "curate"): GitRunner => ({
  run(args: string[]) {
    const r = spawnSync("git", args, { cwd, timeout: 30000, env: { ...process.env, OCTOPUS_WIKI_COMMIT_SOURCE: source } })
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

async function waitCompile(svc: CuratorTaskService, id: string): Promise<any> {
  const t0 = Date.now()
  for (;;) {
    const rec = svc.get(id)
    if (rec?.status === "committed") return rec
    if (rec?.status === "failed") throw new Error(`compile ${id} failed: ${rec.error?.code} ${rec.error?.message}`)
    if (Date.now() - t0 > 60_000) throw new Error(`compile ${id} timeout`)
    await new Promise(r => setTimeout(r, 40))
  }
}

async function waitRevert(svc: RevertTaskService, id: string): Promise<any> {
  const t0 = Date.now()
  for (;;) {
    const rec = svc.get(id)
    if (!rec) throw new Error(`revert task ${id} missing`)
    if (rec.status === "committed" || rec.status === "failed") return rec
    if (Date.now() - t0 > 60_000) throw new Error(`revert ${id} timeout in ${rec.status}`)
    await new Promise(r => setTimeout(r, 40))
  }
}

describe("revert 路由 — 票12 S2", () => {
  let db: Database.Database
  let tmpDir: string
  let root: string
  let wikiRoot: string
  let git: GitRunner
  let rawIngest: RawIngestService
  let compileTasks: CuratorTaskService
  let revertTasks: RevertTaskService
  let app: Hono

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-revert-api-"))
    root = path.join(tmpDir, "knowledge")
    wikiRoot = path.join(root, "wiki")
    git = realGit(wikiRoot)
    rawIngest = new RawIngestService({ root, now: FROZEN_NOW })
    compileTasks = new CuratorTaskService({
      root,
      run: async (rawPath) => {
        const curator = new CuratorCompileService({ db, root, llm: async () => PLAN, now: FROZEN_NOW, git: realGit(wikiRoot) })
        return curator.compileRaw(curator.resolveRawPointer(rawPath))
      },
    })
    revertTasks = new RevertTaskService({ db, root, git, now: FROZEN_NOW })
    app = new Hono()
    app.route("/api/knowledge/wiki", createWikiRevertRoutes(revertTasks))
  })

  afterEach(() => {
    db?.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /** 真编译一次产出可回滚 commit（票05 全栈先例：投喂→编译→committed）。 */
  async function compileOnce(): Promise<{ commit: string; rawPath: string }> {
    const res = rawIngest.ingestText({ text: "# Doc\n\n内容甲乙丙。\n", title: "API Doc" })
    const t = compileTasks.submit(res.raw.path)
    const done = await waitCompile(compileTasks, t.id)
    return { commit: done.result.commit, rawPath: res.raw.path }
  }

  it("POST /revert 回滚编译 commit：单 revert commit + 页文件回退 + INDEX/LOG/FTS 重同步（AC5 主链）", async () => {
    const { commit, rawPath } = await compileOnce()
    // 回滚前盘/库现状（回滚后必须反转）
    expect(fs.existsSync(path.join(wikiRoot, "concepts", "con-a.md"))).toBe(true)
    const logBefore = fs.readFileSync(path.join(wikiRoot, "LOG.md"), "utf-8")

    const resp = await app.request("/api/knowledge/wiki/revert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commit }),
    })
    expect(resp.status).toBe(202)
    const ack = await resp.json() as any
    expect(ack.taskId).toMatch(/^rvt-/)
    expect(ack.commit).toBe(commit)
    expect(ack.status).toBe("queued")

    const done = await waitRevert(revertTasks, ack.taskId)
    expect(done.status).toBe("committed")
    expect(done.result.target).toBe(commit)
    expect(done.result.revertCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(done.result.revertCommit).not.toBe(commit)
    // 触及清单：三个页 + sources 回执页都标 removed（INDEX/LOG 不进页清单）
    const paths = done.result.touched.map((t: any) => t.path)
    for (const p of ["concepts/con-a.md", "entities/ent-b.md", "topics/top-c.md"]) {
      expect(paths).toContain(p)
      const hit = done.result.touched.find((t: any) => t.path === p)
      expect(hit.action).toBe("removed")
    }

    // GET /revert/task/:id 形状与 registry 记录一致
    const get = await app.request(`/api/knowledge/wiki/revert/task/${ack.taskId}`)
    expect(get.status).toBe(200)
    const rec = await get.json() as any
    expect(rec.task.status).toBe("committed")
    expect(rec.task.commit).toBe(commit)

    // ── 四同步断言 ──
    // git：线性史 + revert commit 在最顶（独立真相源：票面「git revert 单 commit」）
    const log = git.run(["log", "--format=%H %s"]).stdout.trim().split("\n")
    expect(log[0].split(" ")[0]).toBe(done.result.revertCommit)
    expect(log[0]).toMatch(/revert: [0-9a-f]{7,}/)
    // fs：编译产物回退（页删、raw 不动——不可变源零触碰）
    expect(fs.existsSync(path.join(wikiRoot, "concepts", "con-a.md"))).toBe(false)
    expect(fs.existsSync(path.join(wikiRoot, "sources", "2026-10-13-api-doc.md"))).toBe(false)
    expect(fs.existsSync(path.join(root, rawPath))).toBe(true)
    // INDEX 重建：不再含回退掉的页
    const index = fs.readFileSync(path.join(wikiRoot, "INDEX.md"), "utf-8")
    expect(index).not.toContain("con-a")
    // LOG：原编译落盘行随回退消失（策展批通道 LOG 行 action=ingest，票05 契约）
    // + 追加 revert 行（行格式 grep 前缀契约，票11 读面 fixture 同形）
    const logAfter = fs.readFileSync(path.join(wikiRoot, "LOG.md"), "utf-8")
    const compileRow = logBefore.split("\n").find(l => l.startsWith("## [") && l.includes("ingest |"))
    expect(compileRow).toBeTruthy()
    expect(logAfter).not.toContain(compileRow!)
    expect(logAfter).toMatch(/^## \[2026-10-13\] revert \| compile [0-9a-f]{7,}$/m)
    expect(logAfter).toContain("→ 回滚本次编译 · git revert · owner ✓")
    // DB + FTS 与盘一致：三页行消失、FTS 查不到页内容
    const articles = db.prepare("SELECT id FROM wiki_articles WHERE org='global' AND id IN ('con-a','ent-b','top-c')").all()
    expect(articles).toEqual([])
    const fts = db.prepare("SELECT rowid FROM wiki_fts WHERE wiki_fts MATCH '概念A'").all()
    expect(fts).toEqual([])
  })

  it("错误码面：INVALID_PARAM 400（非 JSON/缺 commit/坏形）、NOT_FOUND 404（目标不存在/任务不存在）", async () => {
    let resp = await app.request("/api/knowledge/wiki/revert", { method: "POST", headers: { "content-type": "application/json" }, body: "not-json" })
    expect(resp.status).toBe(400)
    expect(((await resp.json()) as any).error.code).toBe("INVALID_PARAM")

    resp = await app.request("/api/knowledge/wiki/revert", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) })
    expect(resp.status).toBe(400)
    expect(((await resp.json()) as any).error.code).toBe("INVALID_PARAM")

    resp = await app.request("/api/knowledge/wiki/revert", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ commit: "not-a-hash" }) })
    expect(resp.status).toBe(400)
    expect(((await resp.json()) as any).error.code).toBe("INVALID_PARAM")

    // 形状合法但仓内不存在 ⇒ 404（目标 commit 不存在，同步校验、不建任务）
    resp = await app.request("/api/knowledge/wiki/revert", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ commit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }) })
    expect(resp.status).toBe(404)
    expect(((await resp.json()) as any).error.code).toBe("NOT_FOUND")
    expect(revertTasks.list().length).toBe(0)

    const g = await app.request("/api/knowledge/wiki/revert/task/does-not-exist")
    expect(g.status).toBe(404)
    expect(((await g.json()) as any).error.code).toBe("NOT_FOUND")
  })

  it("后续提交与回退互斥 ⇒ 任务 failed REVERT_CONFLICT，工作区不留半成品（git revert --abort）", async () => {
    const { commit } = await compileOnce()
    // 再提交一次同页改动（真编译第二路会 dedup——这里用 curator 通道改页后人工提交模拟后写冲突）
    fs.appendFileSync(path.join(wikiRoot, "concepts", "con-a.md"), "\n后续人工补充。\n")
    mustOk(git.run(["add", "-A"]))
    mustOk(git.run(["commit", "-m", "manual: 补充 con-a"]))
    expect(git.run(["status", "--porcelain"]).stdout.trim()).toBe("")

    const resp = await app.request("/api/knowledge/wiki/revert", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ commit }),
    })
    expect(resp.status).toBe(202)
    const ack = await resp.json() as any
    const done = await waitRevert(revertTasks, ack.taskId)
    expect(done.status).toBe("failed")
    expect(done.error?.code).toBe("REVERT_CONFLICT")
    // 工作区回正：仍在 manual 补充后的 HEAD，页文件未半删半改
    expect(git.run(["status", "--porcelain"]).stdout.trim()).toBe("")
    expect(fs.readFileSync(path.join(wikiRoot, "concepts", "con-a.md"), "utf-8")).toContain("后续人工补充")
  })

  it("锁占用 ⇒ 任务 failed LOCK_HELD（票06 跨进程保底，注入即拒锁）", async () => {
    const { commit } = await compileOnce()
    // 真队列 + 即拒锁注入（WikiLock 占用者活跳且心跳未衰的形态），走完整执行链
    const { CompileQueue } = await import("../../services/knowledge/wiki/compile-queue")
    const rejecting = new CompileQueue({
      lock: { acquire: async () => { throw Object.assign(new Error("LOCK_HELD: 锁被占用"), { code: "LOCK_HELD" }) } },
    })
    const svc = new RevertTaskService({ db, root, git, now: FROZEN_NOW, queue: rejecting })
    // 同步校验（commit 在仓）通过后仍建任务——占用在执行段显形为任务级 failed
    const t = svc.revert(commit)
    expect(t.status).toBe("queued")
    const done = await waitRevert(svc, t.id)
    expect(done.status).toBe("failed")
    expect(done.error?.code).toBe("LOCK_HELD")
  })
})

function mustOk(r: { status: number; stderr?: string }) {
  if (r.status !== 0) throw new Error(`git failed: ${r.stderr ?? ""}`)
}
