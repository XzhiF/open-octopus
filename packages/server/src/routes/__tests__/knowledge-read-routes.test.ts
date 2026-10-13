import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { execFileSync } from "child_process"
import { applySchema } from "../../db/schema"
import { WikiArticleDAO } from "../../db/dao/wiki-article-dao"
import { createKnowledgeReadRoutes } from "../knowledge-read"
import { createWikiRoutes } from "../wiki"
import crypto from "crypto"

/**
 * 票11 · S2 缝：/knowledge 知识中心读面最小补口 ——
 *   GET /api/knowledge/log（LOG.md 行数组 + 前缀过滤）
 *   GET /api/knowledge/raw（raw 源列表：path/bytes/hash/origin）
 *   GET /api/knowledge/raw/*（单文件只读，拒绝路径穿越）
 *   GET /api/knowledge/health（健康条聚合：页数按类/raw 源数/本周 ingest/
 *     队列深度=0/findings=0/最近编译/git HEAD——无「待审核」字段）
 * 真 fs + tmpdir（wiki-meta-routes.test.ts 先例），DB 用 in-memory + DAO 直插
 * （wiki-routes.test.ts seedRow 先例）；rootDir/knowledgeRoot 构造注入，绝不碰真 ~/.octopus。
 */

// LOG 行格式逐字取自票04 编译服务的 formatLogRow 产物（独立真相源：wiki-meta-routes fixture 同款）。
const LOG_TEXT = `# LOG.md — 时间线（append-only · 编译器自动写 · 行首「## [日期] 动作 | 对象」可 grep · 详情看 git show <hash>）

## [2026-10-12] compile | projects/prj-octopus.md
  → +oct-007 Promise 超时 · task-207 归档提炼 · xzf ✓
## [2026-10-13] ingest | raw/inbox/2026-10-13-karpathy-llm-wiki.md
  → 落 raw 冻结 · url:https://gist · curator ✓
## [2026-10-13] lint | concepts/con-compiled-rag.md
  → L1 容量触顶 → 拆分建议随错 · curator ✓
## [2026-10-11] revert | compile a3f9c21
  → 回滚本次编译 · git revert · owner ✓
| 2026-09-30 | compile | 旧表格行（v2 格式，封 git 史） | — | — | — |
`

let db: Database.Database
let dao: WikiArticleDAO
let tmpDir: string       // 假知识根（raw/ + wiki/）
let wikiDir: string

function app() {
  return createKnowledgeReadRoutes(
    { articles: dao },
    { knowledgeRoot: tmpDir, wikiRoot: wikiDir, now: () => new Date("2026-10-13T12:00:00Z") },
  )
}

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
  dao = new WikiArticleDAO(db)

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-read-"))
  wikiDir = path.join(tmpDir, "wiki")
  fs.mkdirSync(wikiDir, { recursive: true })
  fs.writeFileSync(path.join(wikiDir, "LOG.md"), LOG_TEXT, "utf-8")
})

afterEach(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// raw 头五字段格式 = 票02 RawIngestService.freeze 产物（独立真相源：raw.ts renderRawFrontMatter 先例）
function rawFile(origin: string, title: string, ingestedAt: string, body: string): string {
  const bytes = Buffer.byteLength(body, "utf-8")
  const hash = crypto.createHash("sha256").update(body, "utf-8").digest("hex")
  return `---\norigin: "${origin}"\ntitle: "${title}"\ningestedAt: "${ingestedAt}"\nbytes: ${bytes}\nhash: "${hash}"\n---\n\n${body}`
}

describe("GET /api/knowledge/raw — raw 源列表（只读）", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(tmpDir, "raw", "inbox"), { recursive: true })
    fs.mkdirSync(path.join(tmpDir, "raw", "archives"), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, "raw", "inbox", "2026-10-13-karpathy-llm-wiki.md"),
      rawFile("url:https://gist.github.com/karpathy/442a6bf", "Karpathy LLM Wiki", "2026-10-13T09:12:00.000Z", "# llm wiki\n三层架构\n"), "utf-8")
    fs.writeFileSync(path.join(tmpDir, "raw", "archives", "task-207-summary.md"),
      rawFile("file:C:/xzf/ai/open-octopus/.scratch/task-207.md", "task-207 归档总结", "2026-10-06T08:00:00.000Z", "## 验收台账\n全绿\n"), "utf-8")
  })

  it("lists sources with path/bytes/hash/origin (knowledge-root-relative POSIX path)", async () => {
    const data = await (await app().request("/raw")).json()
    expect(data.sources).toHaveLength(2)
    const inbox = data.sources.find((s: { path: string }) => s.path === "raw/inbox/2026-10-13-karpathy-llm-wiki.md")
    expect(inbox.origin).toBe("url:https://gist.github.com/karpathy/442a6bf")
    expect(inbox.bytes).toBe(Buffer.byteLength("# llm wiki\n三层架构\n", "utf-8"))
    expect(inbox.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(data.sources.map((s: { path: string }) => s.path).sort()).toEqual([
      "raw/archives/task-207-summary.md",
      "raw/inbox/2026-10-13-karpathy-llm-wiki.md",
    ])
  })

  it("missing raw skeleton degrades to empty list — never 500", async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "kc-read-bare-"))
    try {
      const res = await createKnowledgeReadRoutes({ articles: dao }, { knowledgeRoot: bare, wikiRoot: wikiDir }).request("/raw")
      expect(res.status).toBe(200)
      expect((await res.json()).sources).toEqual([])
    } finally {
      fs.rmSync(bare, { recursive: true, force: true })
    }
  })
})

describe("GET /api/knowledge/raw/* — 单文件只读，拒绝路径穿越", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(tmpDir, "raw", "inbox"), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, "raw", "inbox", "note.md"),
      rawFile("paste", "会议纪要", "2026-10-13T10:00:00.000Z", "正文内容\n"), "utf-8")
  })

  it("reads one raw source by raw-root-relative path (content verbatim)", async () => {
    const res = await app().request("/raw/inbox/note.md")
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.path).toBe("raw/inbox/note.md")
    expect(data.title).toBe("会议纪要")
    expect(data.content).toContain("正文内容")
    expect(data.content).toContain("hash:")
  })

  it.each([
    "/raw/..%2F..%2Fsecret.md",              // 编码斜杠穿越（%2F 不触发 URL 归一化，解码后含 .. 段且段数越界）
    "/raw/evil/note.md",                     // 目录不在 {inbox,archives,research} 契约内
    "/raw/inbox/nested/deep.md",             // 嵌套段（raw 命名契约是单层）
  ])("rejects traversal/foreign path %s with 400 INVALID_PARAM", async (url) => {
    const res = await app().request(url)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe("INVALID_PARAM")
  })

  it.each([
    "/raw/inbox/../../wiki/LOG.md",          // 明文 .. 穿越
    "/raw/%2e%2e/wiki/LOG.md",               // 编码点号（%2e%2e 等价 ..，URL 归一化同样弹掉）
  ])("plain/encoded dot traversal is neutralized before the filesystem: %s ⇒ 404, no leak", async (url) => {
    const res = await app().request(url)
    expect(res.status).toBe(404) // 归一化后落在 /wiki/LOG.md——本读面路由根本没有该端点
  })

  it("unknown file ⇒ 404 NOT_FOUND", async () => {
    const res = await app().request("/raw/inbox/nope.md")
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe("NOT_FOUND")
  })
})

describe("GET /api/knowledge/health — 健康条聚合（票面口径七项，无「待审核」）", () => {
  beforeEach(() => {
    // DB 索引层：v3 类型值 5 行 + v2 域值 2 行（重蒸馏前混存实况；桶映射 = shared 单源）
    const seed = (id: string, domain: string, last: string) =>
      dao.upsert({
        org: "global", id, domain, title: id, summary: "-", topics: "[]", stability: "stable",
        last_compiled: last, sources: "[]", confidence: 0.5, body: "-", path: `${domain}/${id}.md`,
      })
    seed("ent-open-octopus", "entity", "2026-10-13")
    seed("con-compiled-rag", "concept", "2026-10-12")
    seed("top-knowledge-injection", "topic", "2026-10-11")
    seed("src-karpathy", "source", "2026-10-13")
    seed("case-v3", "case", "2026-10-01")
    seed("prj-octopus", "projects", "2026-09-30") // v2 → topic 桶
    seed("case-2026-003", "cases", "2026-10-02")  // v2 → case 桶

    // raw 层：本周 2 源（2026-10-13 周二是假时钟；本周一=2026-10-12）+ 上周 1 源
    fs.mkdirSync(path.join(tmpDir, "raw", "inbox"), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, "raw", "inbox", "a.md"), rawFile("paste", "A", "2026-10-13T09:12:00.000Z", "aa\n"), "utf-8")
    fs.writeFileSync(path.join(tmpDir, "raw", "inbox", "b.md"), rawFile("paste", "B", "2026-10-12T08:00:00.000Z", "bb\n"), "utf-8")
    fs.writeFileSync(path.join(tmpDir, "raw", "inbox", "c.md"), rawFile("paste", "C", "2026-10-11T23:59:00.000Z", "cc\n"), "utf-8")
  })

  it("returns the seven ticket-worded fields with bucketed page counts", async () => {
    const res = await app().request("/health")
    expect(res.status).toBe(200)
    const data = await res.json()

    expect(data.org).toBe("global")
    // 页数按类：v2 域值经 shared 映射入 v3 桶（projects→topic、cases→case）
    expect(data.pages).toEqual({ total: 7, entity: 1, concept: 1, topic: 2, source: 1, case: 2 })
    expect(data.rawSources).toBe(3)
    expect(data.ingestedThisWeek).toBe(2) // ISO 周一起算：10-11 不计
    expect(data.openFindings).toBe(0)     // 票13 未就位 ⇒ 稳定零值形状
    expect(data.queueDepth).toBe(0)       // 票06 未就位 ⇒ 稳定零值形状
    expect(data.lastCompiled).toBe("2026-10-13")
    expect(data.gitHead).toBeNull()       // wiki 根无 .git ⇒ 诚实 null
  })

  it("reports git HEAD from the global wiki root", async () => {
    execFileSync("git", ["init"], { cwd: wikiDir })
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: wikiDir })
    execFileSync("git", ["config", "user.name", "T"], { cwd: wikiDir })
    execFileSync("git", ["commit", "--allow-empty", "-m", "compile: bootstrap"], { cwd: wikiDir })
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: wikiDir }).toString().trim()

    const data = await (await app().request("/health")).json()
    expect(data.gitHead).toBe(head)
  })

  it("契约负断言：响应不存在「待审核/pendingReview」任何形态字段（审批概念已废除）", async () => {
    const text = JSON.stringify(await (await app().request("/health")).json())
    expect(text).not.toMatch(/pending/i)
    expect(text).not.toContain("待审核")
  })
})

describe("GET /api/knowledge/wiki/article/:id — v3 页 front-matter 现形（票11 页渲染 chips 数据源）", () => {
  const PAGE_FILE = `---
id: con-compiled-rag
type: concept
title: 编译式 RAG
summary: 检索的重活挪到编译时
topics: [rag]
aliases: [compiled rag, 编译RAG]
links: [[top-knowledge-injection]]
last_compiled: 2026-10-13
sources: ["raw/inbox/2026-10-13-karpathy-llm-wiki.md"]
confidence: 0.9
---

## 定义

检索的重活从 query 时挪到维护编译时。<!--#oct-008-->
`

  it("carries page{type/entityKind/aliases/links} for v3 pages", async () => {
    dao.upsert({
      org: "global", id: "con-compiled-rag", domain: "concept", title: "编译式 RAG",
      summary: "检索的重活挪到编译时", topics: JSON.stringify(["rag"]), stability: "stable",
      last_compiled: "2026-10-13", sources: JSON.stringify(["raw/inbox/2026-10-13-karpathy-llm-wiki.md"]),
      confidence: 0.9, body: "## 定义\n\n检索的重活从 query 时挪到维护编译时。<!--#oct-008-->\n", path: "concepts/con-compiled-rag.md",
    })
    fs.mkdirSync(path.join(wikiDir, "concepts"), { recursive: true })
    fs.writeFileSync(path.join(wikiDir, "concepts", "con-compiled-rag.md"), PAGE_FILE, "utf-8")

    const app = createWikiRoutes(dao, { rootDir: wikiDir })
    const res = await app.request("/article/con-compiled-rag")
    expect(res.status).toBe(200)
    const data = await res.json()

    expect(data.page).toEqual({
      type: "concept",
      entityKind: null,
      aliases: ["compiled rag", "编译RAG"],
      links: ["top-knowledge-injection"],
    })
  })

  it("v2-domain row / missing file ⇒ page null（兼容读面诚实降级，不炸 500）", async () => {
    dao.upsert({
      org: "global", id: "prj-octopus", domain: "projects", title: "Octopus",
      summary: "-", topics: "[]", stability: "stable", last_compiled: "2026-10-12",
      sources: "[]", confidence: 0.8, body: "- x\n", path: "projects/prj-octopus.md",
    })
    const app = createWikiRoutes(dao, { rootDir: wikiDir }) // projects/ 下无文件
    const data = await (await app.request("/article/prj-octopus")).json()
    expect(data.page).toBeNull()
  })
})

describe("GET /api/knowledge/log — LOG.md 行数组 + 前缀过滤", () => {
  it("returns parsed timeline lines (date/op/title/result) in file order", async () => {
    const res = await app().request("/log")
    expect(res.status).toBe(200)
    const data = await res.json()

    expect(data.org).toBe("global")
    expect(data.lines).toHaveLength(4) // 头行与旧表格行不入阵（v2 表行机械转换属票07）
    expect(data.lines[0]).toEqual({
      date: "2026-10-12", op: "compile", title: "projects/prj-octopus.md",
      result: "+oct-007 Promise 超时 · task-207 归档提炼 · xzf ✓",
    })
    expect(data.lines.map((l: { op: string }) => l.op)).toEqual(["compile", "ingest", "lint", "revert"])
  })

  it("op filter narrows to that prefix (ingest/compile/query/lint/revert 口径)", async () => {
    const data = await (await app().request("/log?op=ingest")).json()
    expect(data.lines).toHaveLength(1)
    expect(data.lines[0].title).toBe("raw/inbox/2026-10-13-karpathy-llm-wiki.md")
  })

  it("missing LOG.md degrades to empty lines — never 500", async () => {
    const missing = path.join(tmpDir, "..", "kc-read-nope-" + process.pid, "wiki")
    const res = await createKnowledgeReadRoutes({ articles: dao }, { knowledgeRoot: tmpDir, wikiRoot: missing }).request("/log")
    expect(res.status).toBe(200)
    expect((await res.json()).lines).toEqual([])
  })
})

// =========================================================================
// 票09 · GET /api/knowledge/preference — user_preference 只读渲染面（story 16）
// 审批废除后 user_preference 零 Web 编辑入口：PUT 路由随 routes/knowledge.ts
// 物理删除（S2 负断言）；GET 只读迁入本读面模块——**纯读零 mkdir**，
// 已归档删除的目录不得被请求重建（S1 护栏）。
// =========================================================================
describe("票09 GET /api/knowledge/preference — 只读、零副作用、org 面退役", () => {
  it("scope=global reads knowledge-root user_preference.md verbatim", async () => {
    const prefText = `# User Preference\n\n- 回复用中文\n- 先想清楚再动手\n`
    fs.writeFileSync(path.join(tmpDir, "user_preference.md"), prefText, "utf-8")

    const res = await app().request("/preference?scope=global")
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.content).toBe(prefText)
    expect(data.scope).toBe("global")
    // filePath 钉全局知识根（票03 D6③ 迁入位置），不再指向 org 目录
    expect(path.normalize(data.filePath)).toBe(path.normalize(path.join(tmpDir, "user_preference.md")))
  })

  it("missing file degrades to empty content — and the request creates NOTHING (no mkdir side effect)", async () => {
    const freshRoot = path.join(os.tmpdir(), `kc-pref-fresh-${process.pid}`)
    fs.rmSync(freshRoot, { recursive: true, force: true })
    try {
      const res = await createKnowledgeReadRoutes(
        { articles: dao },
        { knowledgeRoot: freshRoot, wikiRoot: path.join(freshRoot, "wiki") },
      ).request("/preference?scope=global")
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.content).toBe("")
      // 归档不删纪律护栏：只读请求绝不重建目录/文件（getter mkdir 副作用随删除消亡）
      expect(fs.existsSync(freshRoot)).toBe(false)
    } finally {
      fs.rmSync(freshRoot, { recursive: true, force: true })
    }
  })

  it("scope=org ⇒ 400 INVALID_PARAM（org 偏好面随票09 归档删除退役）", async () => {
    const res = await app().request("/preference?scope=org&org=xzf-dev")
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error.code).toBe("INVALID_PARAM")
  })

  it("缺省 scope=global（旧客户端不带 scope 兼容）", async () => {
    fs.writeFileSync(path.join(tmpDir, "user_preference.md"), "# pref\n", "utf-8")
    const data = await (await app().request("/preference")).json()
    expect(data.scope).toBe("global")
  })
})
