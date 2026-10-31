import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { applySchema } from "../../../db/schema"
import { KnowledgeEffectivenessDAO } from "../../../db/dao/knowledge-effectiveness-dao"
import { WikiArticleDAO } from "../../../db/dao/wiki-article-dao"
import { GLOBAL_WIKI_ORG } from "../global-paths"
import { WikiCompileService } from "../wiki/compile"
import { CompileQueue } from "../wiki/compile-queue"
import type { GitRunner } from "../wiki/wiki-git"
import { EffectivenessSyncService } from "../effectiveness-sync"

/**
 * 票07 · S1 夜巡批量刷 confidence 快照（真 fs + 真 git + in-memory DB 全栈，
 * 全 tmpdir 缝零真盘）。Expected 独立真相源 = 手算账目（fixture 键入已知计数，
 * 期望值从票面公式独立推得）；红线6 无时间判据、时钟冻结注入。
 * 三件事逐件钉：①批量刷+单 commit 收口+LOG sync 行；②样本不足不抖动（初值页字节不变）；
 * ③幂等零空提交（重跑 changed=false、git 计数不变、LOG 不追加、不入队）。
 */

const FROZEN = () => new Date("2026-10-15T03:17:00.000Z")
const realGit = (cwd: string): GitRunner => ({
  run(args: string[]) {
    const r = spawnSync("git", args, { cwd, timeout: 30000, env: { ...process.env, OCTOPUS_WIKI_COMMIT_SOURCE: "curate" } })
    return { status: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
  },
})

const commitCount = (git: GitRunner) => parseInt(git.run(["rev-list", "--count", "HEAD"]).stdout.trim(), 10)

let db: Database.Database
let tmpDir: string
let root: string
let wikiRoot: string
let git: GitRunner
let ledger: KnowledgeEffectivenessDAO

const TOP_A = `---
id: top-a
type: topic
title: 主题A
summary: 甲的纪律
topics: [a]
aliases: []
links: []
last_compiled: 2026-10-12
sources: []
---

## 硬约束

- 先红后绿 <!--#oct-001-->
- 禁跳闸 <!--#oct-002-->
`

const CON_B = `---
id: con-b
type: concept
title: 概念B
summary: 乙的辨析
topics: [b]
aliases: []
links: []
last_compiled: 2026-10-12
sources: []
confidence: 0.9
---

## 定义

乙是一种辨析。
`

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eff-sync-"))
  root = path.join(tmpDir, "knowledge")
  wikiRoot = path.join(root, "wiki")
  fs.mkdirSync(wikiRoot, { recursive: true })
  git = realGit(wikiRoot)
  ledger = new KnowledgeEffectivenessDAO(db)
  // 种子：两页经唯一写闸编译落库（commit 1）
  const compiler = new WikiCompileService({ db, org: GLOBAL_WIKI_ORG, rootDir: wikiRoot, git })
  compiler.compilePages(
    [
      { content: TOP_A, fileName: "top-a.md" },
      { content: CON_B, fileName: "con-b.md" },
    ],
    { action: "compile", entry: "seed", note: "票07 S1 种子", source: "test", reviewer: "owner" },
  )
})

afterEach(() => {
  db?.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function makeSync(queue?: CompileQueue) {
  return new EffectivenessSyncService({ db, root, git, now: FROZEN, ...(queue ? { queue } : {}) })
}

describe("夜巡批量刷 confidence 快照（票07 AC2）", () => {
  it("账目 fixture→confidence：页键行∪锚点行聚合，measured 页写 front-matter；单 commit 收口 + LOG sync 行；DB 列滚动同步", async () => {
    // 手算：top-a 页键行 (cited3,h0,n0) ∪ oct-001 (5,0,4) ∪ oct-002 (2,3,1)
    //   ⇒ cited 10 · samples h3+n5=8 ≥3 → confidence 3/8 = 0.375（初值缺席，新增写行）
    // con-b 行 (4,1,1) ⇒ samples 2 <3 → 不抖动，front-matter 逐字节保持 0.9
    ledger.upsert("oct-001", { cited_count: 5, helpful_count: 0, not_helpful_count: 4 })
    ledger.upsert("oct-002", { cited_count: 2, helpful_count: 3, not_helpful_count: 1 })
    ledger.upsert("top-a", { cited_count: 3, helpful_count: 0, not_helpful_count: 0 })
    ledger.upsert("con-b", { cited_count: 4, helpful_count: 1, not_helpful_count: 1 })
    const conBBefore = fs.readFileSync(path.join(wikiRoot, "concepts", "con-b.md"), "utf-8")

    const res = await makeSync().sync()

    expect(res.updated.map(u => u.relPath)).toEqual(["topics/top-a.md"])
    expect(res.updated[0].to).toBe(0.375)
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(res.changed).toBe(true)

    // 盘面前后态：top-a 新增 confidence 行；con-b 逐字节未动（不抖动的最强断言）
    expect(fs.readFileSync(path.join(wikiRoot, "topics", "top-a.md"), "utf-8")).toContain("confidence: 0.375")
    expect(fs.readFileSync(path.join(wikiRoot, "concepts", "con-b.md"), "utf-8")).toBe(conBBefore)

    // 一批一收口：git 史恰增 1（seed + sync）
    expect(commitCount(git)).toBe(2)

    // LOG 行族（notes/01 §2.4 制式；op=sync 读侧 parseLogLines 天然可解析）
    const log = fs.readFileSync(path.join(wikiRoot, "LOG.md"), "utf-8")
    expect(log).toMatch(/^## \[2026-10-15\] sync \| .*confidence/m)

    // DB 面：wiki_articles 快照列跟新（compilePages 同事务）；effectiveness 行级列滚动
    expect(new WikiArticleDAO(db).get("top-a")!.confidence).toBe(0.375)
    expect(ledger.getByRuleId("oct-001")!.confidence).toBe(0)
    expect(ledger.getByRuleId("oct-002")!.confidence).toBe(0.75)
    // 样本不足行（con-b samples 2）保持行初值 0.5 不动
    expect(ledger.getByRuleId("con-b")!.confidence).toBe(0.5)
  })

  it("批量两页一次收口=单 commit（一批多页零拆波）", async () => {
    ledger.upsert("oct-001", { cited_count: 5, helpful_count: 1, not_helpful_count: 3 })
    ledger.upsert("oct-002", { cited_count: 1, helpful_count: 2, not_helpful_count: 0 })
    ledger.upsert("con-b", { cited_count: 6, helpful_count: 0, not_helpful_count: 6 })
    // top-a 聚合（页键行缺席）：h 1+2=3 · n 3+0=3 → samples 6 → 3/6=0.5；con-b：0/6 → 0.0 覆盖 0.9
    const res = await makeSync().sync()
    expect(res.updated.map(u => u.relPath).sort()).toEqual(["concepts/con-b.md", "topics/top-a.md"])
    expect(res.updated.find(u => u.relPath === "concepts/con-b.md")!.from).toBe(0.9)
    expect(commitCount(git)).toBe(2) // 两页一批 = seed commit + 1 个 sync commit
    const log = fs.readFileSync(path.join(wikiRoot, "LOG.md"), "utf-8")
    expect((log.match(/^## \[.*\] sync \|/gm) ?? [])).toHaveLength(1)
  })

  it("幂等零空提交：重跑 changed=false·commit=null·不入队·git 史与 LOG 恒旧（AC2 幂等）", async () => {
    ledger.upsert("oct-001", { cited_count: 5, helpful_count: 1, not_helpful_count: 3 })
    ledger.upsert("oct-002", { cited_count: 1, helpful_count: 2, not_helpful_count: 0 })
    await makeSync().sync()
    const commits1 = commitCount(git)
    const log1 = fs.readFileSync(path.join(wikiRoot, "LOG.md"), "utf-8")

    const q = new CompileQueue({ now: FROZEN })
    const res2 = await makeSync(q).sync()
    expect(res2.changed).toBe(false)
    expect(res2.commit).toBeNull()
    expect(res2.updated).toEqual([])
    expect(q.list()).toHaveLength(0) // 无变化不入队（红线1 队列零旁路，也零空转）
    expect(commitCount(git)).toBe(commits1)
    expect(fs.readFileSync(path.join(wikiRoot, "LOG.md"), "utf-8")).toBe(log1)
  })

  it("队列模式经全局串行通道：enqueue opKind=effectiveness-sync、任务达 committed、回执带 queueTaskId", async () => {
    ledger.upsert("oct-001", { cited_count: 5, helpful_count: 0, not_helpful_count: 5 })
    const q = new CompileQueue({ now: FROZEN })
    const res = await makeSync(q).sync()
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/)
    const tasks = q.list()
    expect(tasks).toHaveLength(1)
    expect(tasks[0].opKind).toBe("effectiveness-sync")
    expect(tasks[0].state).toBe("committed")
    expect(res.queueTaskId).toBe(tasks[0].id)
    expect(tasks[0].id).toMatch(/^es-/)
  })

  it("hub 嵌套子页出列（批通道单级约束）：跳过留 warning，盘文件不动", async () => {
    fs.mkdirSync(path.join(wikiRoot, "entities", "hub"), { recursive: true })
    fs.writeFileSync(
      path.join(wikiRoot, "entities", "hub", "ent-hub-child.md"),
      `---\nid: ent-hub-child\ntype: entity\ntitle: 子页\nsummary: hub 下嵌套实体页\naliases: []\ntopics: []\nlinks: []\nlast_compiled: 2026-10-12\nsources: []\n---\n\n## 概述\n\n嵌套测试。\n`,
      "utf-8",
    )
    ledger.upsert("ent-hub-child", { cited_count: 4, helpful_count: 0, not_helpful_count: 4 })
    const before = fs.readFileSync(path.join(wikiRoot, "entities", "hub", "ent-hub-child.md"), "utf-8")
    const res = await makeSync().sync()
    expect(res.updated).toEqual([])
    expect(res.warnings.join(" ")).toContain("entities/hub/ent-hub-child.md")
    expect(fs.readFileSync(path.join(wikiRoot, "entities", "hub", "ent-hub-child.md"), "utf-8")).toBe(before)
  })

  it("判例形态零触碰：无 confidence 语义的 kind 不进同步面", async () => {
    fs.mkdirSync(path.join(wikiRoot, "cases"), { recursive: true })
    fs.writeFileSync(
      path.join(wikiRoot, "cases", "2026-10-12-case-x.md"),
      `---\nid: case-x\ndomain: cases\nsymptom: 崩\ntags: []\nseverity: blocker\noccurrences: 1\nsource: exec-2026-10-12\nstatus: open\n---\n\n## 现场\n\n崩了。\n`,
      "utf-8",
    )
    ledger.upsert("case-x", { cited_count: 9, helpful_count: 0, not_helpful_count: 9 })
    const before = fs.readFileSync(path.join(wikiRoot, "cases", "2026-10-12-case-x.md"), "utf-8")
    const res = await makeSync().sync()
    expect(res.updated).toEqual([])
    expect(fs.readFileSync(path.join(wikiRoot, "cases", "2026-10-12-case-x.md"), "utf-8")).toBe(before)
  })
})
