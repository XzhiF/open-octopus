import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { applySchema } from "../../db/schema"
import { FindingsDAO } from "../../db/dao/findings-dao"
import { WikiPatrolService } from "../../services/knowledge/patrol"
import { FindingOpsService } from "../../services/knowledge/findings"
import { BackfillService } from "../../services/knowledge/backfill"
import { CompileQueue } from "../../services/knowledge/wiki/compile-queue"
import { createFindingsRoutes } from "../findings"
import type { GitRunner } from "../../services/knowledge/wiki/wiki-git"

/**
 * 票13 · S2 契约面：findings 列表/裁决 API + 即时体检 + 回填（挂 /api/knowledge）。
 * 真 fs+tmpdir+内存 DB+真 git（裁决链跑真编译）；形状/错误码/降级按票面 S2 断言。
 */

const realGit = (cwd: string): GitRunner => ({
  run(args: string[]) {
    const r = spawnSync("git", args, { cwd, timeout: 30000, env: { ...process.env, OCTOPUS_WIKI_COMMIT_SOURCE: "curate" } })
    return { status: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
  },
})

let db: Database.Database
let tmpDir: string
let root: string
let wikiRoot: string
let queue: CompileQueue
let backfillTriggers: string[]

function writePage(rel: string, id: string, type: string, topics: string[], links: string[], body: string): void {
  const abs = path.join(wikiRoot, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  const linksBlock = links.length > 0 ? `links: [${links.map(l => `[[${l}]]`).join(", ")}]\n` : "links: []\n"
  fs.writeFileSync(abs, [
    "---", `id: ${id}`, `type: ${type}`, `title: ${id} 页`, `summary: ${id} 摘要`,
    `topics: [${topics.join(", ")}]`, "aliases: []", linksBlock + "",
    "last_compiled: 2026-10-12", "sources: []", "---", "", body,
  ].join("\n"), "utf-8")
}

/** 单例路由实例（真装配同律：ops/queue/registry 进程内共享，各请求不换实例）。 */
let appSingleton: ReturnType<typeof buildApp> | null = null
function app() {
  if (!appSingleton) appSingleton = buildApp()
  return appSingleton
}

function buildApp() {
  const patrol = new WikiPatrolService({ db, root })
  const ops = new FindingOpsService({ db, root, queue, git: realGit(wikiRoot) })
  const backfill = new BackfillService({
    root,
    trigger: (rawPath) => { backfillTriggers.push(rawPath); return { taskId: "crt-r1", status: "queued" } },
  })
  return createFindingsRoutes({
    ops,
    patrolNow: () => patrol.patrol(),
    backfill: (input) => backfill.backfill(input),
  })
}

async function waitFor(predicate: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("waitFor 超时")
    await new Promise(r => setTimeout(r, 20))
  }
}

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-fnd-routes-"))
  root = path.join(tmpDir, "knowledge")
  wikiRoot = path.join(root, "wiki")
  fs.mkdirSync(wikiRoot, { recursive: true })
  queue = new CompileQueue()
  backfillTriggers = []
  appSingleton = null
})

afterEach(() => {
  db?.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("GET /findings — 列表契约（状态过滤、camelCase 视图、detail/pages 解形）", () => {
  it("patrol 后列出；status 过滤生效；未知 status ⇒ 400", async () => {
    writePage("concepts/con-a.md", "con-a", "concept", ["knowledge"], [], "## 定义\n\n甲。")
    writePage("concepts/con-b.md", "con-b", "concept", ["knowledge"], [], "## 定义\n\n乙。")
    app()
    await (app()).request("/patrol", { method: "POST" })

    const all = await (await app().request("/findings")).json() as Record<string, unknown>
    expect(all.org).toBe("global")
    const list = all.findings as Array<Record<string, unknown>>
    expect(list.length).toBeGreaterThan(0)
    const xref = list.find(f => f.kind === "missing-xref")!
    expect(xref.status).toBe("open")
    expect(xref.rawRef).toBeDefined()
    expect(xref.createdAt).toBeDefined()
    expect(typeof xref.detail).toBe("object") // JSON 列解形出契约面
    expect(Array.isArray(xref.pages)).toBe(true)
    // P4 票08 分组视图薄扩：每条派生 severity（单源 health-score kind 映射，additive 键）
    expect(xref.severity).toBe("minor")
    for (const f of list) expect(["critical", "major", "minor"]).toContain(f.severity as string)

    const open = await (await app().request("/findings?status=open")).json() as { findings: unknown[] }
    expect(open.findings.length).toBe(list.length)
    const ignored = await (await app().request("/findings?status=ignored")).json() as { findings: unknown[] }
    expect(ignored.findings).toHaveLength(0)
    const bad = await app().request("/findings?status=bogus")
    expect(bad.status).toBe(400)
  })

  it("[忽略] 持久：API 后列表移出 open、进入 ignored；[讨论] 无服务端面（此断言=不存在状态变更端点）", async () => {
    writePage("concepts/con-a.md", "con-a", "concept", [], [], "## 定义\n\n甲。")
    await (app()).request("/patrol", { method: "POST" })
    const list = (await (await app().request("/findings")).json() as { findings: Array<{ id: string; kind: string }> }).findings
    const orphan = list.find(f => f.kind === "orphan")!
    const res = await app().request(`/findings/${orphan.id}/ignore`, { method: "POST" })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body).toMatchObject({ findingId: orphan.id, status: "ignored" })
    expect(new FindingsDAO(db).getById(orphan.id)!.status).toBe("ignored")
  })
})

describe("POST /findings/:id/adopt + GET /findings/fix/task/:id — 裁决即编译回执链", () => {
  it("202 queued → 任务可查至 committed（编译产物落 git）；重复 adopt ⇒ 409；未知 ⇒ 404", async () => {
    writePage("concepts/con-a.md", "con-a", "concept", ["knowledge"], [], "## 定义\n\n甲。")
    writePage("concepts/con-b.md", "con-b", "concept", ["knowledge"], [], "## 定义\n\n乙。")
    await (app()).request("/patrol", { method: "POST" })
    const list = (await (await app().request("/findings")).json() as { findings: Array<{ id: string; kind: string }> }).findings
    const xref = list.find(f => f.kind === "missing-xref")!

    const res = await app().request(`/findings/${xref.id}/adopt`, { method: "POST" })
    expect(res.status).toBe(202)
    const ack = await res.json() as { taskId: string; findingId: string; status: string }
    expect(ack).toMatchObject({ findingId: xref.id, status: "queued" })

    // 任务面轮询至终态（异步编译，队列 setImmediate 起跑）
    let fresh = { task: { status: "queued" as string, result: undefined as { commit: string | null } | undefined } }
    for (let i = 0; i < 60; i++) {
      fresh = await (await app().request(`/findings/fix/task/${ack.taskId}`)).json() as typeof fresh
      if (fresh.task.status === "committed" || fresh.task.status === "failed") break
      await new Promise(r => setTimeout(r, 50))
    }
    expect(fresh.task.status).toBe("committed")
    expect(fresh.task.result?.commit).toMatch(/^[0-9a-f]{40}$/)

    const dup = await app().request(`/findings/${xref.id}/adopt`, { method: "POST" })
    expect(dup.status).toBe(409)
    const err = await dup.json() as { error: { code: string } }
    expect(err.error.code).toBe("FINDING_ALREADY_ADJUDICATED")

    const nf = await app().request("/findings/fnd-0000000000000000/adopt", { method: "POST" })
    expect(nf.status).toBe(404)
    const nfTask = await app().request("/findings/fix/task/fft-nope")
    expect(nfTask.status).toBe(404)
  })
})

describe("POST /patrol — 对话「体检一下」即时触发面", () => {
  it("同步返回报告形状（scanned/counts/newFindings）；findings 落库与 GET 列表一致", async () => {
    writePage("topics/top-x.md", "top-x", "topic", [], ["top-ghost"], "## SOP\n\n引用 [[top-ghost]]。")
    const res = await app().request("/patrol", { method: "POST" })
    expect(res.status).toBe(200)
    const report = await res.json() as Record<string, unknown>
    expect(report.scanned).toMatchObject({ pages: 1 })
    expect(typeof report.counts).toBe("object")
    const created = report.newFindings as unknown[]
    expect(created.length).toBeGreaterThanOrEqual(1)
    const list = (await (await app().request("/findings")).json() as { findings: Array<{ kind: string }> }).findings
    expect(list.filter(f => f.kind === "missing-page")).toHaveLength(1)
  })
})

describe("POST /backfill — 回填卡 [编进 wiki]：摘录落 raw + 编译投递", () => {
  it("202 回执带 raw 指针与 compileTask；raw 头 origin=chat:…（票02 冻结契约）；同文幂等", async () => {
    const res = await app().request("/backfill", {
      method: "POST",
      body: JSON.stringify({ text: "## 排障路径\nCI lockfile 报错先对齐 pnpm 版本再重装。", title: "lockfile 排障", sessionId: "kc-s1" }),
      headers: { "content-type": "application/json" },
    })
    expect(res.status).toBe(202)
    const body = await res.json() as { mode: string; deduped: boolean; raw: { path: string; hash: string; origin: string }; compileTask: { taskId: string; status: string } }
    expect(body.mode).toBe("backfill")
    expect(body.raw.origin).toMatch(/^chat:kc-s1/)
    expect(body.compileTask).toMatchObject({ taskId: "crt-r1", status: "queued" })
    expect(backfillTriggers).toEqual([body.raw.path])

    const abs = path.join(root, body.raw.path)
    expect(fs.existsSync(abs)).toBe(true)
    const rawText = fs.readFileSync(abs, "utf-8")
    expect(rawText).toContain('origin: "chat:kc-s1"')
    expect(rawText).toContain("lockfile 排障")

    // 同文幂等（票02 同 hash 直回指针，不落第二份）
    const again = await app().request("/backfill", {
      method: "POST",
      body: JSON.stringify({ text: "## 排障路径\nCI lockfile 报错先对齐 pnpm 版本再重装。", title: "lockfile 排障", sessionId: "kc-s1" }),
      headers: { "content-type": "application/json" },
    })
    const againBody = await again.json() as { deduped: boolean; raw: { path: string } }
    expect(againBody.deduped).toBe(true)
    expect(againBody.raw.path).toBe(body.raw.path)
  })

  it("空 text ⇒ 400 且 raw 零落盘（失败不留痕，票02 同律）", async () => {
    const res = await app().request("/backfill", {
      method: "POST",
      body: JSON.stringify({ text: "  " }),
      headers: { "content-type": "application/json" },
    })
    expect(res.status).toBe(400)
    const err = await res.json() as { error: { code: string } }
    expect(err.error.code).toBe("INVALID_PARAM")
    const inbox = path.join(root, "raw", "inbox")
    expect(fs.existsSync(inbox) ? fs.readdirSync(inbox) : []).toHaveLength(0)
  })
})
