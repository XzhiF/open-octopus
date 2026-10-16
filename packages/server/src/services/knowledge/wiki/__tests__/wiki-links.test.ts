import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { spawnSync } from "child_process"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../../../../db/schema"
import { WikiArticleDAO } from "../../../../db/dao/wiki-article-dao"
import { GLOBAL_WIKI_ORG } from "../../global-paths"
import { computeArticleLinks, wikiLinkTargets } from "../lint"
import { backfillWikiArticleLinks } from "../backfill-links"
import { WikiCompileService } from "../compile"
import { createWikiRoutes } from "../../../../routes/wiki"
import type { GitRunner } from "../wiki-git"

/**
 * 反链倒排基础 — wiki_articles.links 行为测试（知识中心改版·右栏反链）。
 * 钉四层：
 *   ①lint 纯函数：正文 [[…]] 目标提取（#/| 变体、去重保序）与 front-matter 合并形；
 *   ②DAO 收口：upsert 数组序列化 / 快照串透传 / 缺省 '[]'；
 *   ③回灌：NULL 行盘真源优先（front-matter ∪ 正文），盘缺回退正文面，幂等；
 *   ④tree 端点：entry.links / entry.backlinks（linkPointsToPage 判据单源）/ 顶层 index。
 * 真 fs（tmpdir 知识根）+ in-memory DB + 真 git（compilePages 通道）。
 */

const realGit = (cwd: string): GitRunner => ({
  run(args: string[]) {
    const r = spawnSync("git", args, { cwd, timeout: 30000, env: { ...process.env, OCTOPUS_WIKI_COMMIT_SOURCE: "curate" } })
    return { status: r.status ?? 1, stdout: r.stdout?.toString() ?? "", stderr: r.stderr?.toString() ?? "" }
  },
})

function page(id: string, links: string[], body: string): string {
  const linksBlock = links.length > 0 ? `links: [${links.map(l => `[[${l}]]`).join(", ")}]` : "links: []"
  return [
    "---", `id: ${id}`, "type: concept", `title: ${id} 页`, `summary: ${id} 摘要`,
    "topics: [links]", "aliases: []", linksBlock,
    "last_compiled: 2026-10-16", "sources: []", "---", "", body,
  ].join("\n")
}

function upsertRow(over: Partial<Parameters<WikiArticleDAO["upsert"]>[0]> = {}) {
  return {
    org: GLOBAL_WIKI_ORG, id: "r-x", domain: "concept", title: "t", summary: "s",
    topics: "[]", stability: "stable", last_compiled: "2026-10-16", sources: "[]",
    confidence: 0.5, body: "正文", path: "concepts/r-x.md", ...over,
  }
}

let db: Database.Database
let tmpDir: string
let root: string
let wikiRoot: string
let articles: WikiArticleDAO

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-links-"))
  root = path.join(tmpDir, "knowledge")
  wikiRoot = path.join(root, "wiki")
  fs.mkdirSync(wikiRoot, { recursive: true })
  articles = new WikiArticleDAO(db)
})

afterEach(() => {
  db?.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("①lint 纯函数：链接目标面", () => {
  it("wikiLinkTargets：提取 [[a]]、去 [[b#锚]] 的锚、[[c|别名]] 的别名，保序去重", () => {
    const body = "见 [[a]] 与 [[b#oct-001]]、[[c|别名]]，回指 [[a]]。"
    expect(wikiLinkTargets(body)).toEqual(["a", "b", "c"])
  })
  it("computeArticleLinks：正文 ∪ front-matter（保序去重）", () => {
    expect(computeArticleLinks(["m-a", "b"], "引用 [[b]] 与 [[m-a]]。")).toEqual(["b", "m-a"])
    expect(computeArticleLinks(undefined, "无链正文")).toEqual([])
  })
})

describe("②DAO 收口：links 列形态", () => {
  it("数组入 ⇒ JSON 串出；缺省 ⇒ 保留在库值（COALESCE，防清单外通道清列）；串入（快照重放形）⇒ 原样透传", () => {
    articles.upsert(upsertRow({ id: "a1", links: ["x", "y"] }))
    expect(articles.get(GLOBAL_WIKI_ORG, "a1")!.links).toBe('["x","y"]')
    // 不带 links 的再次 upsert（body 漂移通道形）⇒ links 不被清零
    articles.upsert(upsertRow({ id: "a1", body: "改后正文" }))
    expect(articles.get(GLOBAL_WIKI_ORG, "a1")!.links).toBe('["x","y"]')
    // 新行缺省 ⇒ NULL（诚实未回灌形，交给启动 backfill/下次编译）
    articles.upsert(upsertRow({ id: "a2" }))
    expect(articles.get(GLOBAL_WIKI_ORG, "a2")!.links).toBeNull()
    articles.upsert(upsertRow({ id: "a3", links: '["z"]' }))
    expect(articles.get(GLOBAL_WIKI_ORG, "a3")!.links).toBe('["z"]')
  })
})

describe("③启动回灌：NULL 历史行补齐", () => {
  it("盘真源优先：front-matter ∪ 正文 [[…]]；跑后不再入扫描面（幂等）", () => {
    fs.mkdirSync(path.join(wikiRoot, "concepts"), { recursive: true })
    fs.writeFileSync(path.join(wikiRoot, "concepts", "old.md"),
      page("old", ["disk-link"], "正文再指 [[body-link]]。"), "utf-8")
    articles.upsert(upsertRow({ id: "old", path: "concepts/old.md", links: "[]" }))
    db.prepare("UPDATE wiki_articles SET links=NULL WHERE id='old'").run()

    expect(backfillWikiArticleLinks(articles, wikiRoot)).toBe(1)
    expect(JSON.parse(articles.get(GLOBAL_WIKI_ORG, "old")!.links!)).toEqual(["body-link", "disk-link"])
    // 幂等：links 已非 NULL，第二跑零行
    expect(backfillWikiArticleLinks(articles, wikiRoot)).toBe(0)
  })
  it("盘缺文件：回退 DB body 的 [[…]] 面，不炸不丢行", () => {
    articles.upsert(upsertRow({ id: "ghost", path: "concepts/ghost.md", body: "见 [[x]]。", links: "[]" }))
    db.prepare("UPDATE wiki_articles SET links=NULL WHERE id='ghost'").run()
    expect(backfillWikiArticleLinks(articles, wikiRoot)).toBe(1)
    expect(JSON.parse(articles.get(GLOBAL_WIKI_ORG, "ghost")!.links!)).toEqual(["x"])
  })
})

describe("④tree 端点：links/backlinks/index 进读面", () => {
  it("编译三页 ⇒ ref 页链两靶；tree 出 entry.links、目标 entry.backlinks=[con-ref]、顶层 index 文本", async () => {
    const svc = new WikiCompileService({ db, org: GLOBAL_WIKI_ORG, rootDir: wikiRoot, git: realGit(wikiRoot) })
    await svc.compilePages([
      { content: page("con-target", [], "## 定义\n\n靶页。") },
      { content: page("con-ref", ["con-target"], "## 定义\n\n见 [[con-target]] 与 [[con-third]]。") },
      { content: page("con-third", [], "## 定义\n\n第三页。") },
    ], { entry: "links 测试", note: "反链基础" })

    const app = createWikiRoutes(articles, { rootDir: wikiRoot })
    const data = await (await app.request("/tree?org=global")).json()

    const byId = new Map<string, { links: string[]; backlinks: string[] }>()
    for (const d of data.domains) for (const e of d.entries) byId.set(e.id, e)

    expect(byId.get("con-ref")!.links).toEqual(["con-target", "con-third"])
    expect(byId.get("con-target")!.backlinks).toEqual(["con-ref"])
    expect(byId.get("con-third")!.backlinks).toEqual(["con-ref"])
    expect(byId.get("con-ref")!.backlinks).toEqual([])
    expect(typeof data.index).toBe("string")
    expect(data.index).toContain("con-target")
  })
})
