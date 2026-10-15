/**
 * 票09 item-1/2/3/5/6 S1 — 衰减自动退役窄口真跑（真 git + tmpdir 知识根 + in-memory DB，
 * 零触真盘）。spec 故事 16-18：锚点 90 天零引用 **且** 零活页入链 **且** 非人工文件 →
 * 经全局队列 opKind="auto-retire" 调票04 统一退役机械（source=auto）+ 通知卡数据。
 *
 * 判据口径（红线6）：时钟注入钉 2026-10-14；90 天账用 DAO.incrementCited 的调用方
 * 时刻构造（票06 制式），禁 sleep。「零引用」= 两账皆无近期命中（锚点键行 + 页级
 * Read 键行；notes/02 §3 列义 + 票06 解析器键制式：锚=oct-NNN、页=文件名 stem）。
 *
 * Expected 真相源 = 票面判据与 spec L90（AND 三条），不重算实现内部；
 * 负断言（红线2）：低置信/域失衡/volatile 到期/无锚页一律不入自动路——只有窄口命中
 * 才产生 retire 入队，其余类目零自动执行路径。
 */
import { describe, it, expect, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { applySchema } from "../../../../db/schema"
import { KnowledgeEffectivenessDAO } from "../../../../db/dao/knowledge-effectiveness-dao"
import { ensureWikiSkeleton } from "../paths"
import { CompileQueue } from "../compile-queue"
import { PageRetireTaskService } from "../page-retire"
import {
  AutoRetireService,
  narrowGateMissReason,
  type NarrowGateEvidence,
  type NarrowGatePage,
  type AutoRetireNotice,
} from "../auto-retire"
import type { GitRunner } from "../wiki-git"

/** 冻结夜巡时刻：2026-10-14（cutoff=2026-07-16T12:00Z；90 天窗判据全部对照此钉表） */
const FROZEN = () => new Date("2026-10-14T12:00:00.000Z")

const realGit = (cwd: string): GitRunner => ({
  run(args: string[]) {
    const r = spawnSync("git", args, { cwd, timeout: 30000, env: { ...process.env, OCTOPUS_WIKI_COMMIT_SOURCE: "curate" } })
    return { status: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
  },
})

/** 僵尸规则页：含锚点 oct-001、last_compiled 距冻结时刻 105 天（满 90 天观察窗）。 */
const TOPIC_ZOMBIE = `---
id: top-zombie
type: topic
title: 僵尸纪律页
summary: 票09 窄口 S1 fixture：携带规则锚点的在册 topic 页
topics: [probe]
links: []
last_compiled: 2026-07-01
sources: [doc:ar09]
---

## 硬约束
- 僵尸纪律一条 <!--#oct-001-->
`

/** 活规则页：锚点 oct-002 于 30 天前被引用（窗内有名——绝不自动碰）。 */
const TOPIC_ALIVE = `---
id: top-alive
type: topic
title: 活跃纪律页
summary: 票09 负断言 fixture：近 90 天内有引用命中的 topic 页
topics: [probe]
links: []
last_compiled: 2026-07-01
sources: [doc:ar09]
---

## 硬约束
- 活跃纪律一条 <!--#oct-002-->
`

/** 无锚概念页：不在窄口射程（判据主语是规则锚点；无锚=finding 人裁域）。 */
const CONCEPT_NOANCHOR = `---
id: con-noanchor
type: concept
title: 无锚概念页
summary: 票09 负断言 fixture：零锚点零入链的在册概念页（窄口不收，等 ticket08 finding）
topics: [probe]
links: []
last_compiled: 2026-07-01
sources: [doc:ar09]
---

## 定义
无锚概念的散文正文，不携带规则锚点。
`

function readLog(root: string): string {
  const p = path.join(root, "LOG.md")
  return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : ""
}

interface Harness {
  db: Database.Database
  wikiRoot: string
  git: GitRunner
  queue: CompileQueue
  retire: PageRetireTaskService
  notices: AutoRetireNotice[][]
  makeGate: () => AutoRetireService
  commitCount: () => number
  tmpDir: string
}

function makeHarness(pages: Record<string, string>): Harness & { tmpDir: string } {
  const db = new Database(":memory:")
  applySchema(db)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "we09-auto-"))
  const knowledgeRoot = path.join(tmpDir, "knowledge")
  const wikiRoot = path.join(knowledgeRoot, "wiki")
  ensureWikiSkeleton(wikiRoot)
  for (const [rel, content] of Object.entries(pages)) {
    const abs = path.join(wikiRoot, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, "utf-8")
  }
  const git = realGit(wikiRoot)
  git.run(["init"])
  git.run(["config", "user.email", "we09@test.local"])
  git.run(["config", "user.name", "we09-test"])
  git.run(["config", "core.autocrlf", "false"])
  git.run(["add", "-A"])
  const seed = git.run(["commit", "-m", "seed: 窄口 S1 在册页"])
  if (seed.status !== 0) throw new Error(`seed commit failed: ${seed.stderr}`)

  const queue = new CompileQueue()
  const retire = new PageRetireTaskService({ db, root: knowledgeRoot, git, now: FROZEN, queue })
  const notices: AutoRetireNotice[][] = []
  const gate = () =>
    new AutoRetireService({
      db,
      root: knowledgeRoot,
      now: FROZEN,
      retireTasks: retire,
      notify: n => notices.push(n),
    })
  const commitCount = () => parseInt(git.run(["rev-list", "--count", "HEAD"]).stdout.trim(), 10)
  return { db, wikiRoot, git, queue, retire, notices, makeGate: gate, commitCount, tmpDir }
}

/** 默认三页阵：僵尸（命中样本）+ 活跃（窗内有名）+ 无锚概念（域外）。 */
const DEFAULT_PAGES = {
  "topics/top-zombie.md": TOPIC_ZOMBIE,
  "topics/top-alive.md": TOPIC_ALIVE,
  "concepts/con-noanchor.md": CONCEPT_NOANCHOR,
}

function harness(pages: Record<string, string> = DEFAULT_PAGES) {
  const h = makeHarness(pages)
  currentDb = h.db
  currentTmp = h.tmpDir
  return h
}

/** 被链僵尸页：两账沉默但活页入链在——判据②负断言载体（红线2：有链=人裁域）。 */
const TOPIC_INBOUNDED = `---
id: top-inbounded
type: topic
title: 被链僵尸页
summary: 判据②负断言：活页入链存在，即便两账沉默也不自动退
topics: [probe]
links: []
last_compiled: 2026-07-01
sources: [doc:ar09]
---

## 硬约束
- 被链纪律一条 <!--#oct-010-->
`

/** 宿主实体页：front-matter links + 正文 [[..]] 双指向 top-inbounded。 */
const ENT_HOST = `---
id: ent-host
type: entity
entity_kind: tool
title: 宿主实体页
summary: 判据②证据载体：双通道指向被链僵尸页
aliases: []
topics: [probe]
links: [top-inbounded]
stability: stable
last_compiled: 2026-07-01
sources: [doc:ar09]
confidence: 0.8
---

## 用法
引用 [[top-inbounded]] 的纪律。
`

/** 昨日新页：last_compiled 在窗内——「90 天零引用」观察窗未走完，不成立。 */
const TOPIC_YOUNG = `---
id: top-young
type: topic
title: 新生纪律页
summary: 判据①窗完整负断言：在册不足 90 天，零引用无从谈起
topics: [probe]
links: []
last_compiled: 2026-10-10
sources: [doc:ar09]
---

## 硬约束
- 新生纪律一条 <!--#oct-011-->
`

/** 页级 Read 账有名：锚点键无行，但页键（stem）近引——「两账皆无」不成立。 */
const TOPIC_READ = `---
id: top-read
type: topic
title: 被翻阅的纪律页
summary: 判据①两账面负断言：页级 Read 账窗内有名
topics: [probe]
links: []
last_compiled: 2026-07-01
sources: [doc:ar09]
---

## 硬约束
- 常翻纪律一条 <!--#oct-012-->
`

/** 低置信但窗内有名：confidence 不在窄口射程——低置信=finding 人裁域。 */
const TOPIC_LOWCONF = `---
id: top-lowconf
type: topic
title: 低置信活跃页
summary: 红线2 负断言：低置信不自动退（窗内有名拦住即证判据不吃 confidence）
topics: [probe]
links: []
last_compiled: 2026-07-01
sources: [doc:ar09]
confidence: 0.05
---

## 硬约束
- 低置信纪律一条 <!--#oct-013-->
`

/** hub 子页（两层深）：不在 RETIRABLE 面（票04 白名单同律）。 */
const TOPIC_HUB_CHILD = `---
id: deep
type: topic
title: hub 子页
summary: not-retirable 面负断言：两层深路径不可页退役
topics: [probe]
links: []
last_compiled: 2026-07-01
sources: [doc:ar09]
---

## 硬约束
- 子页纪律一条 <!--#oct-014-->
`

/** volatile 到期页（review_after 已越）：到期=finding 三选人裁（票08 D7），窄口判据零读 stability/review_after。 */
const CONCEPT_VOLATILE = `---
id: con-volatile
type: concept
title: 到期 volatile 概念页
summary: volatile 到期负断言：复审指针越期不触发自动退役（域外类目）
topics: [probe]
links: []
stability: volatile
review_after: 2026-09-01
last_compiled: 2026-07-01
sources: [doc:ar09]
---

定义散文，无规则锚点。
`

// 每例清理句柄（vitest afterEach 消费；harness() 随例重置）
let currentDb: Database.Database | null = null
let currentTmp: string | null = null

describe("AutoRetireService — 衰减自动退役窄口（票09 · spec 故事16/18）", () => {
  afterEach(() => {
    currentDb?.close()
    if (currentTmp) fs.rmSync(currentTmp, { recursive: true, force: true })
  })

  it("窄口命中：90 天零引用且零活页入链的规则页自动退役——auto-retire kind 入队、source=auto LOG 行、_retired/ 落地、通知卡数据齐（锚点/页/判据/恢复口令）", async () => {
    const h = harness()
    // 账目真相源=构造 fixture：oct-001 上次被引 2026-07-10（距冻结 96 天 > 90 天窗）；
    // oct-002 三十天前有名（top-alive 必须被「窗内有名」拦住，否则它也成候选）
    const ledger = new KnowledgeEffectivenessDAO(h.db)
    ledger.incrementCited("oct-001", "2026-07-10T00:00:00.000Z")
    ledger.incrementCited("oct-002", "2026-09-20T00:00:00.000Z")

    const before = h.commitCount()
    const report = await h.makeGate().run()

    // 命中一条，且仅此一条（top-alive 有名、con-noanchor 无锚=域外）
    expect(report.retired.map(r => r.pagePath)).toEqual(["topics/top-zombie.md"])
    const notice = report.retired[0]
    expect(notice.status).toBe("committed")

    // 队列审计面：新 opKind auto-retire（红线1 附注——票面 AC2 逐字）
    const q = h.queue.get(notice.taskId)
    expect(q?.opKind).toBe("auto-retire")

    // 机械面=票04 统一退役（fs + LOG + 单 commit）
    expect(fs.existsSync(path.join(h.wikiRoot, "topics", "top-zombie.md"))).toBe(false)
    const retired = fs.readFileSync(path.join(h.wikiRoot, "_retired", "topics", "top-zombie.md"), "utf-8")
    expect(retired).toContain("<!--#oct-001-->") // 原号随册留存（恢复豁免的底座）
    expect(retired).toMatch(/^status: superseded$/m)
    const log = readLog(h.wikiRoot)
    expect(log).toContain("retire | topics/top-zombie.md")
    expect(log).toContain("auto") // LOG source 位=auto（票04 预留接缝兑现）
    expect(h.commitCount()).toBe(before + 1)

    // 通知卡数据面（AC3：锚点/页/判据数据/可恢复提示——恢复口令=锚点原号）
    expect(notice.anchors).toEqual(["oct-001"])
    expect(notice.retiredPath).toBe("_retired/topics/top-zombie.md")
    expect(notice.retireCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(notice.lastCited).toBe("2026-07-10T00:00:00.000Z")
    expect(notice.daysSilent).toBe(96) // (2026-10-14T12:00 − 2026-07-10T00:00) 的整日数=96（独立钉值）
    expect(notice.restoreHints).toEqual(["恢复 oct-001"])

    // notify 回调收到同一条（生产载体会经 appendKnowledgeSessionCards 进对话流）
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0][0].pagePath).toBe("topics/top-zombie.md")
  })

  it("窄口负断言全集（红线2 核心）：入链存在/窗未完/两账任一有名/低置信/volatile 到期/无锚/不可退目录——零入队零 commit，skipped 逐页给因", async () => {
    const h = harness({
      "topics/top-inbounded.md": TOPIC_INBOUNDED,
      "entities/ent-host.md": ENT_HOST,
      "topics/top-young.md": TOPIC_YOUNG,
      "topics/top-read.md": TOPIC_READ,
      "topics/top-lowconf.md": TOPIC_LOWCONF,
      "topics/hub/deep.md": TOPIC_HUB_CHILD,
      "concepts/con-noanchor.md": CONCEPT_NOANCHOR,
      "concepts/con-volatile.md": CONCEPT_VOLATILE,
    })
    const ledger = new KnowledgeEffectivenessDAO(h.db)
    // top-read：锚点键无行，但页级 Read 键近引（两账判据的 b 面）
    ledger.incrementCited("top-read", "2026-09-20T00:00:00.000Z")
    // top-lowconf：低置信+窗内有名——confidence 不在窄口射程（它靠有名被拦，不靠低置）
    ledger.upsert("oct-013", {
      cited_count: 4, helpful_count: 0, not_helpful_count: 4,
      last_cited: "2026-09-01T00:00:00.000Z", confidence: 0.05,
    })

    const before = h.commitCount()
    const report = await h.makeGate().run()

    // 自动执行路径零开启：不入队、不 commit、退役区零新增
    expect(report.retired).toEqual([])
    expect(h.retire.list()).toEqual([])
    expect(h.commitCount()).toBe(before)
    expect(fs.readdirSync(path.join(h.wikiRoot, "_retired"))).toEqual([])

    const reasons = Object.fromEntries(report.skipped.map(s => [s.relPath, s.reason]))
    expect(reasons["topics/top-inbounded.md"]).toBe("has-inbound-links") // 入链存在不命中
    expect(reasons["entities/ent-host.md"]).toBe("no-rule-anchor")
    expect(reasons["topics/top-young.md"]).toBe("window-incomplete")
    expect(reasons["topics/top-read.md"]).toBe("recent-cited") // 页级 Read 账拦住
    expect(reasons["topics/top-lowconf.md"]).toBe("recent-cited") // 低置信零自动路
    expect(reasons["topics/hub/deep.md"]).toBe("not-retirable") // 两层深不在白名单面
    expect(reasons["concepts/con-noanchor.md"]).toBe("no-rule-anchor")
    // volatile 到期（review_after 2026-09-01 已过）不自动退：判据零读 stability/review_after，
    // 该类目=票08 D7 finding 三选（续期/改写/退役）人裁域——此页以「无锚域外」离手
    expect(reasons["concepts/con-volatile.md"]).toBe("no-rule-anchor")
  })

  it("人工文件不命中（isManualFileTarget 双保险·纯函数面）：即便两账沉默零入链，判据亦拒收", () => {
    const page: NarrowGatePage = {
      relPath: "topics/user_preference.md",
      pageId: "top-x",
      anchors: ["oct-099"],
      lastCompiled: "2026-07-01",
      pageLedgerKey: "user_preference",
    }
    const ev: NarrowGateEvidence = {
      lastCitedByKey: new Map<string, string | null>(),
      cutoffIso: "2026-07-16T12:00:00.000Z",
      inboundHostCount: 0,
      isManualFile: true,
    }
    expect(narrowGateMissReason(page, ev)).toBe("manual-file")
    // 对照组：同页非人工 ⇒ 命中（null）——证明拦住它的正是人工文件闸而非其他条
    expect(narrowGateMissReason(page, { ...ev, isManualFile: false })).toBeNull()
  })

  it("幂等（同锚点不重复退役）：再跑一轮零新任务零新 commit（退役页离 scan 面）", async () => {
    const h = harness()
    const ledger = new KnowledgeEffectivenessDAO(h.db)
    ledger.incrementCited("oct-001", "2026-07-10T00:00:00.000Z")
    ledger.incrementCited("oct-002", "2026-09-20T00:00:00.000Z")

    const first = await h.makeGate().run()
    expect(first.retired).toHaveLength(1)
    const commitsAfterFirst = h.commitCount()

    const second = await h.makeGate().run()
    expect(second.retired).toHaveLength(0)
    expect(h.commitCount()).toBe(commitsAfterFirst)
    expect(h.retire.list()).toHaveLength(1) // 全局只有首夜的唯一退役任务
    // 第二夜 skipped 面：僵尸位已被退役，在册面只剩有名页与无锚页
    expect(second.scanned).toBe(2)
  })
})
