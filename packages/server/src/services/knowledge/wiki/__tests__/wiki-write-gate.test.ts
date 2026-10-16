import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { spawnSync } from "child_process"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../../../../db/schema"
import { WikiCompileService } from "../compile"
import { CuratorCompileService } from "../curator"
import { RawIngestService } from "../../raw"
import { BackfillService } from "../../backfill"
import { FindingOpsService } from "../../findings"
import { WikiPatrolService } from "../../patrol"
import { CompileQueue } from "../compile-queue"
import type { GitRunner } from "../wiki-git"

/**
 * 质控⑥ 人工文件写保护 — 行为测试套件（code-review P5/P6 重建证据链）。
 *
 * 背景：票06 的「写入单一闸门 = git 层强制」行为测试（wiki-curate.test.ts）被票09
 * 整删无补，且 pre-commit 对 SCHEMA.md 的分支缺失、服务层根本没有路径级拒写闸
 * ——本套件把三层各钉一遍：
 *   ①服务层硬闸（主闸）：唯一写闸（compile/curate/backfill/裁决修订）对
 *     人工文件（SCHEMA.md）**路径级拒绝**（含经 wiki 仓相对路径 `../`
 *     的旁路形态——resolve 归一后对拍，先于文件名正则/逃逸检查触发），
 *     抛结构化错 MANUAL_FILE_WRITE，零副作用；
 *   ②pre-commit（纵深）：旁路裸提交被拒；curate 标记触人工文件被拒；
 *     manual 标记（人工维护通道）放行——票06 原断言恢复；
 *   ③通道负断言：curator 编译 / finding 裁决修订 / 回填全链**不触人工文件**
 *     （字节不变 + commit 触及面不含 + 不在 wiki 根凭空造出）。
 *
 * 真 fs（tmpdir 知识根）+ in-memory DB + 真 git；LLM seam fixture-mocked
 * （spec Testing Decisions：只断言外部行为——盘/commit/LOG/git log/任务态）。
 */

const realGit = (cwd: string): GitRunner => ({
  run(args: string[]) {
    const r = spawnSync("git", args, { cwd, timeout: 30000, env: { ...process.env, OCTOPUS_WIKI_COMMIT_SOURCE: "curate" } })
    return { status: r.status ?? 1, stdout: r.stdout?.toString() ?? "", stderr: r.stderr?.toString() ?? "" }
  },
})

/** 旁路通道模拟：终端裸跑 git（可控来源标记 env；undefined = 摘除标记）。 */
function rawGit(cwd: string, args: string[], source?: string) {
  const e = { ...process.env }
  if (source === undefined) delete e.OCTOPUS_WIKI_COMMIT_SOURCE
  else e.OCTOPUS_WIKI_COMMIT_SOURCE = source
  const r = spawnSync("git", args, { cwd, timeout: 30000, encoding: "utf-8", env: e })
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

const FROZEN_NOW = () => new Date("2026-10-13T08:00:00.000Z")

const SCHEMA_TEXT = "# SCHEMA.md（人工共演约定）\n- 首版纪律占位\n"

/** v2 词条 fixture（compileEntry 通道，gate 顺序断言用）。 */
const V2_ENTRY = `---
id: prj-gate-fixture
domain: projects
title: 写保护闸 fixture
summary: 供 compileEntry 通道触闸
topics: [gate]
stability: stable
last_compiled: 2026-10-13
sources: [doc:review]
confidence: 0.6
---

## 规则
- 旁路提交必须被拒 <!--#oct-NEW-->
`

/** v3 页 fixture（batch 通道触闸用）。 */
const V3_PAGE = `---
id: con-gate-page
type: concept
title: 写保护页 fixture
summary: 供 compilePages 通道正常过闸对照
topics: [gate]
aliases: []
links: []
last_compiled: 2026-10-13
sources: []
---

## 定义

正常页体，过闸对照用。
`

function writePage(rel: string, id: string, type: string, topics: string[], links: string[], body: string): void {
  const abs = path.join(wikiRoot, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  const linksBlock = links.length > 0 ? `links: [${links.map(l => `[[${l}]]`).join(", ")}]\n` : "links: []\n"
  fs.writeFileSync(abs, [
    "---", `id: ${id}`, `type: ${type}`, `title: ${id} 页`, `summary: ${id} 摘要`,
    `topics: [${topics.join(", ")}]`, "aliases: []", linksBlock + "",
    "last_compiled: 2026-10-12", "sources: []", "---", "", body,
  ].join("\n"), "utf-8")
}

/** 策展计划 fixture（单页最小可编译）。 */
function planFixture(): string {
  return JSON.stringify({
    pages: [{
      op: "create", type: "concept", id: "con-curated", title: "被策展的概念",
      summary: "写保护负断言的编译产物", topics: ["gate"], links: [],
      body: "## 定义\n\n经 curator 通道编译进库的概念页。\n",
    }],
    key_points: ["curator 通道只写五类页目录，人工文件零触碰"],
    contradictions: [],
  })
}

let db: Database.Database
let tmpDir: string
let root: string
let wikiRoot: string

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-write-gate-"))
  root = path.join(tmpDir, "knowledge")
  wikiRoot = path.join(root, "wiki")
  fs.mkdirSync(wikiRoot, { recursive: true })
})

afterEach(() => {
  db?.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** 盘上人工文件的字节真相（负断言基准）。 */
function seedManualFiles(): { schema: string } {
  const schema = path.join(root, "SCHEMA.md")
  fs.writeFileSync(schema, SCHEMA_TEXT, "utf-8")
  return { schema }
}

function assertUntouched(pairs: Array<{ file: string; before: string }>, label: string): void {
  for (const { file, before } of pairs) {
    expect(fs.existsSync(file), `${label}: ${path.basename(file)} 不得被凭空造出/删除`).toBe(true)
    expect(fs.readFileSync(file, "utf-8"), `${label}: ${path.basename(file)} 字节不变`).toBe(before)
  }
}

// ===========================================================================
// ①服务层硬闸（主闸）——唯一写闸路径级拒写人工文件，结构化错、零副作用
// ===========================================================================
describe("服务层写保护硬闸（质控⑥主闸 — MANUAL_FILE_WRITE）", () => {
  it("compilePages：fileName 以 '../SCHEMA.md' 旁路形态归一命中知识根人工文件位 ⇒ 拒写、零副作用", async () => {
    const svc = new WikiCompileService({ db, org: "global", rootDir: wikiRoot, git: realGit(wikiRoot) })
    await expect(
      svc.compilePages([{ content: V3_PAGE, fileName: "../SCHEMA.md" }], { entry: "旁路形态", note: "gate" }),
    ).rejects.toThrow(/MANUAL_FILE_WRITE/)
    // 零副作用：文件不落、仓不建 commit（首编译失败不留半成品）
    expect(fs.existsSync(path.join(wikiRoot, "SCHEMA.md"))).toBe(false)
    expect(fs.existsSync(path.join(wikiRoot, ".git")) ? rawGit(wikiRoot, ["rev-list", "--count", "HEAD"]).stdout.trim() : "0").toBe("0")
  })

  it("compilePages：fileName 'topics/../../SCHEMA.md' 相对旁路归一命中 wiki 根 ⇒ 同一结构化错（大小写不敏感对拍）", async () => {
    const svc = new WikiCompileService({ db, org: "global", rootDir: wikiRoot, git: realGit(wikiRoot) })
    await expect(
      svc.compilePages([{ content: V3_PAGE, fileName: "topics/../../SCHEMA.md" }], { entry: "旁路形态", note: "gate" }),
    ).rejects.toThrow(/MANUAL_FILE_WRITE/)
    expect(fs.existsSync(path.join(wikiRoot, "SCHEMA.md"))).toBe(false)
  })

  it("compileEntry（v2 通道）：fileName '../SCHEMA.md' ⇒ 闸先于文件名正则触发（错码是 MANUAL_FILE_WRITE 非 INVALID_PARAM）", async () => {
    const svc = new WikiCompileService({ db, org: "global", rootDir: wikiRoot, git: realGit(wikiRoot) })
    const err = await svc.compileEntry({ content: V2_ENTRY, fileName: "../SCHEMA.md" }).catch(e => e as Error)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/MANUAL_FILE_WRITE/)
    expect((err as Error & { code?: string }).code).toBe("MANUAL_FILE_WRITE")
    expect((err as unknown as { status?: number }).status).toBe(403)
    expect(fs.existsSync(path.join(wikiRoot, "SCHEMA.md"))).toBe(false)
  })

  it("对照组：合法页照常过闸编译（闸不是把 batch 通道整体打死的坏闸）", async () => {
    const svc = new WikiCompileService({ db, org: "global", rootDir: wikiRoot, git: realGit(wikiRoot) })
    const res = await svc.compilePages([{ content: V3_PAGE }], { entry: "合法页", note: "对照" })
    expect(res.changed).toBe(true)
    expect(res.pages[0]!.path).toBe("concepts/con-gate-page.md")
  })
})

// ===========================================================================
// ②pre-commit（纵深）——票06「git 层强制」断言恢复 + SCHEMA 面补齐
// ===========================================================================
describe("wiki 仓 pre-commit 写权闸（纵深防御）", () => {
  async function seedRepo(): Promise<WikiCompileService> {
    const svc = new WikiCompileService({ db, org: "global", rootDir: wikiRoot, git: realGit(wikiRoot) })
    await svc.compilePages([{ content: V3_PAGE }], { entry: "建仓", note: "pre-commit 基线" })
    return svc
  }

  it("无标记旁路提交被拒（curate 标记 vs 裸提交——写入单一闸门的 git 层强制）", async () => {
    await seedRepo()
    expect(fs.existsSync(path.join(wikiRoot, ".git", "hooks", "pre-commit"))).toBe(true)

    const target = path.join(wikiRoot, "concepts", "con-gate-page.md")
    fs.appendFileSync(target, "\n## 旁路\n手写一段（非策展通道）。\n", "utf-8")
    rawGit(wikiRoot, ["add", "-A"])
    const denied = rawGit(wikiRoot, ["commit", "-m", "bypass: direct edit"])
    expect(denied.status).not.toBe(0)
    expect(denied.stderr).toContain("OCTOPUS_WIKI_COMMIT_SOURCE")
    // 批通道 commit subject = `compile: {entry} — {note}`（建仓那一笔仍在 HEAD）
    expect(rawGit(wikiRoot, ["log", "-1", "--pretty=%s"]).stdout).toContain("compile: 建仓")

    // curate 标记提交放行（服务通道同律）
    const allowed = rawGit(wikiRoot, ["commit", "-m", "curate: sanctioned", "concepts/con-gate-page.md"], "curate")
    expect(allowed.status).toBe(0)
  })

  it("curate 标记触及 wiki 根 SCHEMA.md 一律拒；manual 标记（人工维护）放行", async () => {
    await seedRepo()

    fs.writeFileSync(path.join(wikiRoot, "SCHEMA.md"), SCHEMA_TEXT, "utf-8")
    rawGit(wikiRoot, ["add", "-A"])

    const autoRejected = rawGit(wikiRoot, ["commit", "-m", "auto: touch manual files"], "curate")
    expect(autoRejected.status).not.toBe(0)
    expect(autoRejected.stderr).toContain("SCHEMA")

    const manualOk = rawGit(wikiRoot, ["commit", "-m", "manual: human maintenance"], "manual")
    expect(manualOk.status).toBe(0)
    expect(rawGit(wikiRoot, ["log", "-1", "--pretty=%s"]).stdout).toContain("manual: human maintenance")
  })
})

// ===========================================================================
// ③通道负断言——curator 编译 / 裁决修订 / 回填不触人工文件
// ===========================================================================
describe("通道不触人工文件（curate/backfill/finding-fix 负断言）", () => {
  function ingestFixture(): ReturnType<RawIngestService["ingestText"]>["raw"] {
    const raw = new RawIngestService({ root, now: FROZEN_NOW })
    const res = raw.ingestText({ text: "# Gate fixture source\n\nA concept for the write-gate negative assertion.\n", title: "Gate Fixture Source" })
    return res.raw
  }

  it("curator compileRaw：人工文件字节不变，commit 触及面不含人工文件、wiki 根不凭空造出副本", async () => {
    const manual = seedManualFiles()
    const before = [
      { file: manual.schema, before: SCHEMA_TEXT },
    ]
    const pointer = ingestFixture()
    const svc = new CuratorCompileService({ db, root, llm: async () => planFixture(), now: FROZEN_NOW, git: realGit(wikiRoot) })

    const res = await svc.compileRaw(pointer)
    expect(res.changed).toBe(true)

    assertUntouched(before, "curator 编译后")

    expect(fs.existsSync(path.join(wikiRoot, "SCHEMA.md"))).toBe(false)
    const nameOnly = rawGit(wikiRoot, ["show", "--name-only", "--pretty=", "HEAD"]).stdout
    expect(nameOnly).not.toMatch(/SCHEMA\.md/m)
  })

  it("SCHEMA.md 幂等 seed 通道照旧（ensureSchemaDoc 首建允许——主闸只拒编译通道改内容）", async () => {
    const pointer = ingestFixture()
    const svc = new CuratorCompileService({ db, root, llm: async () => planFixture(), now: FROZEN_NOW, git: realGit(wikiRoot) })
    await svc.compileRaw(pointer)
    const schema = path.join(root, "SCHEMA.md")
    expect(fs.existsSync(schema)).toBe(true)
    const first = fs.readFileSync(schema, "utf-8")
    await svc.compileRaw(ingestFixtureText2(pointer))
    expect(fs.readFileSync(schema, "utf-8")).toBe(first) // 二编不重开 seed、不改内容
  })

  it("finding-fix 裁决修订：adopt(missing-xref) 编译后人工文件字节不变、commit 面干净", async () => {
    const manual = seedManualFiles()
    const before = [
      { file: manual.schema, before: SCHEMA_TEXT },
    ]
    writePage("concepts/con-a.md", "con-a", "concept", ["knowledge"], [], "## 定义\n\n甲。")
    writePage("concepts/con-b.md", "con-b", "concept", ["knowledge"], [], "## 定义\n\n乙。")
    // 建仓基线（patrol 只读盘，编译通道在 adopt 里）——先经 finding-fix 出首 commit
    const report = (await new WikiPatrolService({ db, root }).patrol())
    const xref = report.findings.find(f => f.kind === "missing-xref")
    expect(xref).toBeDefined()

    const queue = new CompileQueue()
    const ops = new FindingOpsService({ db, root, queue, now: FROZEN_NOW, git: realGit(wikiRoot) })
    const task = ops.adopt(xref!.id)
    await waitFor(() => queue.depth() === 0)
    expect(ops.getTask(task.id)!.status).toBe("committed")

    assertUntouched(before, "finding 裁决后")

    const nameOnly = rawGit(wikiRoot, ["show", "--name-only", "--pretty=", "HEAD"]).stdout
    expect(nameOnly).not.toMatch(/SCHEMA\.md/)
  })

  it("backfill：摘录只落 raw/inbox（零 wiki 触盘），人工文件字节不变；其触发的编译同律", async () => {
    const manual = seedManualFiles()
    const before = [
      { file: manual.schema, before: SCHEMA_TEXT },
    ]
    const submitted: string[] = []
    const bff = new BackfillService({ root, now: FROZEN_NOW, trigger: p => { submitted.push(p); return { taskId: "crt-seam", status: "queued" } } })
    const res = bff.backfill({ text: "探索结论：写保护三层各钉一遍。", title: "三层钉闸纪要", sessionId: "gate-session" })

    expect(res.raw.path.startsWith("raw/inbox/")).toBe(true)
    expect(submitted).toEqual([res.raw.path])
    assertUntouched(before, "回填落 raw 后")
    expect(fs.existsSync(path.join(wikiRoot, ".git"))).toBe(false) // 回填本体零编译零建仓——编译是队内的事

    // 队列语义下的编译段（同 curator 通道）：人工文件依旧零触碰
    const svc = new CuratorCompileService({ db, root, llm: async () => planFixture(), now: FROZEN_NOW, git: realGit(wikiRoot) })
    await svc.compileRaw(bff.backfill({ text: "第二次回填摘录。", title: "回填二" }).raw)
    assertUntouched(before, "回填触发编译后")
  })
})

/** 二次 ingest（不同内容不同 raw，专测 SCHEMA seed 不重不改）。 */
function ingestFixtureText2(_prev: ReturnType<RawIngestService["ingestText"]>["raw"]) {
  const raw = new RawIngestService({ root, now: () => new Date("2026-10-14T08:00:00.000Z") })
  return raw.ingestText({ text: "# Gate fixture source two\n\nAnother frozen source for the second compile pass.\n", title: "Gate Fixture Source Two" }).raw
}

async function waitFor(predicate: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("waitFor 超时")
    await new Promise(r => setTimeout(r, 20))
  }
}
