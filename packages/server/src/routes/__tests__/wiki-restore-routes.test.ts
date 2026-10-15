/**
 * 票09 item-4 S2 — POST /api/knowledge/wiki/restore 路由契约（真 git tmpdir + in-memory DB）。
 * 机制面（回迁/入链反放/INDEX/LOG/DB/commit）由 page-restore.test.ts S1 覆盖；
 * 本面钉 HTTP 契约（与 wiki-retire-routes.test.ts 同款镜像）：
 * 202 ack（taskId res-/status queued/path 回显）、GET /restore/task/:id、
 * 缺口令 400、未知锚点 404 RESTORE_TARGET_MISSING、原位被占 409 RESTORE_TARGET_TAKEN、
 * GET 未知任务 404。校验失败不建任务（svc.list() 空——revert/retire 同律）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Hono } from "hono"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { applySchema } from "../../db/schema"
import { ensureWikiSkeleton } from "../../services/knowledge/wiki/paths"
import { PageRetireTaskService } from "../../services/knowledge/wiki/page-retire"
import { PageRestoreTaskService } from "../../services/knowledge/wiki/page-restore"
import { createWikiRestoreRoutes } from "../wiki-restore"
import type { GitRunner } from "../../services/knowledge/wiki/wiki-git"

const realGit = (cwd: string): GitRunner => ({
  run(args: string[]) {
    const r = spawnSync("git", args, { cwd, timeout: 30000, env: { ...process.env, OCTOPUS_WIKI_COMMIT_SOURCE: "curate" } })
    return { status: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
  },
})

const PAGE = `---
id: top-restore-probe
type: topic
title: 恢复路由探针
summary: S2 契约探针 topic 页
topics: [probe]
links: []
last_compiled: 2026-07-01
sources: [doc:s2]
---

## 硬约束
- 探针纪律 <!--#oct-007-->
`

async function waitSettled<T extends { status: string }>(get: (id: string) => T | undefined, id: string, capMs = 8000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const rec = get(id)
    if (rec && (rec.status === "committed" || rec.status === "failed")) return rec
    if (Date.now() - start > capMs) throw new Error("not settled")
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe("wiki restore 路由 — 票09 S2", () => {
  let db: Database.Database
  let tmpDir: string
  let knowledgeRoot: string
  let wikiRoot: string
  let retireSvc: PageRetireTaskService
  let svc: PageRestoreTaskService
  let app: Hono

  beforeEach(async () => {
    db = new Database(":memory:")
    applySchema(db)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "we09-restore-api-"))
    knowledgeRoot = path.join(tmpDir, "knowledge")
    wikiRoot = path.join(knowledgeRoot, "wiki")
    ensureWikiSkeleton(wikiRoot)
    fs.writeFileSync(path.join(wikiRoot, "topics", "top-restore-probe.md"), PAGE, "utf-8")
    const g = realGit(wikiRoot)
    g.run(["init"]); g.run(["config", "user.email", "t@t.local"]); g.run(["config", "user.name", "t"])
    g.run(["config", "core.autocrlf", "false"]); g.run(["add", "-A"]); g.run(["commit", "-m", "seed"])
    retireSvc = new PageRetireTaskService({ db, root: knowledgeRoot, git: g, now: () => new Date("2026-10-14T09:00:00.000Z") })
    svc = new PageRestoreTaskService({ db, root: knowledgeRoot, git: g, now: () => new Date("2026-10-14T09:00:00.000Z") })
    app = new Hono()
    app.route("/api/knowledge/wiki", createWikiRestoreRoutes(svc))

    // 前置真退役（对话通道同款队列）——恢复对象的来历真实可寻（退役 commit 在史）
    const r = retireSvc.retire({ path: "topics/top-restore-probe.md", source: "auto" })
    await waitSettled<{ status: string }>((id) => retireSvc.get(id), r.id)
  })

  afterEach(() => {
    db?.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("POST /restore {anchor} → 202 {taskId res-, status queued, path 回显}；GET task 终态带 result（fromRetired/restoreCommit/inboundRestored）", async () => {
    const resp = await app.request("/api/knowledge/wiki/restore", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ anchor: "oct-007", reason: "S2 恢复" }),
    })
    expect(resp.status).toBe(202)
    const ack = await resp.json() as { taskId: string; path: string; status: string }
    expect(ack.taskId).toMatch(/^res-/)
    expect(ack.status).toBe("queued")
    expect(ack.path).toBe("topics/top-restore-probe.md")

    const done = await waitSettled((id) => svc.get(id), ack.taskId)
    expect(done.status, JSON.stringify(done.error)).toBe("committed")
    const got = await app.request(`/api/knowledge/wiki/restore/task/${ack.taskId}`)
    expect(got.status).toBe(200)
    const body = await got.json() as { task: { status: string; result?: { fromRetired: string; restoreCommit: string; inboundRestored: string[] } } }
    expect(body.task.result?.fromRetired).toBe("_retired/topics/top-restore-probe.md")
    expect(body.task.result?.restoreCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(fs.existsSync(path.join(wikiRoot, "topics", "top-restore-probe.md"))).toBe(true)
  })

  it("POST /restore 缺口令 → 400 INVALID_PARAM 且不建任务", async () => {
    const resp = await app.request("/api/knowledge/wiki/restore", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "x" }),
    })
    expect(resp.status).toBe(400)
    expect(((await resp.json()) as { error: { code: string } }).error.code).toBe("INVALID_PARAM")
    expect(svc.list()).toHaveLength(0)
  })

  it("POST /restore 非 JSON 对象 → 400 INVALID_PARAM", async () => {
    const resp = await app.request("/api/knowledge/wiki/restore", {
      method: "POST", headers: { "content-type": "application/json" }, body: "[1,2]",
    })
    expect(resp.status).toBe(400)
  })

  it("POST /restore 未知锚点 → 404 RESTORE_TARGET_MISSING（不建任务——幂等缺席拒）", async () => {
    const resp = await app.request("/api/knowledge/wiki/restore", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ anchor: "oct-999" }),
    })
    expect(resp.status).toBe(404)
    expect(((await resp.json()) as { error: { code: string } }).error.code).toBe("RESTORE_TARGET_MISSING")
    expect(svc.list()).toHaveLength(0)
  })

  it("POST /restore 原位被占 → 409 RESTORE_TARGET_TAKEN（退役件原样）", async () => {
    fs.writeFileSync(path.join(wikiRoot, "topics", "top-restore-probe.md"), "---\nid: holder\ntype: topic\ntitle: 占位\nsummary: 占\n---\n\n正文\n", "utf-8")
    const resp = await app.request("/api/knowledge/wiki/restore", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ anchor: "oct-007" }),
    })
    expect(resp.status).toBe(409)
    expect(((await resp.json()) as { error: { code: string } }).error.code).toBe("RESTORE_TARGET_TAKEN")
    expect(fs.existsSync(path.join(wikiRoot, "_retired", "topics", "top-restore-probe.md"))).toBe(true)
  })

  it("GET /restore/task/:id 未知 → 404 NOT_FOUND", async () => {
    const resp = await app.request("/api/knowledge/wiki/restore/task/res-nope")
    expect(resp.status).toBe(404)
  })
})
