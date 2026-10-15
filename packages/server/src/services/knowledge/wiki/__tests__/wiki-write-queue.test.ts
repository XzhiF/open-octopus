import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { CompileQueue, WRITE_OP_KINDS } from "../compile-queue"
import { WikiLock, WIKI_LOCK_FILE, WikiLockError, type WikiLockPayload } from "../wiki-lock"
import { scanWikiEntries } from "../compile"
import { GLOBAL_WIKI_ORG } from "../../global-paths"
import Database from "better-sqlite3"
import { applySchema } from "../../../../db/schema"
import { WikiArticleDAO } from "../../../../db/dao/wiki-article-dao"
import { CuratorTaskService } from "../curator-task"
import { CuratorError, type CuratorCompileResult } from "../curator"
import fs from "fs"
import path from "path"
import os from "os"
import { spawn } from "child_process"

/**
 * 票06 · S1 — 全局写串行：进程内 FIFO 编译队列 + wiki 根锁文件。
 *
 * 验证方法（spec §Testing Decisions）：**并发断言必须真并发**——Promise.all/同步连投
 * 起多路，不顺序模拟；环级测试真 fs + 真 git + tmpdir（wiki-compile.test 先例同法）。
 * Expected 从票面/原型独立推得（位次 #N、状态机 queued→running→committed/failed、
 * 锁文件 JSON 字段、git 线性），不从实现反推。
 */

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function until(cond: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`until 超时: ${what}`)
    await sleep(10)
  }
}

describe("CompileQueue — 进程内全局 FIFO 写串行（票06 AC2）", () => {
  it("并发入队的写操作一次跑一个、按登记顺序执行，后来者带排队位次 #N", async () => {
    const q = new CompileQueue()
    const order: string[] = []
    let active = 0
    let maxActive = 0
    const push = (name: string, ms: number) =>
      q.enqueue("ingest-compile", async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await sleep(ms)
        order.push(name)
        active--
      }, { taskId: name })

    // 真并发：三路同步连投（同一 tick 全部进队，谁都不等谁）
    const v1 = push("t1", 60)
    const v2 = push("t2", 60)
    const v3 = push("t3", 60)

    expect(v1.state).toBe("queued")
    expect([v2.position, v3.position]).toEqual([2, 3])
    expect(q.depth()).toBe(3)

    await until(() => q.depth() === 0, "队列排空")
    expect(order).toEqual(["t1", "t2", "t3"])
    expect(maxActive).toBe(1)
    expect(q.get("t1")?.state).toBe("committed")
    expect(q.get("t2")?.state).toBe("committed")
    expect(q.get("t3")?.state).toBe("committed")
  })

  it("单次操作失败 → 该任务记 failed（稳定错误码）→ 队列继续不堵死（票06 失败语义）", async () => {
    const q = new CompileQueue()
    const done: string[] = []
    q.enqueue("lint-fix", async () => {
      throw Object.assign(new Error("LINT_FAILED: 计划校验失败"), { code: "LINT_FAILED" })
    }, { taskId: "boom" })
    q.enqueue("revert", async () => {
      done.push("after")
    }, { taskId: "next" })

    await until(() => q.get("next")?.state === "committed", "失败后下一任务照常跑完")
    expect(done).toEqual(["after"])
    const bad = q.get("boom")
    expect(bad?.state).toBe("failed")
    expect(bad?.error?.code).toBe("LINT_FAILED")
    expect(q.depth()).toBe(0)
  })

  it("写操作 op kind 枚举单源（票06 AC1：后几类以枚举+入队通道预留；P3 票03 加 case-archive、票08 加 page-retire；P4 票09 加 auto-retire/page-restore）", () => {
    // 期望值逐字取票面：投喂编译/归档编译/对话修订/lint 自纠/finding 修复/回滚 revert/重蒸馏
    // + 判例自动入档（P3 票03：判例一切写经此 kind 入唯一写闸，禁直写 cases/——红线2）
    // + 页退役（票08：单页退役迁 _retired/ + superseded）
    // + 窄口自动退役/恢复回迁（P4 票09 AC2/AC4：kind 是审计面，执行复用票04 统一机械族）
    expect(WRITE_OP_KINDS).toEqual([
      "ingest-compile",
      "archive-compile",
      "dialog-revise",
      "lint-fix",
      "finding-fix",
      "revert",
      "redistill",
      "case-archive",
      "page-retire",
      "auto-retire",
      "page-restore",
    ])
  })
})

// ── S1 组②：wiki 根锁文件（跨进程保底）──

const lockPathOf = (wikiRoot: string) => path.join(wikiRoot, WIKI_LOCK_FILE)

function writeLock(wikiRoot: string, payload: WikiLockPayload): void {
  fs.writeFileSync(lockPathOf(wikiRoot), JSON.stringify(payload))
}

function readLock(wikiRoot: string): WikiLockPayload {
  return JSON.parse(fs.readFileSync(lockPathOf(wikiRoot), "utf-8"))
}

/** 拿一个真死 PID：起即退子进程，等 close（libuv 已回收，POSIX 上不留僵尸）。 */
function deadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" })
    child.on("close", () => resolve(child.pid!))
    child.on("error", reject)
  })
}

describe("WikiLock — wiki 根锁文件跨进程保底（票06 AC3）", () => {
  let tmpDir: string
  let wikiRoot: string
  let other: WikiLockPayload

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-lock-"))
    wikiRoot = path.join(tmpDir, "wiki")
    fs.mkdirSync(wikiRoot, { recursive: true })
    other = { pid: 424242, opKind: "ingest-compile", taskId: "other-instance", acquiredAt: Date.now(), heartbeatAt: Date.now() }
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("进程崩溃遗留的锁（PID 不存在）⇒ stale 自动回收；回收后锁归我，release 清锁", async () => {
    const dead = await deadPid()
    // 心跳新鲜但进程已死——崩溃保底判据①（story 39：一次崩溃永久卡死不可接受）
    writeLock(wikiRoot, { ...other, pid: dead })

    const lock = new WikiLock({ wikiRoot: () => wikiRoot })
    const release = await lock.acquire({ opKind: "revert", taskId: "mine-1" })
    const held = readLock(wikiRoot)
    expect(held.pid).toBe(process.pid)
    expect(held.taskId).toBe("mine-1")
    release()
    expect(fs.existsSync(lockPathOf(wikiRoot))).toBe(false)
  })

  it("活实例持锁（假 PID 在本机真实存活 + 心跳新鲜）⇒ 不抢锁，等待到超时报 LOCK_HELD", async () => {
    // 双实例模拟用假 PID：以本机确实存活的外部 pid 表达「另一实例」
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" })
    const otherLivePid = child.pid!
    try {
      writeLock(wikiRoot, { ...other, pid: otherLivePid })
      const lock = new WikiLock({ wikiRoot: () => wikiRoot, waitMs: 150, pollMs: 30 })
      const err = await lock.acquire({ opKind: "revert", taskId: "mine-2" }).then(() => null, e => e)
      expect(err).toBeInstanceOf(WikiLockError)
      expect((err as WikiLockError).code).toBe("LOCK_HELD")
      // 活锁不被误抢：原持有内容仍在盘
      expect(readLock(wikiRoot).taskId).toBe("other-instance")
    } finally {
      child.kill()
    }
  })

  it("心跳超时（PID 活着但 heartbeatAt 停摆超阈值）⇒ stale 判据②同样自动回收", async () => {
    // 假 PID 存活（探活 seam 判真）+ 心跳 90s 前（> staleAfter 60s）= 被冻结的持有者
    const alivePids = new Set([111_001, 111_002])
    writeLock(wikiRoot, { ...other, pid: 111_001, heartbeatAt: Date.now() - 90_000 })
    const lock = new WikiLock({
      wikiRoot: () => wikiRoot,
      pid: () => 111_002,
      isPidAlive: p => alivePids.has(p),
      staleAfterMs: 60_000,
      waitMs: 0,
    })
    const release = await lock.acquire({ opKind: "dialog-revise", taskId: "mine-3" })
    try {
      expect(readLock(wikiRoot).taskId).toBe("mine-3")
    } finally {
      release()
    }
  })

  it("持锁期间按 heartbeatInterval 持续刷新心跳（活锁永不被误判 stale）", async () => {
    const lock = new WikiLock({ wikiRoot: () => wikiRoot, heartbeatIntervalMs: 40 })
    const release = await lock.acquire({ opKind: "ingest-compile", taskId: "hb-1" })
    try {
      const first = readLock(wikiRoot)
      await sleep(150)
      const later = readLock(wikiRoot)
      expect(later.heartbeatAt).toBeGreaterThan(first.heartbeatAt)
      expect(later.taskId).toBe("hb-1")
    } finally {
      release()
    }
  })

  it("同机双实例抢锁：后来者等待、前者释放后接管——保底互斥真实成立（假 PID 双实例）", async () => {
    const alivePids = new Set([111_101, 111_102])
    const a = new WikiLock({ wikiRoot: () => wikiRoot, pid: () => 111_101, isPidAlive: p => alivePids.has(p), heartbeatIntervalMs: 30 })
    const b = new WikiLock({ wikiRoot: () => wikiRoot, pid: () => 111_102, isPidAlive: p => alivePids.has(p), heartbeatIntervalMs: 30, waitMs: 8_000, pollMs: 20 })

    const releaseA = await a.acquire({ opKind: "ingest-compile", taskId: "A" })
    expect(readLock(wikiRoot).taskId).toBe("A")

    const bPending = b.acquire({ opKind: "revert", taskId: "B" })
    await sleep(80)
    // B 在等，没抢——A 仍持有
    expect(readLock(wikiRoot).taskId).toBe("A")

    setTimeout(() => releaseA(), 60)
    const releaseB = await bPending
    expect(readLock(wikiRoot).taskId).toBe("B")
    releaseB()
    expect(fs.existsSync(lockPathOf(wikiRoot))).toBe(false)
  })
})

// ── S1 组③：失败不堵队（队列×锁接线）──

describe("CompileQueue × WikiLock — 单次编译失败不堵死全队（票06 AC6）", () => {
  let tmpDir: string
  let wikiRoot: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-qlock-"))
    wikiRoot = path.join(tmpDir, "wiki")
    fs.mkdirSync(wikiRoot, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("失败任务自身释放锁 → 后续任务照常持锁执行，队列不堵死", async () => {
    const lock = new WikiLock({ wikiRoot: () => wikiRoot, heartbeatIntervalMs: 40 })
    const q = new CompileQueue({ lock })
    const seen: { duringFail?: boolean; duringSecond?: boolean } = {}

    q.enqueue("ingest-compile", async () => {
      seen.duringFail = fs.existsSync(path.join(wikiRoot, WIKI_LOCK_FILE))
      throw Object.assign(new Error("WIKI_LINT_FAIL: 写闸拒收"), { code: "WIKI_LINT_FAIL" })
    }, { taskId: "fail1" })
    q.enqueue("lint-fix", async () => {
      seen.duringSecond = fs.existsSync(path.join(wikiRoot, WIKI_LOCK_FILE))
    }, { taskId: "ok2" })

    await until(() => q.depth() === 0, "两任务终态")
    expect(seen.duringFail).toBe(true)   // 失败任务在跑时确曾持锁
    expect(seen.duringSecond).toBe(true) // 后续任务同样持锁执行（锁已归还，非泄漏复用）
    expect(q.get("fail1")?.state).toBe("failed")
    expect(q.get("fail1")?.error?.code).toBe("WIKI_LINT_FAIL")
    expect(q.get("ok2")?.state).toBe("committed")
    // 终局：锁文件不残留、队列零深度
    expect(fs.existsSync(path.join(wikiRoot, WIKI_LOCK_FILE))).toBe(false)
  })

  it("锁被活实例占死时：任务带 LOCK_HELD 失败、队列继续（保底闸不瘫痪主队列）", async () => {
    // 另一实例（假 PID 存活 + 心跳新鲜）持锁；本队列等待上限压到 120ms
    writeLock(wikiRoot, { pid: process.pid, opKind: "ingest-compile", taskId: "other-instance", acquiredAt: Date.now(), heartbeatAt: Date.now() })
    const lock = new WikiLock({ wikiRoot: () => wikiRoot, heartbeatIntervalMs: 40, waitMs: 120, pollMs: 20 })
    const q = new CompileQueue({ lock })
    let secondRan = false
    q.enqueue("revert", async () => { throw new Error("不该执行") }, { taskId: "blocked" })
    q.enqueue("archive-compile", async () => { secondRan = true }, { taskId: "after" })

    await until(() => q.depth() === 0, "两任务终态")
    expect(q.get("blocked")?.state).toBe("failed")
    expect(q.get("blocked")?.error?.code).toBe("LOCK_HELD")
    // 第二任务在写锁「未衰」期间同样被占 ⇒ LOCK_HELD；关键断言：队列没堵死、状态都落终
    expect(q.get("after")?.state).toBe("failed")
    expect(q.get("after")?.error?.code).toBe("LOCK_HELD")
    expect(secondRan).toBe(false)
    fs.rmSync(path.join(wikiRoot, WIKI_LOCK_FILE), { force: true }) // 清理模拟锁
  })
})

// ── S1 组④：读永不锁 ──

const READ_PAGE = `---
id: con-read-me
type: concept
title: 读路径演示页
summary: 串行写进行中的检索词 全局写串行
topics: []
links: []
last_compiled: 2026-10-13
sources: []
---

## 定义
读路径不参与锁——浏览/检索/agent 查阅在编译进行中照常返回（serialization 检索锚词）。
`

function seedFtsRow(dao: WikiArticleDAO, row: { id: string; title: string; summary: string; body: string }) {
  dao.upsert({
    org: GLOBAL_WIKI_ORG,
    id: row.id,
    domain: "concept",
    title: row.title,
    summary: row.summary,
    topics: JSON.stringify([]),
    stability: "stable",
    last_compiled: "2026-10-13",
    sources: JSON.stringify([]),
    confidence: 0.8,
    body: row.body,
    path: `concepts/${row.id}.md`,
  })
  const rowid = dao.getRowid(GLOBAL_WIKI_ORG, row.id)!
  dao.insertFts({ rowid, id: row.id, domain: "concept", title: row.title, summary: row.summary, topics: JSON.stringify([]), body: row.body })
}

describe("读永不锁 — 编译进行中 tree/页 Read/search 正常（票06 AC4）", () => {
  let tmpDir: string
  let wikiRoot: string
  let db: Database.Database
  let dao: WikiArticleDAO

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-readlock-"))
    wikiRoot = path.join(tmpDir, "wiki")
    fs.mkdirSync(path.join(wikiRoot, "concepts"), { recursive: true })
    fs.writeFileSync(path.join(wikiRoot, "concepts", "con-read-me.md"), READ_PAGE)
    db = new Database(":memory:")
    applySchema(db)
    dao = new WikiArticleDAO(db)
    seedFtsRow(dao, { id: "con-read-me", title: "读路径演示页", summary: "串行写进行中的检索词 全局写串行", body: READ_PAGE })
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("写任务在跑且锁在盘时：INDEX 扫描 / 页 Read / FTS search 三路读照常返回", async () => {
    const lock = new WikiLock({ wikiRoot: () => wikiRoot, heartbeatIntervalMs: 30 })
    const q = new CompileQueue({ lock })
    q.enqueue("ingest-compile", async () => { await sleep(300) }, { taskId: "slow-compile" })

    await until(() => q.get("slow-compile")?.state === "running", "任务进入在跑")
    expect(fs.existsSync(path.join(wikiRoot, WIKI_LOCK_FILE))).toBe(true) // 锁确被占用

    // 三路读（spec 故事27 导航协议的读面：INDEX 扫盘 → 页整读 → search API 兜底）
    const scanned = scanWikiEntries(wikiRoot)
    expect(scanned.map(e => e.meta.id)).toContain("con-read-me")
    expect(fs.readFileSync(path.join(wikiRoot, "concepts", "con-read-me.md"), "utf-8")).toContain("读路径不参与锁")
    expect(dao.search(GLOBAL_WIKI_ORG, "serialization").length).toBeGreaterThan(0)

    // 读发生在「编译进行中」窗口内（任务彼时仍 running——读不排队等写）
    expect(q.get("slow-compile")?.state).toBe("running")
    await until(() => q.depth() === 0, "队列排空")
    expect(fs.existsSync(path.join(wikiRoot, WIKI_LOCK_FILE))).toBe(false)
  })
})

// ── S1 组①补：投喂编译入口改走全局队列（票05 registry × 票06 队列）──

const stubCompileResult = (rawPath: string): CuratorCompileResult => ({
  rawPath,
  rawHash: "0".repeat(64),
  rawTitle: rawPath,
  touched: [],
  created: 0,
  updated: 0,
  contradictions: 0,
  findingIds: [],
  commit: null,
  changed: false,
  deduped: true,
  warnings: [],
})

describe("CuratorTaskService 投喂入口改走全局 FIFO（票06 AC1：队列包住唯一写闸）", () => {
  let tmpDir: string
  let root: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-curate-q-"))
    root = path.join(tmpDir, "knowledge")
    fs.mkdirSync(path.join(root, "raw", "inbox"), { recursive: true })
    fs.writeFileSync(path.join(root, "raw", "inbox", "a.md"), "---\nhash: x\n---\nbody\n")
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("submit 即入队：任务以 crt id 进全局队列（带位次 #N），run 是唯一被串行执行的写闸", async () => {
    const q = new CompileQueue()
    const gate = { active: 0, max: 0 }
    const svc = new CuratorTaskService({
      root,
      queue: q,
      run: async (rawPath) => {
        gate.active++
        gate.max = Math.max(gate.max, gate.active)
        await sleep(60)
        gate.active--
        return stubCompileResult(rawPath)
      },
    })

    // 另一类写操作先占队头（redistill 通道预留）——投喂任务必须排在其后
    q.enqueue("redistill", () => sleep(120), { taskId: "wq-block" })
    const rec = svc.submit("raw/inbox/a.md")
    expect(rec.status).toBe("queued")

    const view = q.get(rec.id)
    expect(view?.opKind).toBe("ingest-compile")
    expect(view?.position).toBe(2) // 全局位次：blocker #1、本任务 #2
    expect(view?.label).toBe("raw/inbox/a.md")

    await until(() => svc.get(rec.id)?.status === "committed", "投喂编译经队列跑完")
    expect(gate.max).toBe(1) // run 从未与 blocker 并行（串行由队列单点保证）
    expect(q.get(rec.id)?.state).toBe("committed")
  })

  it("编译失败 → registry failed 与队列 failed 同步（错误码透传，不堵队）", async () => {
    const q = new CompileQueue()
    const svc = new CuratorTaskService({
      root,
      queue: q,
      run: async () => {
        throw new CuratorError("CURATOR_LLM_JSON", "计划不是 JSON", 502)
      },
    })
    const r1 = svc.submit("raw/inbox/a.md")
    await until(() => svc.get(r1.id)?.status === "failed", "首任务失败终态")
    expect(svc.get(r1.id)?.error?.code).toBe("CURATOR_LLM_JSON")
    expect(q.get(r1.id)?.state).toBe("failed")
    expect(q.get(r1.id)?.error?.code).toBe("CURATOR_LLM_JSON")

    const r2 = svc.submit("raw/inbox/a.md")
    await until(() => q.get(r2.id)?.state === "failed", "队列继续跑第二单")
    expect(q.depth()).toBe(0)
  })
})

// ── 真并发验收（票06 AC7 / spec 故事40）：两路同时投喂编译 → 串行落库 ──

import { spawnSync } from "child_process"
import type { GitRunner } from "../wiki-git"
import { RawIngestService } from "../../raw"
import { CuratorCompileService, type LLMCall } from "../curator"

const realGit = (cwd: string): GitRunner => ({
  run(args: string[]) {
    const r = spawnSync("git", args, { cwd, timeout: 30000, env: { ...process.env, OCTOPUS_WIKI_COMMIT_SOURCE: "curate" } })
    return { status: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
  },
})

const FROZEN_NOW = () => new Date("2026-10-13T08:00:00.000Z")

const RAW_A = `# Alpha source

Alpha claims: the queue serializes all wiki writes and the lock is the cross-process net.
`

const RAW_B = `# Beta source

Beta claims: anchors are issued max+1 and reads never wait for the compiler.
`

function topicPlan(prefix: "alpha" | "beta", rule1: string, rule2: string): string {
  return JSON.stringify({
    pages: [{
      op: "create",
      type: "topic",
      id: `top-${prefix}`,
      title: `${prefix === "alpha" ? "Alpha" : "Beta"} 纪律页`,
      summary: `真并发投喂的 ${prefix} 侧主题页`,
      topics: [],
      links: [],
      body: `## SOP\n${prefix} 流程一行。\n\n## 硬约束\n- ${rule1} <!--#oct-NEW-->\n- ${rule2} <!--#oct-NEW-->\n`,
    }],
    key_points: [`${prefix} 要点`],
    contradictions: [],
  })
}

describe("真并发验收 — 两路同时投喂编译串行落库（票06 AC7：git 线性 / LOG 不交错 / 锚点无双花）", () => {
  let db: Database.Database
  let tmpDir: string
  let root: string
  let wikiRoot: string

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-accept-"))
    root = path.join(tmpDir, "knowledge")
    wikiRoot = path.join(root, "wiki")
    fs.mkdirSync(root, { recursive: true })
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("Promise.all 双路投喂：单编译互斥、git 线性无 merge、LOG 两条完整不交错、锚点 oct-001..004 无双花", async () => {
    const rawSvc = new RawIngestService({ root, now: FROZEN_NOW })
    const a = rawSvc.ingestText({ text: RAW_A, title: "Alpha Source" })
    const b = rawSvc.ingestText({ text: RAW_B, title: "Beta Source" })
    expect(a.deduped).toBe(false)
    expect(b.deduped).toBe(false)

    // 票面 AC5：raw 落盘不入队——两源已冻结在盘，全局队列仍零深度
    const q = new CompileQueue({
      lock: new WikiLock({ wikiRoot: () => wikiRoot, heartbeatIntervalMs: 50, pollMs: 20 }),
    })
    expect(q.depth()).toBe(0)

    const gate = { active: 0, max: 0 }
    const capturedPrompts: string[] = []
    const svc = new CuratorTaskService({
      root,
      queue: q,
      run: async (rawPath) => {
        gate.active++
        gate.max = Math.max(gate.max, gate.active)
        try {
          const curator = new CuratorCompileService({
            db,
            root,
            git: realGit(wikiRoot),
            now: FROZEN_NOW,
            llm: (async (prompt: string) => {
              capturedPrompts.push(prompt)
              // 按 raw 段独占行 `- path:` 选计划（fixture seam，不连真模型）——
              // 注意不能裸 includes(raw 路径)：第二路 prompt 的现库页 front-matter sources
              // 会引用第一路 raw 路径（编译产物里天然带），必须锚定 raw 段行首
              return prompt.includes(`- path: ${a.raw.path}`) ? topicPlan("alpha", "alpha 规则一", "alpha 规则二") : topicPlan("beta", "beta 规则一", "beta 规则二")
            }) satisfies LLMCall,
          })
          return await curator.compileRaw(curator.resolveRawPointer(rawPath))
        } finally {
          gate.active--
        }
      },
    })

    // ── 真并发调用（spec Testing Decisions：不许顺序模拟）──
    await Promise.all([
      (async () => svc.submit(a.raw.path))(),
      (async () => svc.submit(b.raw.path))(),
    ])
    const t1 = svc.list().find(t => t.rawPath === a.raw.path)!
    const t2 = svc.list().find(t => t.rawPath === b.raw.path)!

    await until(
      () => q.get(t1.id)?.state === "committed" && q.get(t2.id)?.state === "committed",
      "双路编译串行落库",
      60_000,
    )
    expect(gate.max).toBe(1) // 单次编译互斥（全局写闸从未双开）

    // ── git log 线性无 merge commit ──
    expect(realGit(wikiRoot).run(["log", "--merges", "--oneline"]).stdout.trim()).toBe("")
    expect(realGit(wikiRoot).run(["rev-list", "--count", "HEAD"]).stdout.trim()).toBe("2")
    for (const line of realGit(wikiRoot).run(["log", "--pretty=%P"]).stdout.split(/\r?\n/).filter(Boolean)) {
      expect(line.trim().split(/\s+/).length).toBeLessThanOrEqual(1) // 每提交 ≤1 父 = 线性史
    }

    // ── 锁文件不进仓（.git/info/exclude 保底），终局无残留、仓面干净 ──
    expect(realGit(wikiRoot).run(["status", "--porcelain"]).stdout.trim()).toBe("")
    expect(realGit(wikiRoot).run(["ls-files"]).stdout).not.toContain(WIKI_LOCK_FILE)
    expect(fs.existsSync(path.join(wikiRoot, WIKI_LOCK_FILE))).toBe(false)

    // ── LOG.md 时间线不交错：恰好两条 ingest 记录，块（头行+→行）完整且先完成者在前 ──
    const log = fs.readFileSync(path.join(wikiRoot, "LOG.md"), "utf-8")
    const headers = log.split(/\r?\n/).filter(l => /^## \[/.test(l))
    expect(headers).toHaveLength(2)
    const firstFinished = (q.get(t1.id)!.finishedAt! <= q.get(t2.id)!.finishedAt!) ? "Alpha Source" : "Beta Source"
    expect(headers[0]).toContain(firstFinished)
    // 每条记录各自带完整结果行（未被另一次编译的行插进块中间）
    const lines = log.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      if (/^## \[/.test(lines[i]) && lines[i].includes("Alpha Source")) expect(lines[i + 1]).toMatch(/^ {2}→ /)
      if (/^## \[/.test(lines[i]) && lines[i].includes("Beta Source")) expect(lines[i + 1]).toMatch(/^ {2}→ /)
    }

    // ── 锚点发号 max+1 串行下无双花：全库四枚恰好 oct-001..oct-004 ──
    const anchors = scanWikiEntries(wikiRoot).flatMap(e => e.anchors).sort()
    expect(new Set(anchors).size).toBe(anchors.length) // 无双花
    expect(anchors).toEqual(["oct-001", "oct-002", "oct-003", "oct-004"])

    // ── 串行可见性：第二路编译的 prompt 看到第一路的页（读最新态，非陈旧快照）──
    expect(capturedPrompts).toHaveLength(2)
    const secondPrompt = firstFinished === "Alpha Source" ? capturedPrompts[1] : capturedPrompts[0]
    expect(secondPrompt).toContain(`top-${firstFinished === "Alpha Source" ? "alpha" : "beta"}`)
  }, 120_000)
})
