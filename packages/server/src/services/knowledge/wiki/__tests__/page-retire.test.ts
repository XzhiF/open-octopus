/**
 * 票08 item-4 S1 — page-retire 机制真跑（真 git + tmpdir 知识根，零触真盘）。
 * spec 故事32：对话退役一页 → 队列 → `_retired/` + superseded + 单 commit。
 * 断言全走外部产物：fs（页迁位 + front-matter）、INDEX/LOG、DB/FTS 四路摘除互验、
 * git commit 数（+1）、幂等再退拒、人工文件拒退。真跑 12 页 kc15-* ops 批退役归票09/主控。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { applySchema } from "../../../../db/schema"
import { GLOBAL_WIKI_ORG } from "../../global-paths"
import { WikiArticleDAO } from "../../../../db/dao/wiki-article-dao"
import { ensureWikiSkeleton } from "../paths"
import { PageRetireTaskService, type PageRetireTaskRecord } from "../page-retire"
import type { GitRunner } from "../wiki-git"

const FROZEN = () => new Date("2026-10-14T08:00:00.000Z")
const realGit = (cwd: string): GitRunner => ({
  run(args: string[]) {
    const r = spawnSync("git", args, { cwd, timeout: 30000, env: { ...process.env, OCTOPUS_WIKI_COMMIT_SOURCE: "curate" } })
    return { status: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
  },
})

const CONCEPT_PAGE = `---
id: con-kc15-widget-a
type: concept
title: 退役探针概念A
summary: 用于票08 页退役机制 S1 断言的在册概念页
topics: [probe]
links: []
last_compiled: 2026-10-13
sources: [doc:s1]
---

## 规则节
- 退役探针纪律一 <!--#oct-042-->
`

function readLog(root: string): string {
  const p = path.join(root, "LOG.md")
  return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : ""
}

async function settle(svc: PageRetireTaskService, id: string, capMs = 8000): Promise<PageRetireTaskRecord> {
  const start = Date.now()
  for (;;) {
    const rec = svc.get(id)
    if (rec && (rec.status === "committed" || rec.status === "failed")) return rec
    if (Date.now() - start > capMs) throw new Error(`retire task ${id} did not settle: ${JSON.stringify(rec)}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe("PageRetireTaskService — 页退役真跑（票08 · 故事32）", () => {
  let db: Database.Database
  let tmpDir: string
  let knowledgeRoot: string
  let wikiRoot: string
  let git: GitRunner

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aa08-retire-"))
    knowledgeRoot = path.join(tmpDir, "knowledge")
    wikiRoot = path.join(knowledgeRoot, "wiki")
    ensureWikiSkeleton(wikiRoot)
    fs.writeFileSync(path.join(wikiRoot, "concepts", "con-kc15-widget-a.md"), CONCEPT_PAGE, "utf-8")

    git = realGit(wikiRoot)
    git.run(["init"])
    git.run(["config", "user.email", "kc@test.local"])
    git.run(["config", "user.name", "kc-test"])
    git.run(["config", "core.autocrlf", "false"])
    git.run(["add", "-A"])
    const seed = git.run(["commit", "-m", "seed: 在册概念页"])
    if (seed.status !== 0) throw new Error(`seed commit failed: ${seed.stderr}`)

    // DB 行 + FTS（在册态：org 钉 global，path=相对路径，id=front-matter id）
    const dao = new WikiArticleDAO(db)
    dao.upsert({
      org: GLOBAL_WIKI_ORG, id: "con-kc15-widget-a", domain: "concept",
      title: "退役探针概念A", summary: "用于票08 页退役机制 S1 断言的在册概念页",
      topics: '["probe"]', stability: "stable", last_compiled: "2026-10-13",
      sources: '["doc:s1"]', confidence: 0.5, body: "\n## 规则节\n- 退役探针纪律一 <!--#oct-042-->\n",
      path: "concepts/con-kc15-widget-a.md",
    })
    const rowid = dao.getRowid(GLOBAL_WIKI_ORG, "con-kc15-widget-a")
    if (rowid !== undefined) {
      dao.insertFts({
        rowid, id: "con-kc15-widget-a", domain: "concept",
        title: "退役探针概念A", summary: "用于票08 页退役机制 S1 断言的在册概念页",
        topics: '["probe"]', body: "退役探针纪律一 概念A",
      })
    }
  })

  afterEach(() => {
    db?.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("退役一页：迁 _retired/ + superseded + INDEX/LOG/DB/FTS 四路摘除互验 + 恰多一个 commit", async () => {
    const before = parseInt(git.run(["rev-list", "--count", "HEAD"]).stdout.trim(), 10)
    const svc = new PageRetireTaskService({ db, root: knowledgeRoot, git, now: FROZEN })
    const rec = svc.retire({ path: "concepts/con-kc15-widget-a.md", reason: "KC-E2E fixture 沉淀" })
    expect(rec.status).toBe("queued")
    expect(rec.id).toMatch(/^ret-/)

    const done = await settle(svc, rec.id)
    expect(done.status, JSON.stringify(done.error)).toBe("committed")
    expect(done.result?.retiredPath).toBe("_retired/concepts/con-kc15-widget-a.md")

    // 1. 原位消失、退役位存在且带 superseded（页内容不丢，红线页级映射）
    expect(fs.existsSync(path.join(wikiRoot, "concepts", "con-kc15-widget-a.md"))).toBe(false)
    const retired = fs.readFileSync(path.join(wikiRoot, "_retired", "concepts", "con-kc15-widget-a.md"), "utf-8")
    expect(retired).toMatch(/^status: superseded$/m)
    expect(retired).toContain("退役探针纪律一") // 正文保留
    expect(retired).toContain("<!--#oct-042-->") // 锚点随册留存

    // 2. INDEX 摘除该页
    const index = fs.readFileSync(path.join(wikiRoot, "INDEX.md"), "utf-8")
    expect(index).not.toContain("con-kc15-widget-a")

    // 3. LOG 恰一行 retire（对话源 · owner）
    const log = readLog(wikiRoot)
    expect(log).toMatch(/^## \[2026-10-14\] retire \| concepts\/con-kc15-widget-a\.md$/m)
    expect(log).toContain("退役入 _retired/ · KC-E2E fixture 沉淀")

    // 4. DB + FTS 摘除
    const rows = (db.prepare("SELECT COUNT(*) AS n FROM wiki_articles WHERE id = ?").get("con-kc15-widget-a") as { n: number }).n
    expect(rows).toBe(0)
    const fts = db.prepare("SELECT rowid FROM wiki_fts WHERE wiki_fts MATCH ?").all("概念A")
    expect(fts).toHaveLength(0)

    // 5. 恰多一个 commit（页迁 + INDEX + LOG 单 commit 收口）
    const after = parseInt(git.run(["rev-list", "--count", "HEAD"]).stdout.trim(), 10)
    expect(after).toBe(before + 1)
    expect(git.run(["log", "-1", "--format=%s"]).stdout).toContain("retire: concepts/con-kc15-widget-a.md")
  })

  it("幂等：退役后再退同一页 → NOT_FOUND（同步校验拒，不建任务、不产 commit）", async () => {
    const before = parseInt(git.run(["rev-list", "--count", "HEAD"]).stdout.trim(), 10)
    const svc = new PageRetireTaskService({ db, root: knowledgeRoot, git, now: FROZEN })
    const first = await settle(svc, svc.retire({ path: "concepts/con-kc15-widget-a.md" }).id)
    expect(first.status).toBe("committed")

    expect(() => svc.retire({ path: "concepts/con-kc15-widget-a.md" })).toThrow(/NOT_FOUND/)
    const after = parseInt(git.run(["rev-list", "--count", "HEAD"]).stdout.trim(), 10)
    expect(after).toBe(before + 1) // 第二次没再 commit
  })

  it("人工文件不可页退役（SCHEMA.md 被目录闸 + 写保护拒）", () => {
    const svc = new PageRetireTaskService({ db, root: knowledgeRoot, git, now: FROZEN })
    // 非 v3 四页目录下的文件一律 INVALID_PARAM（SCHEMA 住知识根，天然不可址）
    expect(() => svc.retire({ path: "SCHEMA.md" })).toThrow(/INVALID_PARAM/)
    expect(() => svc.retire({ path: "topics/../SCHEMA.md" })).toThrow(/INVALID_PARAM/)
  })

  it("非在册页（cases/ 或不存在）被拒", () => {
    const svc = new PageRetireTaskService({ db, root: knowledgeRoot, git, now: FROZEN })
    expect(() => svc.retire({ path: "cases/2026-10-01-x.md" })).toThrow(/INVALID_PARAM/) // cases 走判例管线
    expect(() => svc.retire({ path: "concepts/con-not-there.md" })).toThrow(/NOT_FOUND/)
  })

  it("pageId 定位：按 front-matter id 解析相对路径后退役", async () => {
    const svc = new PageRetireTaskService({ db, root: knowledgeRoot, git, now: FROZEN })
    const rec = svc.retire({ pageId: "con-kc15-widget-a" })
    expect(rec.path).toBe("concepts/con-kc15-widget-a.md")
    const done = await settle(svc, rec.id)
    expect(done.status).toBe("committed")
    expect(fs.existsSync(path.join(wikiRoot, "_retired", "concepts", "con-kc15-widget-a.md"))).toBe(true)
  })
})
