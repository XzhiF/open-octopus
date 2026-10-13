import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import crypto from "crypto"
import { spawnSync } from "child_process"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../../../../db/schema"
import { WikiArticleDAO } from "../../../../db/dao/wiki-article-dao"
import { RawIngestService } from "../../raw"
import { GLOBAL_WIKI_ORG } from "../../global-paths"
import { CuratorCompileService, type LLMCall } from "../curator"
import { WikiCompileService } from "../compile"
import type { GitRunner } from "../wiki-git"
import { FindingsDAO } from "../../../../db/dao/findings-dao"

/**
 * 票05 · AC1 主链条 S1 — CuratorCompileService（策展编译管线，环级）。
 * 真 fs（tmpdir 知识根 + 票02 RawIngestService 落真 raw）+ in-memory DB + 真 git；
 * LLM 走注入 seam（rule-form-judge 同法：fixture-mocked、捕获 prompt，spec Testing Decisions
 * 「provider 请求捕获」纪律，不连真模型）。
 * Expected 从 fixture 文本独立推得（锚点从空库发号=oct-001、触及清单=计划页+sources 页），
 * 禁 tautological。
 */

const realGit = (cwd: string): GitRunner => ({
  run(args: string[]) {
    const r = spawnSync("git", args, { cwd, timeout: 30000, env: { ...process.env, OCTOPUS_WIKI_COMMIT_SOURCE: "curate" } })
    return { status: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
  },
})

const FROZEN_NOW = () => new Date("2026-10-13T08:00:00.000Z")

/** raw 源 fixture（独立文本；三个知识点分别对应计划里的 concept/entity/topic 页）。 */
const RAW_ARTICLE = `# Notes on compiled knowledge bases

A compiled knowledge base moves retrieval work from query time to maintenance time.
The curator maintains an entity page for Karpathy describing who proposes the three-layer design.
Operation discipline: always rebuild shared types first in a monorepo before running the full build.
`

/** 策展计划 fixture：3 新建页（concept/entity/topic）+ 要点 + 无矛盾。 */
function planFixture(): string {
  return JSON.stringify({
    pages: [
      {
        op: "create",
        type: "concept",
        id: "con-compiled-rag",
        title: "Compiled RAG",
        summary: "检索重活从查询时挪到维护编译时",
        topics: ["rag", "knowledge"],
        links: ["ent-karpathy"],
        body: "## 定义\n检索的重活从 query 时挪到维护编译时：策展人增量维护一座 wiki，答案从编译产物合成。\n\n## 相邻概念辨析\nvs 注入式（引擎预计算硬塞 prompt）——见判例与 topics 页。\n",
      },
      {
        op: "create",
        type: "entity",
        id: "ent-karpathy",
        entity_kind: "person",
        aliases: ["Andrej Karpathy"],
        title: "Karpathy",
        summary: "三层编译型知识库（raw/wiki/schema）的提出者",
        links: ["con-compiled-rag"],
        body: "## 概述\nKarpathy 提出 raw/wiki/schema 三层与 ingest/query/lint 三操作的编译型知识库范式。\n",
      },
      {
        op: "create",
        type: "topic",
        id: "top-wiki-ops",
        title: "Wiki 操作纪律",
        summary: "策展编译的 SOP 与硬约束",
        links: [],
        body: "## SOP\n投喂→冻结→编译→diff 卡回报。\n\n## 硬约束\n- 修改 monorepo shared 类型后必须先重建 shared 再跑全量构建 <!--#oct-NEW-->\n- 常青正文零日期 <!--#oct-NEW-->\n",
      },
    ],
    key_points: [
      "三层架构：raw 不可变源 → 策展编译 wiki 页网络 → SCHEMA 共演约定",
      "检索重活挪到维护期：答案从编译产物合成而非查询时重推导",
      "投喂即编译：无审批队列，质控六道全部事后/机械",
    ],
    contradictions: [],
  })
}

describe("CuratorCompileService — raw→多页编译主链条（票05 AC1）", () => {
  let db: Database.Database
  let tmpDir: string
  let root: string
  let wikiRoot: string

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-curator-"))
    root = path.join(tmpDir, "knowledge")
    wikiRoot = path.join(root, "wiki")
    fs.mkdirSync(root, { recursive: true })
  })

  afterEach(() => {
    db?.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /** 经票02 服务把 fixture 落成真 raw（冻结 + hash 记录），返回 raw 指针。 */
  function ingestFixture(): ReturnType<RawIngestService["ingestText"]>["raw"] {
    const raw = new RawIngestService({ root, now: FROZEN_NOW })
    const res = raw.ingestText({ text: RAW_ARTICLE, title: "Compiled KB Notes" })
    expect(res.deduped).toBe(false)
    return res.raw
  }

  function makeCurator(llm: LLMCall) {
    return new CuratorCompileService({ db, root, llm, now: FROZEN_NOW, git: realGit(wikiRoot) })
  }

  it("one raw compiles into N pages + sources page in a SINGLE commit", async () => {
    const pointer = ingestFixture()
    const svc = makeCurator(async () => planFixture())

    const res = await svc.compileRaw(pointer)
    expect(res.changed).toBe(true)
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/)

    // 触 ≥3 页：3 计划页 + sources 回执页
    expect(res.touched).toHaveLength(4)
    const touchedPaths = res.touched.map(t => t.path).sort()
    expect(touchedPaths).toEqual([
      "concepts/con-compiled-rag.md",
      "entities/ent-karpathy.md",
      "sources/2026-10-13-compiled-kb-notes.md",
      "topics/top-wiki-ops.md",
    ])
    expect(res.created).toBe(4)
    expect(res.updated).toBe(0)

    // 四页真落盘（按 v3 type 进五类目录）
    for (const p of touchedPaths) {
      expect(fs.existsSync(path.join(wikiRoot, p)), p).toBe(true)
    }

    // 单一 commit：仓史只有这一个，且五产物同 commit（prototype DIFF 卡「INDEX/LOG ✓」）
    expect(realGit(wikiRoot).run(["rev-list", "--count", "HEAD"]).stdout.trim()).toBe("1")
    const show = realGit(wikiRoot).run(["show", "--name-only", "--format=", "HEAD"]).stdout.split(/\r?\n/)
    for (const f of [...touchedPaths, "INDEX.md", "LOG.md"]) expect(show).toContain(f)

    // 锚点由服务发号（空库 max=0 ⇒ oct-001/oct-002；LLM 不许自主编号）
    const topic = fs.readFileSync(path.join(wikiRoot, "topics", "top-wiki-ops.md"), "utf-8")
    expect(topic).toContain("<!--#oct-001-->")
    expect(topic).toContain("<!--#oct-002-->")
    expect(topic).not.toContain("oct-NEW")

    // sources 页 front-matter 回指 raw（type:source，sources 含 raw 路径）
    const src = fs.readFileSync(path.join(wikiRoot, "sources", "2026-10-13-compiled-kb-notes.md"), "utf-8")
    expect(src).toContain("type: source")
    expect(src).toContain("sources: [raw/inbox/2026-10-13-compiled-kb-notes.md]")

    // INDEX 程序化重建含四页；LOG 一行 ingest 动作
    const index = fs.readFileSync(path.join(wikiRoot, "INDEX.md"), "utf-8")
    expect(index).toContain("- topics/top-wiki-ops.md —")
    expect(index).toContain("- sources/2026-10-13-compiled-kb-notes.md —")
    const log = fs.readFileSync(path.join(wikiRoot, "LOG.md"), "utf-8")
    expect((log.match(/^## \[/gm) ?? []).length).toBe(1)
    expect(log).toContain("| Compiled KB Notes")
    expect(log).toContain("触 4 页 · 新页 4")

    // DB/FTS 同步（org 钉 global，domain 列存 v3 type 值）
    const dao = new WikiArticleDAO(db)
    expect(dao.get(GLOBAL_WIKI_ORG, "con-compiled-rag")?.domain).toBe("concept")
    expect(dao.get(GLOBAL_WIKI_ORG, "ent-karpathy")?.title).toBe("Karpathy")
    expect(dao.search(GLOBAL_WIKI_ORG, "Karpathy").length).toBeGreaterThan(0)
  })

  it("prompt carries SCHEMA.md, INDEX.md, full raw text, and existing page bodies（编译前必读）", async () => {
    const pointer = ingestFixture()
    const captured: string[] = []
    const svc = makeCurator(async (p) => { captured.push(p); return planFixture() })
    await svc.compileRaw(pointer)

    expect(captured).toHaveLength(1)
    const prompt = captured[0]
    // SCHEMA.md 全文进 prompt（层 3 必读）
    expect(prompt).toContain("# SCHEMA.md — wiki 共演约定")
    expect(prompt).toContain("编译纪律")
    // raw 全文进 prompt（全文读，非摘要）
    expect(prompt).toContain("A compiled knowledge base moves retrieval work from query time to maintenance time.")
    // raw 指针（路径/hash/origin）进 prompt（矛盾可对质用）
    expect(prompt).toContain(pointer.path)
    // 空库首编译有明确标记；INDEX 段存在
    expect(prompt).toMatch(/INDEX\.md/)
    expect(prompt).toContain("首编译")
    // 输出契约：op/type/八-NEW 锚点纪律说明在 prompt 内
    expect(prompt).toContain("oct-NEW")
  })

  it("seeds SCHEMA.md at the knowledge root before compiling（幂等 seed）", async () => {
    const pointer = ingestFixture()
    expect(fs.existsSync(path.join(root, "SCHEMA.md"))).toBe(false)
    await makeCurator(async () => planFixture()).compileRaw(pointer)
    expect(fs.readFileSync(path.join(root, "SCHEMA.md"), "utf-8")).toContain("唯一写闸")
  })

  // ── AC3 矛盾处置：两页标记 + finding 产出；不静默覆盖、不阻塞编译 ──
  it("contradiction: marks both pages, keeps old claim verbatim, writes an open finding — compile still commits", async () => {
    // 现库旧页（v3 topic，断言 + 存活锚点）经单页写闸先行入库
    const compiler = new WikiCompileService({ db, org: GLOBAL_WIKI_ORG, rootDir: wikiRoot, git: realGit(wikiRoot) })
    await compiler.compileEntry({
      content: `---
id: top-knowledge-injection
type: topic
title: 知识注入机制
summary: 引擎预计算注入规则进 prompt 的旧轨道
links: []
sources: [raw/archives/legacy.md]
last_compiled: 2026-10-11
stability: stable
---

## SOP
规则命中后由引擎注入执行 prompt。

## 硬约束
- 规则由引擎预计算注入 prompt <!--#oct-001-->
`,
    })

    const pointer = ingestFixture()
    const plan = JSON.stringify({
      pages: [{
        op: "create", type: "concept", id: "con-compiled-rag",
        title: "Compiled RAG", summary: "检索重活挪到维护编译时",
        links: ["top-knowledge-injection"],
        body: "## 定义\n检索的重活从查询时挪到维护编译时：编译成页，按需整读，不再每次推导。\n",
      }],
      key_points: ["编译式知识基座取代注入式轨道"],
      contradictions: [{
        new_page: "con-compiled-rag",
        old_page: "topics/top-knowledge-injection.md",
        old_claim: "规则由引擎预计算注入 prompt",
        new_claim: "检索重活挪到维护编译时",
      }],
    })
    const res = await makeCurator(async () => plan).compileRaw(pointer)

    expect(res.contradictions).toBe(1)
    expect(res.findingIds).toHaveLength(1)
    expect(res.changed).toBe(true)
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/)
    // 触及 = 新页 + 旧页（被标记）+ 回执页；旧页整包进同一 commit（单一写闸）
    const touchedPaths = res.touched.map(t => t.path)
    expect(touchedPaths).toContain("concepts/con-compiled-rag.md")
    expect(touchedPaths).toContain("topics/top-knowledge-injection.md")
    expect(touchedPaths).toContain("sources/2026-10-13-compiled-kb-notes.md")

    // 两页内矛盾标记（finding id 可解析）
    const findingId = res.findingIds[0]
    const oldFile = fs.readFileSync(path.join(wikiRoot, "topics", "top-knowledge-injection.md"), "utf-8")
    const newFile = fs.readFileSync(path.join(wikiRoot, "concepts", "con-compiled-rag.md"), "utf-8")
    expect(oldFile).toContain("## 冲突待裁决")
    expect(oldFile).toContain(findingId)
    expect(newFile).toContain("## 冲突待裁决")
    expect(newFile).toContain(findingId)

    // 不静默覆盖：旧断言原行原锚点在盘保留
    expect(oldFile).toContain("- 规则由引擎预计算注入 prompt <!--#oct-001-->")
    expect(newFile).toContain("检索的重活从查询时挪到维护编译时")

    // finding 行：open / contradiction / 双方页 / 回指 raw（本票只产不裁）
    const fdao = new FindingsDAO(db)
    const f = fdao.getById(findingId)!
    expect(f.status).toBe("open")
    expect(f.kind).toBe("contradiction")
    expect(JSON.parse(f.pages)).toEqual(["topics/top-knowledge-injection.md", "concepts/con-compiled-rag.md"])
    expect(f.raw_ref).toBe(pointer.path)
    const detail = JSON.parse(f.detail)
    expect(detail.old_claim).toBe("规则由引擎预计算注入 prompt")
    expect(detail.raw.hash).toBe(pointer.hash)
    expect(fdao.countOpen()).toBe(1)

    // 单一 commit 含全部三页
    const show = realGit(wikiRoot).run(["show", "--name-only", "--format=", "HEAD"]).stdout.split(/\r?\n/)
    expect(show).toContain("topics/top-knowledge-injection.md")
    expect(show).toContain("concepts/con-compiled-rag.md")
    expect(show).toContain("sources/2026-10-13-compiled-kb-notes.md")
  })

  it("rejects contradiction against a v2-form legacy page with a readable code（重蒸馏属票07）", async () => {
    const compiler = new WikiCompileService({ db, org: GLOBAL_WIKI_ORG, rootDir: wikiRoot, git: realGit(wikiRoot) })
    await compiler.compileEntry({
      content: `---
id: wf-old
domain: workflows
title: 旧轨道词条
summary: v2 形态存量
topics: []
stability: stable
last_compiled: 2026-10-01
sources: []
confidence: 0.6
---

## 规则
- 旧词条断言 <!--#oct-009-->
`,
    })
    const pointer = ingestFixture()
    const plan = JSON.stringify({
      pages: [{ op: "create", type: "concept", id: "con-new", title: "新概念", summary: "s", body: "## 定义\n新断言。\n" }],
      key_points: ["k"],
      contradictions: [{ new_page: "con-new", old_page: "workflows/wf-old.md", old_claim: "旧词条断言", new_claim: "新断言" }],
    })
    const err = await makeCurator(async () => plan).compileRaw(pointer).catch(e => e)
    expect(String(err.message)).toMatch(/CURATOR_CONTRADICTION_TARGET_LEGACY/)
    // 零半成品：v2 旧页未被触碰，新页未落盘，无新 commit
    expect(fs.existsSync(path.join(wikiRoot, "concepts", "con-new.md"))).toBe(false)
    expect(freshCommits()).toBe(1) // 只有 seed 的那一个
  })

  // ── sources 回指：必须可解析断言（从页面机械取出并与 raw 实算互验）──
  it("sources page back-reference is a mechanically parseable assertion matching the real raw file", async () => {
    const pointer = ingestFixture()
    await makeCurator(async () => planFixture()).compileRaw(pointer)
    const src = fs.readFileSync(path.join(wikiRoot, "sources", "2026-10-13-compiled-kb-notes.md"), "utf-8")

    // 独立解析（正则口径写进 SCHEMA/票面）：- raw: <路径> / - sha256: <64hex>
    const pathM = /^- raw: (raw\/\S+\.md)$/m.exec(src)
    const hashM = /^- sha256: ([0-9a-f]{64})$/m.exec(src)
    expect(pathM, "sources 页含可解析 raw 路径回指").not.toBeNull()
    expect(hashM, "sources 页含可解析 sha256 回指").not.toBeNull()
    expect(pathM![1]).toBe(pointer.path)
    // 与 raw 文件实算互验（读盘、剥 front-matter、重算）
    const rawAbs = path.join(root, pathM![1])
    const rawText = fs.readFileSync(rawAbs, "utf-8")
    const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(rawText)
    const payload = fm ? rawText.slice(fm[0].length) : rawText
    const recomputed = crypto.createHash("sha256").update(payload, "utf-8").digest("hex")
    expect(hashM![1]).toBe(recomputed)
    expect(recomputed).toBe(pointer.hash)

    // 触及页清单也在页面上，且每项 [[id]] 对应真实落盘页（回指闭环）
    const touchedSection = /## 触及页清单\n([\s\S]*?)\n\n/.exec(src)
    expect(touchedSection).not.toBeNull()
    for (const m of touchedSection![1].matchAll(/\[\[([a-z0-9-]+)\]\]/g)) {
      const rel = m[1]
      // id → 盘上找文件（五类目录 + 文件名以 id 开头或等于 id）
      const found = ["entities", "concepts", "topics", "sources", "cases"].some(d =>
        fs.existsSync(path.join(wikiRoot, d, `${rel}.md`)))
      expect(found, `触及页 [[${rel}]] 必须真实落盘`).toBe(true)
    }
  })

  // ── S1 幂等：同 raw 重编译 diff 空 ──
  it("recompiling the same raw is a no-op：diff 空、无新 commit、零 LOG 噪音", async () => {
    const pointer = ingestFixture()
    const svc = makeCurator(async () => planFixture())
    const first = await svc.compileRaw(pointer)
    expect(first.changed).toBe(true)

    const beforeIndex = fs.readFileSync(path.join(wikiRoot, "INDEX.md"), "utf-8")
    const beforeLog = fs.readFileSync(path.join(wikiRoot, "LOG.md"), "utf-8")
    const beforeCount = freshCommits()

    const second = await svc.compileRaw(pointer)
    expect(second.deduped).toBe(true)
    expect(second.changed).toBe(false)
    expect(second.commit).toBeNull()
    expect(second.touched.map(t => t.path)).toEqual(first.touched.map(t => t.path))

    expect(freshCommits()).toBe(beforeCount)
    expect(fs.readFileSync(path.join(wikiRoot, "INDEX.md"), "utf-8")).toBe(beforeIndex)
    expect(fs.readFileSync(path.join(wikiRoot, "LOG.md"), "utf-8")).toBe(beforeLog)
    expect(realGit(wikiRoot).run(["status", "--porcelain"]).stdout.trim()).toBe("")
  })

  it("invalid plan gets ONE self-correction round with the error echoed back", async () => {
    const pointer = ingestFixture()
    const badPlan = JSON.stringify({
      pages: [{ op: "create", type: "concept", id: "con-x", title: "T", summary: "S", stability: "volatile", body: "## 定义\n无 review_after 的 volatile 页。\n" }],
      key_points: ["k"],
      contradictions: [],
    })
    const captured: string[] = []
    let n = 0
    const svc = makeCurator(async (p) => { captured.push(p); n++; return n === 1 ? badPlan : planFixture() })
    const res = await svc.compileRaw(pointer)
    expect(res.changed).toBe(true)
    expect(captured).toHaveLength(2)
    expect(captured[1]).toContain("上一次输出校验失败")
    expect(captured[1]).toContain("review_after")
    expect(res.warnings.some(w => w.includes("自纠"))).toBe(true)
  })

  it("two invalid plans abort with CURATOR_LLM_JSON（自纠只一轮，不无限重试）", async () => {
    const pointer = ingestFixture()
    const badPlan = JSON.stringify({
      pages: [{ op: "create", type: "concept", id: "con-x", title: "T", summary: "S", stability: "volatile", body: "## 定义\n坏。\n" }],
      key_points: [],
      contradictions: [],
    })
    const err = await makeCurator(async () => badPlan).compileRaw(pointer).catch(e => e)
    expect(String(err.message)).toMatch(/CURATOR_LLM_JSON/)
    expect(fs.existsSync(path.join(wikiRoot, "concepts", "con-x.md"))).toBe(false)
    expect(freshCommits()).toBe(0)
  })

  it("LLM garbage aborts with zero traces（验证段先于一切副作用）", async () => {
    const pointer = ingestFixture()
    const err = await makeCurator(async () => "抱歉，我无法输出 JSON。").compileRaw(pointer).catch(e => e)
    expect(String(err.message)).toMatch(/CURATOR_LLM_JSON/)
    expect(fs.existsSync(path.join(wikiRoot, "entities"))).toBe(true) // 骨架目录可有
    // 但零页产物、零 INDEX/LOG、零 commit
    for (const d of ["entities", "concepts", "topics", "sources", "cases"]) {
      const files = fs.readdirSync(path.join(wikiRoot, d)).filter(n => n.endsWith(".md"))
      expect(files, d).toHaveLength(0)
    }
    expect(fs.existsSync(path.join(wikiRoot, "INDEX.md"))).toBe(false)
    expect(freshCommits()).toBe(0)
  })

  function freshCommits(): number {
    if (!fs.existsSync(path.join(wikiRoot, ".git"))) return 0
    const out = realGit(wikiRoot).run(["rev-list", "--count", "HEAD"])
    return out.status === 0 ? Number(out.stdout.trim()) : 0
  }
})
