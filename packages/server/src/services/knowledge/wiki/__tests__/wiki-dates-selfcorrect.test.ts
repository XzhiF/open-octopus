import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { spawnSync } from "child_process"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../../../../db/schema"
import { RawIngestService } from "../../raw"
import { CuratorCompileService, type LLMCall } from "../curator"
import { CuratorTaskService } from "../curator-task"
import { CompileQueue } from "../compile-queue"
import { findDateOccurrences, parseWikiFile } from "../format"
import type { GitRunner } from "../wiki-git"

/**
 * 票07 · D-kc15-1 编译自纠环 S1（spec §清理账 / 故事30）。
 *
 * 缺陷现场（KC e2e-report D-kc15-1）：含日期的一手源恒失败于 L5_DATES_IN_BODY 硬闸，
 * API 编译面无 lint 自纠循环（Karpathy llm-wiki gist 连投两连败）。
 * 复现靶 = gist 冻结件的**日期形态**构造 fixture（`2026-10-13` ISO 与
 * `## [2026-04-02] ingest | Article Title` grep 前缀例——真文件只读、测试全程 tmpdir，
 * 不碰真 ~/.octopus）。
 *
 * Seam（spec Testing Decisions S1 行）：真 fs + in-memory DB + 真 git + LLM seam mock
 * （捕获 prompt）。断言只落外部行为：fs 产物 / 结果形状 / 闸不放松 / 一轮上限。
 * Expected 独立真相源 = 票面 AC + lint.ts 闸定义（L5 正文零日期、锚点存活不可删改）。
 */

const realGit = (cwd: string): GitRunner => ({
  run(args: string[]) {
    const r = spawnSync("git", args, { cwd, timeout: 30000, env: { ...process.env, OCTOPUS_WIKI_COMMIT_SOURCE: "curate" } })
    return { status: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
  },
})

const FROZEN_NOW = () => new Date("2026-10-13T08:00:00.000Z")

/** gist 冻结件日期形态（原文含这两枚日期：'2026-10-13'、'2026-04-02'）。 */
const RAW_GIST_FORM = `# LLM Wiki — a gist-form source

Karpathy described this pattern on 2026-10-13.
A useful tip: log entries start with a grep-friendly prefix, e.g. \`## [2026-04-02] ingest | Article Title\`.
The wiki is a persistent, compounding artifact maintained by the LLM.
`

/** 失败形态复现：LLM 把源内日期抄进常青概念页（e2e 现场逐字形态——真实模型反复如此）。 */
function datedPlanFixture(): string {
  return JSON.stringify({
    pages: [
      {
        op: "create", type: "concept", id: "con-llm-wiki",
        title: "LLM Wiki 范式", summary: "编译型个人知识库范式",
        links: [],
        body: "## 定义\nKarpathy 于 2026-10-13 提出的编译型知识库范式：LLM 增量维护一座常青 wiki。\n\n## 操作\n日志行以 `## [2026-04-02] ingest | 标题` 形态开头可 grep。\n",
      },
      {
        op: "create", type: "topic", id: "top-log-format",
        title: "LOG 行格式纪律", summary: "grep 友好前缀纪律", links: [],
        body: "## 硬约束\n- LOG 行以 `## [2026-04-02] ingest | 标题` 形态开头 <!--#oct-NEW-->\n",
      },
    ],
    key_points: ["编译型知识库范式（gist）"],
    contradictions: [],
  })
}

/** 自纠改写产物（常青化措辞；锚点位保留 oct-NEW 占位由服务在首轮已发号 ⇒ 此处引用发号后的形态由测试断言，见下）。 */
function evergreenRewriteFor(anchorIssued: (s: string) => string): string {
  return anchorIssued(JSON.stringify({
    pages: [
      {
        id: "con-llm-wiki",
        body: "## 定义\nKarpathy 提出的编译型知识库范式：LLM 增量维护一座常青 wiki（时间由 sources 回执与 LOG 承接）。\n\n## 操作\n日志行以可 grep 的「日期 + 动作 + 标题」前缀形态开头。\n",
      },
      {
        id: "top-log-format",
        body: "## 硬约束\n- LOG 行以「日期 动作 | 标题」前缀形态开头，保证 `grep \"^## \\[\"` 可解析 {A}\n",
      },
    ],
  }))
}

describe("D-kc15-1 日期常青自纠环 — compileRaw L5_DATES_IN_BODY 一轮自纠（票07 S1）", () => {
  let db: Database.Database
  let tmpDir: string
  let root: string
  let wikiRoot: string

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-dates-sc-"))
    root = path.join(tmpDir, "knowledge")
    wikiRoot = path.join(root, "wiki")
    fs.mkdirSync(root, { recursive: true })
  })

  afterEach(() => {
    db?.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function ingestGist(): ReturnType<RawIngestService["ingestText"]>["raw"] {
    const raw = new RawIngestService({ root, now: FROZEN_NOW })
    const res = raw.ingestText({ text: RAW_GIST_FORM, title: "LLM Wiki Gist Form" })
    expect(res.deduped).toBe(false)
    return res.raw
  }

  function makeCurator(llm: LLMCall) {
    return new CuratorCompileService({ db, root, llm, now: FROZEN_NOW, git: realGit(wikiRoot) })
  }

  function freshCommits(): number {
    if (!fs.existsSync(path.join(wikiRoot, ".git"))) return 0
    const out = realGit(wikiRoot).run(["rev-list", "--count", "HEAD"])
    return out.status === 0 ? Number(out.stdout.trim()) : 0
  }

  /** 盘上页正文（剥 front-matter）的日期命中——与闸同口径的独立复核。 */
  function bodyDates(relPath: string): string[] {
    const parsed = parseWikiFile(fs.readFileSync(path.join(wikiRoot, relPath), "utf-8"))
    if (parsed.kind !== "page") throw new Error(`${relPath} 不是 v3 页`)
    return findDateOccurrences(parsed.body)
  }

  it("含日期源经一轮常青改写自纠后编译提交：产物零日期、锚点存活、自纠痕迹进 warnings", async () => {
    const pointer = ingestGist()
    const captured: string[] = []
    const svc = makeCurator(async (p) => {
      captured.push(p)
      // 第 2 拍 = 自纠改写请求：把 oct-NEW 占位换成第 1 拍已发号形态（首编译空库 ⇒ oct-001）
      return captured.length === 1 ? datedPlanFixture() : evergreenRewriteFor(s => s.replace("{A}", "<!--#oct-001-->"))
    })

    const res = await svc.compileRaw(pointer)

    // 终态 = 提交（缺陷原现场此处恒 failed；修复后自纠一轮过闸）
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(res.changed).toBe(true)

    // seam 行为：plan 1 拍 + 自纠改写 1 拍 = 恰 2 拍；改写 prompt 携带闸码与 offending 页证据
    expect(captured).toHaveLength(2)
    expect(captured[1]).toContain("L5_DATES_IN_BODY")
    expect(captured[1]).toContain("con-llm-wiki")
    expect(captured[1]).toContain("2026-10-13")

    // 落盘产物仍全量过闸：概念页/主题页正文零日期（独立复核，非抄实现）
    expect(bodyDates("concepts/con-llm-wiki.md")).toEqual([])
    expect(bodyDates("topics/top-log-format.md")).toEqual([])

    // 锚点存活：oct-NEW 由服务发号后，自纠改写仍保留该锚点位（永不复用/丢失纪律）
    const topicFile = fs.readFileSync(path.join(wikiRoot, "topics", "top-log-format.md"), "utf-8")
    expect(topicFile).toContain("<!--#oct-001-->")

    // 自纠痕迹可查（任务记录 result.warnings 面）
    expect(res.warnings.some(w => w.includes("日期") && w.includes("自纠"))).toBe(true)

    // sources 回执页正常生成（自纠不伤主链）
    expect(fs.existsSync(path.join(wikiRoot, "sources", "2026-10-13-llm-wiki-gist-form.md"))).toBe(true)
    expect(freshCommits()).toBe(1)
  })

  it("无日期源零额外调用：自纠环只在 L5 日期类失败时触发", async () => {
    const pointer = ingestGist()
    const cleanPlan = JSON.stringify({
      pages: [{ op: "create", type: "concept", id: "con-clean", title: "干净概念", summary: "s", body: "## 定义\n无日期正文。\n" }],
      key_points: ["k"], contradictions: [],
    })
    const captured: string[] = []
    const res = await makeCurator(async (p) => { captured.push(p); return cleanPlan }).compileRaw(pointer)
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(captured).toHaveLength(1)
    expect(res.warnings.some(w => w.includes("自纠"))).toBe(false)
  })

  it("复现靶真件：保留的 karpathy gist 冻结件（真盘只读复制进 tmp）自纠成功落库", async () => {
    // 票面「复现靶真验」的 S1 形态：缺陷现场用的就是这份真冻结件（两连败 L5_DATES_IN_BODY）。
    // 真盘只读——复制进 tmp 后编译；真 provider 真入队不在本票（票09 链⑤），LLM 仍 seam mock。
    const realGist = path.join(os.homedir(), ".octopus", "knowledge", "raw", "inbox", "2026-10-13-karpathy-llm-wiki-gist.md")
    if (!fs.existsSync(realGist)) return // 复现靶随 KC e2e 保留在本机；缺件诚实跳过（非静默假绿：下方断言全跑）

    const rel = "raw/inbox/2026-10-13-karpathy-llm-wiki-gist.md"
    fs.mkdirSync(path.join(root, "raw", "inbox"), { recursive: true })
    fs.copyFileSync(realGist, path.join(root, rel))

    let realCalls = 0
    const svc = makeCurator(async () => {
      realCalls++
      return realCalls === 1 ? datedPlanFixture() : evergreenRewriteFor(s => s.replace("{A}", "<!--#oct-001-->"))
    })
    const pointer = svc.resolveRawPointer(rel) // 冻结件 front-matter hash 三方互验（不可变契约在 compileRaw 内再算）
    expect(pointer.hash).toMatch(/^[0-9a-f]{64}$/)

    const res = await svc.compileRaw(pointer)
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(realCalls).toBe(2) // 计划拍 + 自纠改写拍
    expect(res.warnings.some(w => w.includes("日期常青自纠一轮"))).toBe(true)
    // 当时恒失败的真源现在能进：sources 回执页 + 常青概念页落盘、正文零日期
    expect(fs.existsSync(path.join(wikiRoot, "sources", "2026-10-13-karpathy-llm-wiki-gist.md"))).toBe(true)
    expect(bodyDates("concepts/con-llm-wiki.md")).toEqual([])
  })

  it("自纠一轮上限：改写仍带日期 ⇒ 终态败 + 痕迹可查 + 恰两拍 + 零半成品", async () => {
    const pointer = ingestGist()
    const captured: string[] = []
    const stubbornRewrite = JSON.stringify({
      pages: [
        { id: "con-llm-wiki", body: "## 定义\nKarpathy 于 2026-10-13 提出的范式——改写了但仍带日期。\n" },
        { id: "top-log-format", body: "## 硬约束\n- LOG 前缀纪律 <!--#oct-001-->\n" },
      ],
    })
    const svc = makeCurator(async (p) => {
      captured.push(p)
      return captured.length === 1 ? datedPlanFixture() : stubbornRewrite
    })
    const err = await svc.compileRaw(pointer).catch(e => e)

    // 终态 failed：原判闸行 + 自纠痕迹（任务记录 error.message 面可查）
    expect(String(err.message)).toContain("L5_DATES_IN_BODY")
    expect(String(err.message)).toContain("日期常青自纠一轮")
    expect(String(err.message)).toContain("con-llm-wiki")

    // 一轮上限：plan 1 拍 + 自纠 1 拍 = 恰 2 拍，**没有第三次**（不无限重试）
    expect(captured).toHaveLength(2)

    // 零半成品：失败语义与主链同律（无页落盘、无 commit、工作区净）
    for (const d of ["entities", "concepts", "topics", "sources", "cases"]) {
      expect(fs.readdirSync(path.join(wikiRoot, d)).filter(n => n.endsWith(".md")), d).toHaveLength(0)
    }
    expect(freshCommits()).toBe(0)
  })

  it("自纠响应不可解析 ⇒ 保持原判终止（不在自纠上再叠自纠）", async () => {
    const pointer = ingestGist()
    let n = 0
    const svc = makeCurator(async () => { n++; return n === 1 ? datedPlanFixture() : "抱歉，日期我改不了。" })
    const err = await svc.compileRaw(pointer).catch(e => e)
    expect(String(err.message)).toContain("日期常青自纠一轮")
    expect(String(err.message)).toContain("CURATOR_LLM_JSON")
    expect(n).toBe(2)
    expect(freshCommits()).toBe(0)
  })

  it("改写丢锚点即弃用：存活锚点不可删改的闸不因自纠而放松", async () => {
    const pointer = ingestGist()
    // 改写稿把 topic 页锚点删了（正文无日期了，但锚点丢失 ⇒ 自纠产物不合格）
    const anchorDroppingRewrite = JSON.stringify({
      pages: [
        { id: "con-llm-wiki", body: "## 定义\nKarpathy 提出的编译型知识库范式。\n" },
        { id: "top-log-format", body: "## 硬约束\n- LOG 前缀纪律（锚点被我弄丢了）\n" },
      ],
    })
    let n = 0
    const svc = makeCurator(async () => { n++; return n === 1 ? datedPlanFixture() : anchorDroppingRewrite })
    const err = await svc.compileRaw(pointer).catch(e => e)
    expect(String(err.message)).toContain("锚点")
    expect(String(err.message)).toContain("日期常青自纠一轮")
    expect(n).toBe(2)
    // 弃用改写 ⇒ 不落盘（con 页虽已常青也不单独提交：整批一 commit 语义不破）
    expect(fs.existsSync(path.join(wikiRoot, "concepts", "con-llm-wiki.md"))).toBe(false)
    expect(freshCommits()).toBe(0)
  })
})

/**
 * 「重试编译」入口的服务面契约（票07 AC3 + 红线2）：failed 任务可再触发，
 * 且**必经全局串行队列**（ingest-compile kind 复用，禁直写 wiki——路由面 S2 同钉）。
 * dedup 快路径陷阱（勘探坑 §9）：失败编译因写闸全量回滚 **不落 sources 回执页** ⇒
 * 同 rawPath 重投必然走真编译，不被幂等快路径吞成 no-op；成功后再投才是 no-op。
 */
describe("D-kc15-1 重试编译 — failed 任务再触发经 FIFO 队列（票07 S1）", () => {
  let db: Database.Database
  let tmpDir: string
  let root: string
  let wikiRoot: string
  let queue: CompileQueue

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-dates-retry-"))
    root = path.join(tmpDir, "knowledge")
    wikiRoot = path.join(root, "wiki")
    fs.mkdirSync(root, { recursive: true })
    queue = new CompileQueue()
  })

  afterEach(() => {
    db?.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const GOOD_PLAN = JSON.stringify({
    pages: [{ op: "create", type: "concept", id: "con-retry", title: "重试概念", summary: "s", body: "## 定义\n常青正文。\n" }],
    key_points: ["k"], contradictions: [],
  })

  /** LLM 剧本队列：第 n 拍返回 plans[n]（超界重复末项）。 */
  function scriptedLLM(plans: string[]): { llm: LLMCall; calls: () => number } {
    let n = 0
    return {
      llm: async () => { n++; return plans[Math.min(n, plans.length) - 1] },
      calls: () => n,
    }
  }

  async function waitTerminal(svc: CuratorTaskService, id: string, timeoutMs = 30_000) {
    const t0 = Date.now()
    for (;;) {
      const rec = svc.get(id)
      if (rec && (rec.status === "committed" || rec.status === "failed")) return rec
      if (Date.now() - t0 > timeoutMs) throw new Error(`task ${id} timeout in ${svc.get(id)?.status}`)
      await new Promise(r => setTimeout(r, 25))
    }
  }

  it("failed 任务重投 ⇒ 队列再执行、真编译提交（不被 dedup 吞成 no-op）", async () => {
    const raw = new RawIngestService({ root, now: FROZEN_NOW }).ingestText({ text: RAW_GIST_FORM, title: "Retry Source" })
    const pointer = raw.raw
    // 首任务：计划拍 + CURATOR_LLM_JSON 带错自纠拍都乱码 ⇒ 终态 failed（票05 既有自纠一轮上限）；
    // 重试任务第 3 拍给好计划。
    const script = scriptedLLM(["计划外的乱码一", "计划外的乱码二", GOOD_PLAN])
    const svc = new CuratorTaskService({
      root,
      queue,
      run: async (rawPath) => {
        const curator = new CuratorCompileService({ db, root, llm: script.llm, now: FROZEN_NOW, git: realGit(wikiRoot) })
        return curator.compileRaw(curator.resolveRawPointer(rawPath))
      },
    })

    const first = svc.submit(pointer.path)
    expect(first.status).toBe("queued")
    const failed = await waitTerminal(svc, first.id)
    expect(failed.status).toBe("failed")
    expect(failed.error?.code).toBe("CURATOR_LLM_JSON")

    // 失败编译的现场：sources 回执页不存在（全量回滚）⇒ dedup 快路径不可能命中
    expect(fs.existsSync(path.join(wikiRoot, "sources", "2026-10-13-retry-source.md"))).toBe(false)
    expect(queue.get(first.id)?.opKind).toBe("ingest-compile")
    expect(queue.get(first.id)?.state).toBe("failed")

    const retry = svc.submit(pointer.path)
    expect(retry.id).not.toBe(first.id)
    const done = await waitTerminal(svc, retry.id)

    // 重试 = 真编译：committed、非 deduped、有 commit hash、产物落盘
    expect(done.status).toBe("committed")
    expect(done.result?.deduped).toBe(false)
    expect(done.result?.changed).toBe(true)
    expect(done.result?.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(fs.existsSync(path.join(wikiRoot, "concepts", "con-retry.md"))).toBe(true)
    expect(script.calls()).toBe(3) // 乱码×2（计划+JSON 自纠拍）⇒ failed；重试拍真编译

    // 红线2：两次执行都以队列任务形态在案（同一 FIFO 串行史）
    const q1 = queue.get(first.id)!
    const q2 = queue.get(retry.id)!
    expect(q1.opKind).toBe("ingest-compile")
    expect(q2.opKind).toBe("ingest-compile")
    expect(q2.state).toBe("committed")
    expect(q1.queuedAt <= q2.queuedAt).toBe(true)
  })

  it("committed 后同 raw 再投 = dedup no-op（幂等快路径仍在，重试语义不伤它）", async () => {
    const raw = new RawIngestService({ root, now: FROZEN_NOW }).ingestText({ text: RAW_GIST_FORM, title: "Idem Source" })
    const script = scriptedLLM([GOOD_PLAN])
    const svc = new CuratorTaskService({
      root,
      queue,
      run: async (rawPath) => {
        const curator = new CuratorCompileService({ db, root, llm: script.llm, now: FROZEN_NOW, git: realGit(wikiRoot) })
        return curator.compileRaw(curator.resolveRawPointer(rawPath))
      },
    })
    const t1 = await waitTerminal(svc, svc.submit(raw.raw.path).id)
    expect(t1.status).toBe("committed")
    const t2 = await waitTerminal(svc, svc.submit(raw.raw.path).id)
    expect(t2.status).toBe("committed")
    expect(t2.result?.deduped).toBe(true)
    expect(t2.result?.commit).toBeNull()
    expect(script.calls()).toBe(1) // 快路径不调 LLM（票05 原契约保持）
  })
})
