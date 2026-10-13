import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { execFileSync } from "child_process"
import { applySchema } from "../../db/schema"
import { WikiArticleDAO } from "../../db/dao/wiki-article-dao"
import { createWikiRoutes } from "../wiki"
import { WIKI_LOG_HEADER } from "../../services/knowledge/wiki/compile"

/**
 * 票03 · S3 缝：/wiki 页的只读数据面扩展 —— tree.log（LOG.md 全文，供
 * 「LOG.md 有渲染视图」）与 article.gitHistory（词条路径的 git 近史，供右栏
 * 「git 近史」）。rootDir 构造注入（archive-routes stateDir 先例），真 git + tmpdir
 * （wiki-compile.test.ts 先例）。
 */

const ORG = "xzf-dev" // 票03：参数容错保留；DB 行钉 global

describe("wiki read-only meta routes (ticket 03 UI 数据面)", () => {
  let db: Database.Database
  let dao: WikiArticleDAO
  let tmpDir: string

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    dao = new WikiArticleDAO(db)
    dao.upsert({
      org: "global", id: "prj-octopus", domain: "projects", title: "Octopus 平台工程知识",
      summary: "monorepo 构建/测试/端口规则与已知陷阱", topics: "[]", stability: "stable",
      last_compiled: "2026-10-12", sources: JSON.stringify(["doc:docs/agents/windows-bash.md"]),
      confidence: 0.86, body: "- Promise 超时规则 <!--#oct-007-->\n", path: "projects/prj-octopus.md",
    })

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-meta-"))
    execFileSync("git", ["init"], { cwd: tmpDir })
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: tmpDir })
    execFileSync("git", ["config", "user.name", "T"], { cwd: tmpDir })
    fs.mkdirSync(path.join(tmpDir, "projects"), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, "projects", "prj-octopus.md"), "# octopus\n初稿\n", "utf-8")
    fs.writeFileSync(path.join(tmpDir, "LOG.md"), WIKI_LOG_HEADER + "## [2026-10-12] compile | projects/prj-octopus.md\n  → +oct-007 Promise 超时 · task-207 归档提炼 · xzf ✓\n", "utf-8")
    execFileSync("git", ["add", "-A"], { cwd: tmpDir })
    execFileSync("git", ["commit", "-m", "compile: projects/prj-octopus.md — +oct-007"], { cwd: tmpDir })
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("tree carries the full LOG.md text for the curation-log table view", async () => {
    const app = createWikiRoutes(dao, { rootDir: tmpDir })
    const res = await app.request(`/tree?org=${ORG}`)
    expect(res.status).toBe(200)
    const data = await res.json()

    // 逐字取自 fixture 的 v3 行式 LOG（票04 格式：头 + `## [date] op | 对象` + `→ 结果`）
    expect(data.log).toContain("# LOG.md — 时间线")
    expect(data.log).toContain("## [2026-10-12] compile | projects/prj-octopus.md")
    expect(data.log).toContain("  → +oct-007 Promise 超时 · task-207 归档提炼 · xzf ✓")
  })

  it("article carries git 近史 for the entry path", async () => {
    const app = createWikiRoutes(dao, { rootDir: tmpDir })
    const res = await app.request(`/article/prj-octopus?org=${ORG}`)
    expect(res.status).toBe(200)
    const data = await res.json()

    expect(data.gitHistory).toHaveLength(1)
    expect(data.gitHistory[0].message).toBe("compile: projects/prj-octopus.md — +oct-007")
    expect(data.gitHistory[0].hash).toMatch(/^[0-9a-f]{7,40}$/)
    expect(data.gitHistory[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it("missing wiki root degrades gracefully (log=null, gitHistory=[]) — never 500", async () => {
    const missing = path.join(tmpDir, "..", "wiki-meta-nonexistent-" + process.pid)
    const app = createWikiRoutes(dao, { rootDir: missing })
    const tree = await (await app.request(`/tree?org=${ORG}`)).json()
    expect(tree.log).toBeNull()
    const art = await (await app.request(`/article/prj-octopus?org=${ORG}`)).json()
    expect(art.gitHistory).toEqual([])
  })

  it("no rootDir injected (prod shape): org-resolved root, still 200 with defaults", async () => {
    // 未注入 rootDir → resolveWikiRoot(org) 指向 ~/.octopus 真实路径，目录未必存在；
    // 只要求不炸且形状稳定（log null|string，gitHistory 数组）。
    const app = createWikiRoutes(dao)
    const tree = await (await app.request(`/tree?org=${ORG}`)).json()
    expect(tree.log === null || typeof tree.log === "string").toBe(true)
    const art = await (await app.request(`/article/prj-octopus?org=${ORG}`)).json()
    expect(Array.isArray(art.gitHistory)).toBe(true)
  })
})
