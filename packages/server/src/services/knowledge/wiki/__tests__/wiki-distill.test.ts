import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import crypto from "crypto"
import { spawnSync } from "child_process"
import { applySchema } from "../../../../db/schema"
import { PendingReviewDAO } from "../../../../db/dao/pending-review-dao"
import { ReviewService } from "../../review"
import { WikiDistillService, createLLMDistillSummarizer, listDistillSources, type DistillSummarizer } from "../distill"
import { parseEntryMarkdown } from "../format"
import { scanWikiEntries } from "../compile"
import { WikiCurateService } from "../curate"
import { spawnGit, type GitRunner } from "../wiki-git"

/**
 * S1 缝（票07 蒸馏迁移）— wiki-migrate.test.ts 同先例：真 fs tmpdir + in-memory DB + 真 git。
 * fixture 文档全部合成（docs/research/ 与 docs/adr/ 各形一篇），绝不碰仓库真实 docs。
 * LLM 蒸馏器 = 注入的 fixture-mocked summarizer（spec Testing Decisions：测试不打真模型）。
 * 只断言外部产物：pending_review 行 / createEntry 草案（schema 合规 + 三段式 + doc: 指针）/
 * 盘上零写入（候选未采纳不落词条）。Expected 值来自独立真相源：fixture 手搓 +
 * prototype Tab③ 初始编译表 lines 625-626 + 票面「结论+决策依据+来源指针 / 决策+理由+指针」。
 */

const realGit = (cwd: string): GitRunner => spawnGit(cwd)

const sha12 = (text: string): string =>
  crypto.createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 12)

// ── fixture 源文档（合成；形状对照真实 docs/adr 头 + research 报告体）──
const RESEARCH_DOC = `# Agent 可观测性调研

## 结论

调研发现 OTel span 树是唯一能贯穿 workflow→agent→LLM 三层的观测原语。

\`\`\`ts
const span = tracer.startSpan("node.exec")
\`\`\`
`

const ADR_DOC = `# ADR-0099: 测试决议 — fixture 形态

- 状态: Accepted
- 日期: 2026-09-01

## 决策

蒸馏候选一律走审核队列，不自动写 wiki。

## 理由

自动写会绕过人审闸门，破坏单一写入口纪律。
`

// ── fixture-mocked LLM 蒸馏输出（逐篇钉死，非被测实现反推）──
const SUMMARY_TABLE: Record<string, { conclusion: string[]; rationale: string[] }> = {
  "docs/research/agent-observability.md": {
    conclusion: ["OTel span 树是能贯穿 workflow→agent→LLM 三层的观测原语"],
    rationale: ["三层各自有独立日志但无法关联；span 的 traceId 天然贯穿"],
  },
  "docs/adr/0099-test-decision.md": {
    conclusion: ["蒸馏候选一律走审核队列，不自动写 wiki"],
    rationale: ["自动写会绕过人审闸门，破坏单一写入口纪律"],
  },
}

const fixtureSummarizer: DistillSummarizer = async (doc) => SUMMARY_TABLE[doc.relPath]!

describe("distill migration (ticket 07)", () => {
  let db: Database.Database
  let tmpDir: string
  let root: string
  let docsRoot: string
  let pending: PendingReviewDAO

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    pending = new PendingReviewDAO(db)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-distill-"))
    root = path.join(tmpDir, "wiki")
    docsRoot = path.join(tmpDir, "docs")
    fs.mkdirSync(path.join(docsRoot, "research"), { recursive: true })
    fs.mkdirSync(path.join(docsRoot, "adr"), { recursive: true })
    fs.writeFileSync(path.join(docsRoot, "research", "agent-observability.md"), RESEARCH_DOC, "utf-8")
    fs.writeFileSync(path.join(docsRoot, "adr", "0099-test-decision.md"), ADR_DOC, "utf-8")
  })

  afterEach(() => {
    db?.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function makeDistiller(over: Partial<ConstructorParameters<typeof WikiDistillService>[0]> = {}) {
    return new WikiDistillService({
      db,
      org: "testorg",
      rootDir: root,
      docsRoot,
      summarizer: fixtureSummarizer,
      ...over,
    })
  }

  it("docs/research file → research/ 域候选词条（结论+决策依据+来源指针三段式）批量入 pending_review，盘上零写入", async () => {
    const report = await makeDistiller().run()

    // ── report：每篇源文件对应一条可追溯候选
    expect(report.queued.map(q => q.source).sort()).toEqual([
      "docs/adr/0099-test-decision.md",
      "docs/research/agent-observability.md",
    ])
    expect(report.failed).toEqual([])

    // ── 队列行形状（票06 采纳通道契约）
    const rel = "docs/research/agent-observability.md"
    const expectedId = `wiki-distill-testorg-res-agent-observability-${sha12(fs.readFileSync(path.join(docsRoot, "research", "agent-observability.md"), "utf-8"))}`
    const row = pending.getById(expectedId)
    expect(row).toBeDefined()
    expect(row!.type).toBe("wiki-edit")
    expect(row!.source).toBe("distill-migration")
    expect(row!.source_ref).toBe(`${rel}#${sha12(RESEARCH_DOC)}`)
    expect(row!.target_file).toBe("research/res-agent-observability.md")
    expect(row!.scope).toBe("wiki")
    expect(row!.status).toBe("pending")
    expect(row!.auto_approve).toBe(0)

    // ── wiki 桶可见（/api/review/summary，票02 扩展）
    expect(pending.countPendingByType().wiki).toBe(2)

    // ── createEntry 草案 = schema 合规词条，三段式，doc: 指针回跳原文
    const payload = JSON.parse(row!.content) as { kind: string; path: string; createEntry: string }
    expect(payload.kind).toBe("wiki-edit")
    expect(payload.path).toBe("research/res-agent-observability.md")
    const { meta, body } = parseEntryMarkdown(payload.createEntry)
    expect(meta.id).toBe("res-agent-observability")
    expect(meta.domain).toBe("research")
    expect(meta.stability).toBe("stable")
    expect(meta.sources).toEqual([`doc:${rel}`])
    expect(body).toContain("## 结论")
    expect(body).toContain("## 决策依据")
    expect(body).toContain("## 来源指针")
    // fixture 蒸馏输出逐字进结论段（非原文摘抄）
    expect(body).toContain("OTel span 树是能贯穿 workflow→agent→LLM 三层的观测原语")
    expect(body).toContain("三层各自有独立日志但无法关联；span 的 traceId 天然贯穿")
    // 原文正文零改动前提下，候选未采纳 ⇒ wiki 盘上不得出现词条
    expect(fs.existsSync(path.join(root, "research", "res-agent-observability.md"))).toBe(false)
  })

  it("docs/adr file → business/ 域决策词条草案（决策+理由+来源指针三段式）", async () => {
    await makeDistiller().run()

    const row = pending.getById(`wiki-distill-testorg-biz-adr-0099-test-decision-${sha12(ADR_DOC)}`)
    expect(row).toBeDefined()
    expect(row!.target_file).toBe("business/biz-adr-0099-test-decision.md")

    const payload = JSON.parse(row!.content) as { createEntry: string }
    const { meta, body } = parseEntryMarkdown(payload.createEntry)
    expect(meta.id).toBe("biz-adr-0099-test-decision")
    expect(meta.domain).toBe("business")
    expect(meta.sources).toEqual(["doc:docs/adr/0099-test-decision.md"])
    // 票面逐字：ADR 三段 = 决策 + 理由 + 指针（非 research 的结论/决策依据）
    expect(body).toContain("## 决策")
    expect(body).toContain("## 理由")
    expect(body).toContain("## 来源指针")
    expect(body).toContain("蒸馏候选一律走审核队列，不自动写 wiki")
    // 原文元数据行（状态/日期）不随蒸馏进正文——ADR 文档头带日期，测试固化该防线
    expect(body).not.toContain("2026-09-01")
  })

  it("幂等：重跑不重复入队（指纹行已存在 ⇒ skipped）；源文件变更 ⇒ 新指纹新候选、旧行留档", async () => {
    const first = await makeDistiller().run()
    expect(first.totals.queued).toBe(2)

    const second = await makeDistiller().run()
    expect(second.queued).toEqual([])
    expect(second.skipped.sort()).toEqual([
      "docs/adr/0099-test-decision.md",
      "docs/research/agent-observability.md",
    ])
    // 队列行数不变 = 幂等的外部证明（对照 spec：重跑 diff 为空）
    expect(pending.listPending(undefined, undefined, 1, 100).total).toBe(2)

    // 源文件改动 → 指纹变 → 允许产生新候选（旧指纹行不动）
    fs.writeFileSync(path.join(docsRoot, "research", "agent-observability.md"), RESEARCH_DOC + "\n补充：OTel v2 语义约定已稳定。\n", "utf-8")
    const third = await makeDistiller().run()
    expect(third.queued.map(q => q.source)).toEqual(["docs/research/agent-observability.md"])
    expect(pending.listPending(undefined, undefined, 1, 100).total).toBe(3)
    expect(pending.getById(`wiki-distill-testorg-res-agent-observability-${sha12(RESEARCH_DOC)}`)).toBeDefined()
  })

  it("拒绝项留档不写入：rejected 后重跑既不复活也不落盘", async () => {
    await makeDistiller().run()
    const itemId = `wiki-distill-testorg-res-agent-observability-${sha12(RESEARCH_DOC)}`
    pending.updateStatus(itemId, "rejected", "质量不符")

    const report = await makeDistiller().run()
    // 已裁决（rejected）的指纹行 ⇒ 跳过，不重复入队
    expect(report.skipped).toContain("docs/research/agent-observability.md")
    const row = pending.getById(itemId)!
    expect(row.status).toBe("rejected")
    expect(row.user_notes).toBe("质量不符")
    // 拒绝 ⇒ 永不写盘（写入只属票06 采纳通道）
    expect(fs.existsSync(path.join(root, "research", "res-agent-observability.md"))).toBe(false)
  })

  it("质量控制：LLM 摘抄围栏代码块/日期 ⇒ 机械净化后不入候选；超限大段 ⇒ lint L1 拦下记 failed 不入队", async () => {
    // (a) 把 25 行代码块当「一条要点」贴回（内嵌换行）+ 日期行 ⇒ 净化必须整段剔除
    const messy: DistillSummarizer = async () => ({
      conclusion: [
        "OTel span 树可贯穿三层（详见下方代码）",
        "```ts\n" + Array.from({ length: 25 }, (_, i) => `const x${i} = i`).join("\n") + "\n```",
        "结论写于 2026-08-08 前后",
      ],
      rationale: ["span 的 traceId 天然贯穿；参考 [[某词条]] 链接"],
    })
    const r1 = await makeDistiller({ summarizer: messy }).run()
    expect(r1.queued.map(q => q.source).sort()).toEqual([
      "docs/adr/0099-test-decision.md",
      "docs/research/agent-observability.md",
    ])
    const row = pending.getById(r1.queued.find(q => q.source === "docs/research/agent-observability.md")!.itemId)!
    const entryA = parseEntryMarkdown((JSON.parse(row.content) as { createEntry: string }).createEntry)
    expect(entryA.body).not.toContain("```")
    expect(entryA.body).not.toContain("const x0")
    expect(entryA.body).not.toContain("2026-08-08")
    expect(entryA.body).not.toContain("[[") // 断链形态去除（L5_LINK_BROKEN 防线）
    expect(entryA.body).toContain("OTel span 树可贯穿三层")
    // 单条要点内闭合的围栏块不得吞掉后续要点（内嵌换行的净化必须按行展开）
    expect(entryA.body).toContain("结论写于")
    expect(entryA.body).toContain("traceId")

    // (b) 超限：6+6 段 200 字 CJK ≈ 2400 token > L1 的 2000 ⇒ 拦下返工，不入队
    const fat: DistillSummarizer = async () => ({
      conclusion: Array.from({ length: 6 }, () => "观".repeat(200)),
      rationale: Array.from({ length: 6 }, () => "测".repeat(200)),
    })
    const freshDocs = path.join(tmpDir, "docs2")
    fs.mkdirSync(path.join(freshDocs, "research"), { recursive: true })
    fs.writeFileSync(path.join(freshDocs, "research", "fat.md"), "# Fat\n", "utf-8")
    const r2 = await makeDistiller({ summarizer: fat, docsRoot: freshDocs }).run()
    expect(r2.queued).toEqual([])
    expect(r2.failed).toHaveLength(1)
    expect(r2.failed[0].source).toBe("docs/research/fat.md")
    expect(r2.failed[0].error).toContain("DISTILL_LINT_REJECTED")
    expect(r2.failed[0].error).toContain("L1_CAPACITY")
    expect(pending.listPending(undefined, undefined, 1, 100).total).toBe(2) // 只有 (a) 的两行
  })

  it("蒸馏结果为空 ⇒ 不产候选（DISTILL_EMPTY_CONCLUSION 记 failed）；嵌套子目录逐篇可追溯", async () => {
    const empty: DistillSummarizer = async (doc) =>
      doc.relPath === "docs/research/knowledge-system/README.md"
        ? { conclusion: [], rationale: [] }
        : fixtureSummarizer(doc)
    fs.mkdirSync(path.join(docsRoot, "research", "knowledge-system"), { recursive: true })
    fs.writeFileSync(path.join(docsRoot, "research", "knowledge-system", "README.md"), "# 知识系统蓝图总览\n", "utf-8")

    const report = await makeDistiller({ summarizer: empty }).run()
    // 每个源文件 ⇒ 一条可追溯候选（嵌套目录也在蒸馏对象内）
    expect(report.queued.map(q => q.entryId).sort()).toEqual([
      "biz-adr-0099-test-decision",
      "res-agent-observability",
    ])
    expect(report.failed).toEqual([
      { source: "docs/research/knowledge-system/README.md", error: expect.stringContaining("DISTILL_EMPTY_CONCLUSION") },
    ])
    // 原文零改动（红线：docs 留档即权威，蒸馏只读）
    expect(fs.readFileSync(path.join(docsRoot, "research", "knowledge-system", "README.md"), "utf-8")).toBe("# 知识系统蓝图总览\n")
  })

  it("采纳走票06 策展通道：approveItem → createEntry 编译落 research/ 域（LOG+git [review:id]+doc: 指针回跳）；拒绝项永不写盘", async () => {
    // 蒸馏前文档快照（红线验证基线）
    const docHashes = Object.fromEntries(
      listDistillSources(docsRoot).map(s => [s.rel, sha12(fs.readFileSync(s.abs, "utf-8"))]),
    )

    const report = await makeDistiller().run()
    const adoptId = report.queued.find(q => q.source.startsWith("docs/research"))!.itemId
    const rejectId = report.queued.find(q => q.source.startsWith("docs/adr"))!.itemId

    // 生产同法接线（index.ts）：审核采纳 = ReviewService.approveItem → WikiCurateService
    const curate = new WikiCurateService({ db, org: "testorg", rootDir: root, git: realGit(root) })
    const review = new ReviewService(pending, { applyWikiCurate: async item => curate.applyApprovedItem(item) })

    await review.approveItem(adoptId, "testorg")
    review.rejectItem(rejectId, "暂不收录")

    // ── 采纳产物：词条落 research/ 域，front-matter 保 doc: 指针
    const entryAbs = path.join(root, "research", "res-agent-observability.md")
    expect(fs.existsSync(entryAbs)).toBe(true)
    const { meta, body } = parseEntryMarkdown(fs.readFileSync(entryAbs, "utf-8"))
    expect(meta.domain).toBe("research")
    expect(meta.sources).toContain("doc:docs/research/agent-observability.md") // 回跳原文
    expect(body).toContain("## 来源指针")

    // ── 词条进盘扫描（/wiki tree 的 research 域可见性底座）
    expect(scanWikiEntries(root).some(e => e.relPath === "research/res-agent-observability.md")).toBe(true)

    // ── LOG 编译行 + git commit 带审核引用（票06 curate 通道标记）
    const log = fs.readFileSync(path.join(root, "LOG.md"), "utf-8")
    expect(log).toContain(`research/res-agent-observability.md`)
    const gitLog = spawnSync("git", ["log", "--format=%s"], { cwd: root, encoding: "utf-8" }).stdout
    expect(gitLog).toContain(`[review:${adoptId}]`)

    // ── 状态流转 + 拒绝项留档不写入
    expect(pending.getById(adoptId)!.status).toBe("approved")
    expect(pending.getById(rejectId)!.status).toBe("rejected")
    expect(fs.existsSync(path.join(root, "business", "biz-adr-0099-test-decision.md"))).toBe(false)

    // ── 红线：原文正文零改动（蒸馏+采纳全程只读 docs/）
    for (const s of listDistillSources(docsRoot)) {
      expect(sha12(fs.readFileSync(s.abs, "utf-8"))).toBe(docHashes[s.rel])
    }
  })

  it("LLM seam：createLLMDistillSummarizer 走注入的 llmCall（捕获 prompt、解析 JSON 草案）；真模型缺席 ⇒ 启发式兜底且不抄代码块/日期", async () => {
    // 每个蒸馏器形态用独立 fresh DB+root：行 id=源文件指纹（与蒸馏器无关），
    // 同库跑两遍会被幂等闸正确跳过——seam 对比必须在不同幂等空间做。
    const runFresh = async (label: string, summarizer?: DistillSummarizer) => {
      const db2 = new Database(":memory:")
      applySchema(db2)
      const p2 = new PendingReviewDAO(db2)
      const rep = await new WikiDistillService({
        db: db2,
        org: "testorg",
        rootDir: path.join(tmpDir, `wiki-${label}`),
        docsRoot,
        ...(summarizer ? { summarizer } : {}),
      }).run()
      return { rep, p2, close: () => db2.close() }
    }

    // (a) fixture-mocked llmCall：返回围栏包 JSON ⇒ 蒸馏行逐字进候选
    const prompts: string[] = []
    const fakeLlm = async (prompt: string) => {
      prompts.push(prompt)
      return "```json\n" + JSON.stringify({
        conclusion: ["LLM 蒸馏结论：可观测性三层贯通靠 span"],
        rationale: ["LLM 蒸馏依据：独立日志无法关联"],
      }) + "\n```"
    }
    const a = await runFresh("llm", createLLMDistillSummarizer(fakeLlm))
    try {
      expect(a.rep.queued).toHaveLength(2)
      expect(prompts).toHaveLength(2) // 每个源文档调用一次（不打真模型——fake 捕获）
      expect(prompts.some(p => p.includes("OTel span"))).toBe(true) // 原文正文随 prompt 交给模型
      const rowA = a.p2.getById(a.rep.queued.find(q => q.source.startsWith("docs/research"))!.itemId)!
      expect((JSON.parse(rowA.content) as { createEntry: string }).createEntry)
        .toContain("LLM 蒸馏结论：可观测性三层贯通靠 span")
    } finally { a.close() }

    // (b) llmCall 抛错（未配 provider）⇒ 逐篇启发式兜底：H2「结论」段正文，代码块零摘抄
    const boom = async () => { throw new Error("NO_PROVIDER") }
    const b = await runFresh("fallback", createLLMDistillSummarizer(boom))
    try {
      expect(b.rep.queued).toHaveLength(2)
      expect(b.rep.failed).toEqual([])
      const rowB = b.p2.getById(b.rep.queued.find(q => q.source === "docs/research/agent-observability.md")!.itemId)!
      const entryB = parseEntryMarkdown((JSON.parse(rowB.content) as { createEntry: string }).createEntry)
      expect(entryB.body).toContain("调研发现 OTel span 树是唯一能贯穿 workflow→agent→LLM 三层的观测原语")
      expect(entryB.body).not.toContain("```")
    } finally { b.close() }

    // (c) 不注入 summarizer ⇒ 服务缺省启发式（离线可跑、无密钥部署同轨）
    const c = await runFresh("default")
    try {
      expect(c.rep.queued).toHaveLength(2)
      const rowC = c.p2.getById(c.rep.queued.find(q => q.source === "docs/adr/0099-test-decision.md")!.itemId)!
      const entryC = parseEntryMarkdown((JSON.parse(rowC.content) as { createEntry: string }).createEntry)
      // ADR 启发式：H2「决策」=结论段、「理由」=依据段；文档头 状态/日期 元数据行不进正文
      expect(entryC.body).toContain("蒸馏候选一律走审核队列，不自动写 wiki")
      expect(entryC.body).toContain("自动写会绕过人审闸门")
      expect(entryC.body).not.toContain("2026-09-01")
      expect(entryC.meta.domain).toBe("business")
    } finally { c.close() }
  })

  it("同词条二次采纳（源文件变更后的新指纹行）⇒ 策展通道 merged 不覆盖：词条/LOG/git 史零变化", async () => {
    const report = await makeDistiller().run()
    const curate = new WikiCurateService({ db, org: "testorg", rootDir: root, git: realGit(root) })
    const review = new ReviewService(pending, { applyWikiCurate: async item => curate.applyApprovedItem(item) })
    const adoptId = report.queued.find(q => q.source.startsWith("docs/research"))!.itemId
    await review.approveItem(adoptId, "testorg")

    const entryAbs = path.join(root, "research", "res-agent-observability.md")
    const entryBefore = fs.readFileSync(entryAbs, "utf-8")
    const logBefore = fs.readFileSync(path.join(root, "LOG.md"), "utf-8")
    const commitsBefore = spawnSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf-8" }).stdout.trim()

    // 源文件变更 → 新指纹行入队；采纳它时词条已在盘 ⇒ 保持现状（修订流属 wiki-edit replace，非重刷 createEntry）
    fs.writeFileSync(path.join(docsRoot, "research", "agent-observability.md"), RESEARCH_DOC + "\n补充要点。\n", "utf-8")
    const r2 = await makeDistiller().run()
    const secondId = r2.queued.find(q => q.source === "docs/research/agent-observability.md")!.itemId
    expect(secondId).not.toBe(adoptId)
    await review.approveItem(secondId, "testorg")

    expect(fs.readFileSync(entryAbs, "utf-8")).toBe(entryBefore)
    expect(fs.readFileSync(path.join(root, "LOG.md"), "utf-8")).toBe(logBefore)
    expect(spawnSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf-8" }).stdout.trim()).toBe(commitsBefore)
    expect(pending.getById(secondId)!.status).toBe("approved")
  })
})

