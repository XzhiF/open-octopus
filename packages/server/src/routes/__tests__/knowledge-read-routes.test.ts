import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { execFileSync } from "child_process"
import { applySchema } from "../../db/schema"
import { WikiArticleDAO } from "../../db/dao/wiki-article-dao"
import { KnowledgeEffectivenessDAO } from "../../db/dao/knowledge-effectiveness-dao"
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

  it("openFindings/queueDepth 注真值不换形（票13/票06 接位：契约形状恒等，只换值）", async () => {
    const injected = createKnowledgeReadRoutes(
      { articles: dao },
      { knowledgeRoot: tmpDir, wikiRoot: wikiDir, now: () => new Date("2026-10-13T12:00:00Z"), getOpenFindings: () => 7, getQueueDepth: () => 2 },
    )
    const data = await (await injected.request("/health")).json()
    expect(data.openFindings).toBe(7)
    expect(data.queueDepth).toBe(2)
    // 形状零漂移：与零值形态同键
    const base = await (await app().request("/health")).json()
    expect(Object.keys(data).sort()).toEqual(Object.keys(base).sort())
  })

  it("score（P4 票08 health score 0-100）：未装配 ⇒ null 诚实不可评；注入 ⇒ 实数；键集恒等（avgConfidence 只换值不换形同律）", async () => {
    const base = await (await app().request("/health")).json()
    expect(base.score).toBeNull() // 注入位缺席=未装配巡检形态（稳定零值面：null 非伪造 100）
    const injected = createKnowledgeReadRoutes(
      { articles: dao },
      { knowledgeRoot: tmpDir, wikiRoot: wikiDir, now: () => new Date("2026-10-13T12:00:00Z"), getHealthScore: () => 77 },
    )
    const data = await (await injected.request("/health")).json()
    expect(data.score).toBe(77)
    expect(Object.keys(data).sort()).toEqual(Object.keys(base).sort())
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
// ADR-0033 · GET /api/knowledge/preference 物理删除（负断言防复活）
// =========================================================================
describe("ADR-0033 preference 端点退役", () => {
  it("GET /preference ⇒ 404（路由物理删除，负断言防复活）", async () => {
    const res = await app().request("/preference?scope=global")
    expect(res.status).toBe(404)
  })
})

// =========================================================================
// P4 票07 · 页元数据面 S2 形状钉：GET /wiki/article/:id 带 effectiveness 实时段
// （DB 账目 rollup，**非** wiki_articles.confidence 快照列——两值刻意不同以证路）
// + GET /health 增 avgConfidence（缺省 null 稳定零值形，注入换值不换形）。
// =========================================================================
describe("P4 票07 — article effectiveness 实时段（引用数/helpful 率/confidence，DB 真源）", () => {
  const seedArticleRow = () =>
    dao.upsert({
      org: "global", id: "top-x", domain: "topic", title: "T", summary: "-", topics: "[]",
      stability: "stable", last_compiled: "2026-10-12", sources: "[]", confidence: 0.9,
      body: "## 硬约束\n- 规则甲 <!--#oct-050-->\n", path: "topics/top-x.md",
    })

  it("measured：页键行∪锚点行手算 4/5=0.8——与快照列 0.9 不同值，证明读的是账目非快照", async () => {
    seedArticleRow()
    const effDao = new KnowledgeEffectivenessDAO(db)
    effDao.upsert("top-x", { cited_count: 2, helpful_count: 0, not_helpful_count: 0 })
    effDao.upsert("oct-050", { cited_count: 5, helpful_count: 4, not_helpful_count: 1 })
    const app = createWikiRoutes(dao, { rootDir: wikiDir, effectiveness: effDao })
    const data = await (await app.request("/article/top-x")).json()
    expect(data.confidence).toBe(0.9) // 快照列原样在册（sync 未跑）
    expect(data.effectiveness).toEqual({
      citedCount: 7, helpfulCount: 4, notHelpfulCount: 1,
      helpfulRate: 0.8, confidence: 0.8, measured: true,
    })
  })

  it("样本不足：实时段 confidence=快照初值（不抖动进 API 面），helpfulRate 仍现账直显（闸值 vs 现账并见）", async () => {
    seedArticleRow()
    const effDao = new KnowledgeEffectivenessDAO(db)
    effDao.upsert("oct-050", { cited_count: 7, helpful_count: 1, not_helpful_count: 1 })
    const app = createWikiRoutes(dao, { rootDir: wikiDir, effectiveness: effDao })
    const data = await (await app.request("/article/top-x")).json()
    expect(data.effectiveness).toEqual({
      citedCount: 7, helpfulCount: 1, notHelpfulCount: 1,
      helpfulRate: 0.5, confidence: 0.9, measured: false,
    })
  })

  it("零账页 ⇒ 诚实全零形（citedCount 0 / helpfulRate null / confidence=快照值）——页脚永远有东西可显", async () => {
    seedArticleRow()
    const effDao = new KnowledgeEffectivenessDAO(db)
    const app = createWikiRoutes(dao, { rootDir: wikiDir, effectiveness: effDao })
    const data = await (await app.request("/article/top-x")).json()
    expect(data.effectiveness).toEqual({
      citedCount: 0, helpfulCount: 0, notHelpfulCount: 0,
      helpfulRate: null, confidence: 0.9, measured: false,
    })
  })

  it("未接账目 DAO ⇒ effectiveness:null（契约键恒在、旧调用方零改动——只换值不换形同律）", async () => {
    seedArticleRow()
    const app = createWikiRoutes(dao, { rootDir: wikiDir })
    const data = await (await app.request("/article/top-x")).json()
    expect(data.effectiveness).toBeNull()
  })
})

describe("P4 票07 — GET /health avgConfidence（健康条全库平均置信口径）", () => {
  it("缺省未注入 ⇒ null 稳定零值；注入换值不换形（键集恒等，票11 契约纪律）", async () => {
    const base = await (await app().request("/health")).json()
    expect(base.avgConfidence).toBeNull()
    const injected = createKnowledgeReadRoutes(
      { articles: dao },
      { knowledgeRoot: tmpDir, wikiRoot: wikiDir, now: () => new Date("2026-10-13T12:00:00Z"), getAvgConfidence: () => 0.72 },
    )
    const data = await (await injected.request("/health")).json()
    expect(data.avgConfidence).toBe(0.72)
    expect(Object.keys(data).sort()).toEqual(Object.keys(base).sort())
  })

  it("契约负断言（新增字段不回归审批面）：响应仍无「待审核/pending」字样", async () => {
    const text = JSON.stringify(await (await app().request("/health")).json())
    expect(text).not.toMatch(/pending/i)
    expect(text).not.toContain("待审核")
  })
})

// ── 知识中心左栏「真实目录树」改版（20261016）：/fs 目录投影 + /fs/file 只读 .md ──
describe("GET /api/knowledge/fs + /fs/file — 知识根目录树只读投影", () => {
  beforeEach(() => {
    const wf = (rel: string, content: string) => {
      const abs = path.join(tmpDir, ...rel.split("/"))
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, content, "utf-8")
    }
    wf("SCHEMA.md", "# SCHEMA\n纪律文本\n")
    wf("wiki/INDEX.md", "# INDEX\n- [a](concepts/con-a.md)\n")
    wf("wiki/concepts/con-a.md", "---\ntitle: A\n---\nbody")
    wf("wiki/.git/config", "[core]")
    wf("raw/inbox/2026-10-13-a.md", rawFile("paste", "A", "2026-10-13T09:00:00.000Z", "note a\n"), )
    wf("drafts/skills/s1/SKILL.md", "---\nname: s1\n---\ndraft")
    wf("_archive/user_preference/x.md", "up")
    wf("_archive/pending-review-2026-10-14.json", "{}")
  })

  it("/fs 契约形状（键集恒等）；.git 与 user_preference 零出现（防复活对称）；pending-review 保留（防过杀）", async () => {
    const data = await (await app().request("/fs")).json()
    expect(Object.keys(data).sort()).toEqual(["org", "root", "total", "tree", "truncated"])
    expect(data.org).toBe("global")
    expect(data.root).toBe("knowledge")
    expect(data.truncated).toBe(false)
    const text = JSON.stringify(data)
    expect(text).not.toContain(".git")
    expect(text).not.toContain("user_preference")
    expect(text).toContain("pending-review") // 排除判据不得顺手灭掉无关归档件
    const roots = data.tree.map((n: { name: string }) => n.name)
    expect(roots).toEqual(["_archive", "drafts", "raw", "wiki", "SCHEMA.md"]) // 目录先行+码元升序
  })

  it("/fs raw 子树叶集 ≡ GET /raw 清单集（可见即可读，判据单源）", async () => {
    const flatFiles = (nodes: Array<{ path: string; kind: string; children?: unknown }>, acc: string[] = []): string[] => {
      for (const n of nodes) {
        if (n.kind === "file") acc.push(n.path)
        if (n.children) flatFiles(n.children as never, acc)
      }
      return acc
    }
    const data = await (await app().request("/fs")).json()
    const fsRaw = flatFiles(data.tree).filter((p: string) => p.startsWith("raw/")).sort()
    const apiRaw = (await (await app().request("/raw")).json()).sources.map((s: { path: string }) => s.path).sort()
    expect(fsRaw).toEqual(apiRaw)
    expect(fsRaw).toEqual(["raw/inbox/2026-10-13-a.md"])
  })

  it("/fs/file：SCHEMA.md 200 回读（{org,path,content,bytes} 键集恒等）", async () => {
    const res = await app().request(`/fs/file?path=${encodeURIComponent("SCHEMA.md")}`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(Object.keys(data).sort()).toEqual(["bytes", "content", "org", "path"])
    expect(data.content).toContain("纪律文本")
  })

  it("/fs/file 错误矩阵：缺参 400 / 段穿越 400 / 双编码段 400 / json 400 / user_preference 404 / 缺席 404（error 形制）", async () => {
    const code = async (q: string): Promise<[number, string]> => {
      const res = await app().request(`/fs/file${q}`)
      const body = await res.json()
      expect(body.error.code).toBeTruthy()
      return [res.status, body.error.code]
    }
    expect(await code("")).toEqual([400, "INVALID_PARAM"])
    expect(await code(`?path=${encodeURIComponent("wiki/../../etc/x.md")}`)).toEqual([400, "INVALID_PARAM"])
    expect(await code(`?path=${encodeURIComponent("wiki/%2e%2e/x.md")}`)).toEqual([400, "INVALID_PARAM"])
    expect(await code(`?path=${encodeURIComponent("_archive/pending-review-2026-10-14.json")}`)).toEqual([400, "INVALID_PARAM"])
    expect(await code(`?path=${encodeURIComponent("_archive/user_preference/x.md")}`)).toEqual([404, "NOT_FOUND"])
    expect(await code(`?path=${encodeURIComponent("wiki/nope.md")}`)).toEqual([404, "NOT_FOUND"])
  })
})
