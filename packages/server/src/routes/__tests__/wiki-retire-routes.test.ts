/**
 * 票08 item-4 S2 — POST /api/knowledge/wiki/retire 路由契约（真 git tmpdir + in-memory DB）。
 * 机制面（页迁/INDEX/LOG/DB/FTS/commit）由 page-retire.test.ts S1 覆盖；本面钉 HTTP 契约：
 * 202 ack（taskId ret-/status queued/path 回显）、GET /retire/task/:id、非法 400、不在册 404。
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
import { createWikiRetireRoutes } from "../wiki-retire"
import type { GitRunner } from "../../services/knowledge/wiki/wiki-git"

const realGit = (cwd: string): GitRunner => ({
  run(args: string[]) {
    const r = spawnSync("git", args, { cwd, timeout: 30000, env: { ...process.env, OCTOPUS_WIKI_COMMIT_SOURCE: "curate" } })
    return { status: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
  },
})

const PAGE = `---
id: ent-widget-b
type: entity
entity_kind: tool
title: 退役路由探针
summary: S2 契约探针实体页
topics: [probe]
links: []
last_compiled: 2026-10-13
sources: [doc:s2]
---

## 节
- 纪律
`

async function waitSettled(svc: PageRetireTaskService, id: string, capMs = 8000) {
  const t0 = Date.now()
  for (;;) {
    const rec = svc.get(id)
    if (rec && (rec.status === "committed" || rec.status === "failed")) return rec
    if (Date.now() - t0 > capMs) throw new Error("not settled")
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe("wiki retire 路由 — 票08 S2", () => {
  let db: Database.Database
  let tmpDir: string
  let knowledgeRoot: string
  let wikiRoot: string
  let svc: PageRetireTaskService
  let app: Hono

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aa08-retire-api-"))
    knowledgeRoot = path.join(tmpDir, "knowledge")
    wikiRoot = path.join(knowledgeRoot, "wiki")
    ensureWikiSkeleton(wikiRoot)
    fs.writeFileSync(path.join(wikiRoot, "entities", "ent-widget-b.md"), PAGE, "utf-8")
    const g = realGit(wikiRoot)
    g.run(["init"]); g.run(["config", "user.email", "t@t.local"]); g.run(["config", "user.name", "t"])
    g.run(["config", "core.autocrlf", "false"]); g.run(["add", "-A"]); g.run(["commit", "-m", "seed"])
    svc = new PageRetireTaskService({ db, root: knowledgeRoot, git: g, now: () => new Date("2026-10-14T09:00:00.000Z") })
    app = new Hono()
    app.route("/api/knowledge/wiki", createWikiRetireRoutes(svc))
  })

  afterEach(() => {
    db?.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("POST /retire {path} → 202 {taskId ret-, status queued, path 回显}", async () => {
    const resp = await app.request("/api/knowledge/wiki/retire", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "entities/ent-widget-b.md", reason: "S2" }),
    })
    expect(resp.status).toBe(202)
    const ack = await resp.json() as { taskId: string; path: string; status: string }
    expect(ack.taskId).toMatch(/^ret-/)
    expect(ack.status).toBe("queued")
    expect(ack.path).toBe("entities/ent-widget-b.md")

    const done = await waitSettled(svc, ack.taskId)
    expect(done.status).toBe("committed")
    const got = await app.request(`/api/knowledge/wiki/retire/task/${ack.taskId}`)
    expect(got.status).toBe(200)
    const body = await got.json() as { task: { status: string; result?: { retiredPath: string } } }
    expect(body.task.result?.retiredPath).toBe("_retired/entities/ent-widget-b.md")
  })

  it("POST /retire 缺 path/pageId → 400 INVALID_PARAM", async () => {
    const resp = await app.request("/api/knowledge/wiki/retire", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "x" }),
    })
    expect(resp.status).toBe(400)
    expect(((await resp.json()) as { error: { code: string } }).error.code).toBe("INVALID_PARAM")
  })

  it("POST /retire 非 JSON 对象 → 400 INVALID_PARAM", async () => {
    const resp = await app.request("/api/knowledge/wiki/retire", {
      method: "POST", headers: { "content-type": "application/json" }, body: "[1,2]",
    })
    expect(resp.status).toBe(400)
  })

  it("POST /retire 不在册页 → 404 NOT_FOUND", async () => {
    const resp = await app.request("/api/knowledge/wiki/retire", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "concepts/ghost.md" }),
    })
    expect(resp.status).toBe(404)
    expect(((await resp.json()) as { error: { code: string } }).error.code).toBe("NOT_FOUND")
  })

  it("GET /retire/task/:id 未知 → 404 NOT_FOUND", async () => {
    const resp = await app.request("/api/knowledge/wiki/retire/task/ret-nope")
    expect(resp.status).toBe(404)
  })
})
