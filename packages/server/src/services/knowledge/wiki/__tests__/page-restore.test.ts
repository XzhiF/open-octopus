/**
 * 票09 item-4 S1 — 恢复通道真跑（真 git + tmpdir 知识根，零触真盘）。spec 故事 17：
 * 对话「恢复 oct-XXX」→ 从 _retired/ **原号原行**回迁（锚点永不复用纪律的恢复豁免：
 * 原号随迁，不重铸）+ **入链回补**（票04 备案=retire 单 commit diff 反放，
 * git 消息头 `retire: <path> → _retired/` 为发现面）+ LOG restore 行 + 单 commit，
 * 全程经全局队列（红线1，opKind="page-restore"——回迁是 wiki 写）。
 *
 * Expected 真相源=票面 AC4 + 笔记 01 §2.3（_retired 发号空间衔接注）。
 * 负断言：在册位被占=响亮拒绝 RESTORE_TARGET_TAKEN（不覆盖不并存的页）；宿主页漂移
 * =回补让位并显形（人裁面无自动取舍）；恢复后再恢复=RESTORE_TARGET_MISSING。
 */
import { describe, it, expect, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { applySchema } from "../../../../db/schema"
import { ensureWikiSkeleton } from "../paths"
import { CompileQueue } from "../compile-queue"
import { PageRetireTaskService } from "../page-retire"
import { PageRestoreTaskService, PageRestoreError, type PageRestoreTaskRecord } from "../page-restore"
import { nextRuleAnchor } from "../compile"
import type { GitRunner } from "../wiki-git"

const FROZEN = () => new Date("2026-10-14T12:00:00.000Z")

const realGit = (cwd: string): GitRunner => ({
  run(args: string[]) {
    const r = spawnSync("git", args, { cwd, timeout: 30000, env: { ...process.env, OCTOPUS_WIKI_COMMIT_SOURCE: "curate" } })
    return { status: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
  },
})

const TOPIC_ZOMBIE = `---
id: top-zombie
type: topic
title: 僵尸纪律页
summary: 票09 恢复通道 S1 fixture：携带规则锚点的在册 topic 页
topics: [probe]
links: []
last_compiled: 2026-07-01
sources: [doc:ar09]
---

## 硬约束
- 僵尸纪律一条 <!--#oct-001-->
`

/** 宿主实体页：front-matter links + 正文 [[..]] 双指向 top-zombie（回补断言载体）。 */
const ENT_HOST = `---
id: ent-host
type: entity
entity_kind: tool
title: 宿主实体页
summary: 入链回补证据载体：退役时双通道被摘，恢复时须逐字节还原
aliases: []
topics: [probe]
links: [top-zombie]
stability: stable
last_compiled: 2026-07-01
sources: [doc:ar09]
confidence: 0.8
---

## 用法
引用 [[top-zombie]] 的纪律。
`

function readLog(root: string): string {
  const p = path.join(root, "LOG.md")
  return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : ""
}

async function settle<T extends { status: string }>(get: (id: string) => T | undefined, id: string, capMs = 8000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const rec = get(id)
    if (rec && (rec.status === "committed" || rec.status === "failed")) return rec
    if (Date.now() - start > capMs) throw new Error(`task ${id} did not settle: ${JSON.stringify(rec)}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

interface H {
  db: Database.Database
  wikiRoot: string
  knowledgeRoot: string
  git: GitRunner
  queue: CompileQueue
  retire: PageRetireTaskService
  restore: PageRestoreTaskService
  commitCount: () => number
  tmpDir: string
}

let currentDb: Database.Database | null = null
let currentTmp: string | null = null

function harness(): H {
  const db = new Database(":memory:")
  applySchema(db)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "we09-restore-"))
  const knowledgeRoot = path.join(tmpDir, "knowledge")
  const wikiRoot = path.join(knowledgeRoot, "wiki")
  ensureWikiSkeleton(wikiRoot)
  fs.writeFileSync(path.join(wikiRoot, "topics", "top-zombie.md"), TOPIC_ZOMBIE, "utf-8")
  fs.writeFileSync(path.join(wikiRoot, "entities", "ent-host.md"), ENT_HOST, "utf-8")
  const git = realGit(wikiRoot)
  git.run(["init"])
  git.run(["config", "user.email", "we09@test.local"])
  git.run(["config", "user.name", "we09-test"])
  git.run(["config", "core.autocrlf", "false"])
  git.run(["add", "-A"])
  const seed = git.run(["commit", "-m", "seed: 恢复通道 S1 在册页"])
  if (seed.status !== 0) throw new Error(`seed commit failed: ${seed.stderr}`)

  const queue = new CompileQueue()
  const retire = new PageRetireTaskService({ db, root: knowledgeRoot, git, now: FROZEN, queue })
  const restore = new PageRestoreTaskService({ db, root: knowledgeRoot, git, now: FROZEN, queue })
  const commitCount = () => parseInt(git.run(["rev-list", "--count", "HEAD"]).stdout.trim(), 10)
  currentDb = db
  currentTmp = tmpDir
  return { db, wikiRoot, knowledgeRoot, git, queue, retire, restore, commitCount, tmpDir }
}

/** 真退役一页（对话通道入队+终态），返回退役 commit。 */
async function retireOne(h: H, input?: { path?: string; reason?: string; source?: string }) {
  const rec = h.retire.retire(input ?? { path: "topics/top-zombie.md", reason: "恢复通道前置退役" })
  const done = await settle<PageRetireTaskRecord & { status: string }>((id) => h.retire.get(id), rec.id)
  expect(done.status, JSON.stringify(done.error)).toBe("committed")
  return done
}

afterEach(() => {
  currentDb?.close()
  if (currentTmp) fs.rmSync(currentTmp, { recursive: true, force: true })
})

describe("PageRestoreTaskService — 恢复通道（票09 · spec 故事17）", () => {
  it("对话「恢复 oct-001」：原号原行回迁（锚点随迁不重铸）+ 入链回补（retire commit diff 反放，宿主逐字节还原）+ LOG restore 行 + page-restore kind 经队列 + DB/FTS 复登", async () => {
    const h = harness()
    await retireOne(h)
    // 退役后基线：宿主页已被摘链（[[top-zombie]]→[已退役]、links 项移除）
    const hostCleaned = fs.readFileSync(path.join(h.wikiRoot, "entities", "ent-host.md"), "utf-8")
    expect(hostCleaned).toContain("[已退役]")
    expect(hostCleaned).not.toContain("[[top-zombie]]")
    const commitsBefore = h.commitCount()

    const rec = h.restore.restore({ anchor: "oct-001" })
    expect(rec.id).toMatch(/^res-/)
    const done = await settle((id) => h.restore.get(id), rec.id)
    expect(done.status, JSON.stringify(done.error)).toBe("committed")

    // 队列审计面：page-restore kind（红线1——回迁是 wiki 写，经全局 FIFO）
    expect(h.queue.get(rec.id)?.opKind).toBe("page-restore")

    // 1. 原号原行：页回原位、锚点原号在册、退役标记剥除、正文逐字留存
    const live = fs.readFileSync(path.join(h.wikiRoot, "topics", "top-zombie.md"), "utf-8")
    expect(live).toContain("<!--#oct-001-->")
    expect(live).toContain("- 僵尸纪律一条 <!--#oct-001-->")
    expect(live).not.toMatch(/^status: superseded$/m)
    expect(live).not.toMatch(/^replaced_by:/m)
    expect(fs.existsSync(path.join(h.wikiRoot, "_retired", "topics", "top-zombie.md"))).toBe(false)

    // 2. 锚点永不复用纪律的恢复豁免=原号随迁：回迁后发号空间仍含 oct-001（发号不重蹈）
    expect(nextRuleAnchor(h.wikiRoot)).not.toBe("oct-001")
    expect(nextRuleAnchor(h.wikiRoot)).toBe("oct-002")

    // 3. 入链回补：宿主逐字节还原为退役前原文（票04 备案=commit 反放）
    const hostRestored = fs.readFileSync(path.join(h.wikiRoot, "entities", "ent-host.md"), "utf-8")
    expect(hostRestored).toBe(ENT_HOST)
    expect(done.result?.inboundRestored).toEqual(["entities/ent-host.md"])

    // 4. INDEX 复列 / LOG restore 行（注入钟日期 2026-10-14；service=dialogue 缺省）
    const index = fs.readFileSync(path.join(h.wikiRoot, "INDEX.md"), "utf-8")
    expect(index).toContain("topics/top-zombie.md")
    const log = readLog(h.wikiRoot)
    expect(log).toMatch(/^## \[2026-10-14\] restore \| topics\/top-zombie\.md$/m)
    expect(log).toContain("回迁")

    // 5. DB/FTS 复登（在册面回账）
    const row = h.db.prepare("SELECT id, path FROM wiki_articles WHERE id = ?").get("top-zombie") as { id: string; path: string } | undefined
    expect(row?.path).toBe("topics/top-zombie.md")
    // FTS 复登可命中（unicode61 制式：CJK 连串成整词，取正文完整词元——page-retire 同先例）
    const fts = h.db.prepare("SELECT rowid FROM wiki_fts WHERE wiki_fts MATCH ?").all("僵尸纪律一条")
    expect(fts.length).toBeGreaterThan(0)

    // 6. 单 commit 收口：+1，消息头可 grep（发现面/审计面）
    expect(h.commitCount()).toBe(commitsBefore + 1)
    expect(h.git.run(["log", "-1", "--format=%s"]).stdout).toContain("restore: topics/top-zombie.md ← _retired/")
  })

  it("在册位被占=响亮拒绝：RESTORE_TARGET_TAKEN（同步段 409），_retired/ 原样零 commit", async () => {
    const h = harness()
    await retireOne(h)
    // 同名新页占了原位（发号纪律保证锚点不重号，但路径可被新内容复用）
    fs.writeFileSync(path.join(h.wikiRoot, "topics", "top-zombie.md"), "---\nid: top-new-holder\ntype: topic\ntitle: 占位页\nsummary: 原位已有主\n---\n\n正文\n", "utf-8")
    h.git.run(["add", "-A"])
    h.git.run(["commit", "-m", "占位：新 topic 页住进原位"])
    const commitsBefore = h.commitCount()

    expect(() => h.restore.restore({ anchor: "oct-001" })).toThrowError(
      expect.objectContaining({ code: "RESTORE_TARGET_TAKEN" }) as unknown as Error,
    )
    expect(h.restore.list()).toHaveLength(0) // 校验失败不建任务（revert/retire 路由同律）
    expect(h.commitCount()).toBe(commitsBefore)
    expect(fs.existsSync(path.join(h.wikiRoot, "_retired", "topics", "top-zombie.md"))).toBe(true)
  })

  it("宿主页漂移=回补让位并显形：页本体照回迁，漂移宿主不自动覆盖（人裁域），warnings 进结果", async () => {
    const h = harness()
    await retireOne(h)
    // 退役后宿主页又被编辑（漂移）：diff 反放的语境对不上，恢复不得吞后期编辑
    const hostPath = path.join(h.wikiRoot, "entities", "ent-host.md")
    fs.writeFileSync(hostPath, fs.readFileSync(hostPath, "utf-8") + "\n漂移补充：后续编辑的一行。\n", "utf-8")
    h.git.run(["add", "-A"])
    h.git.run(["commit", "-m", "编辑宿主页（漂移现场）"])

    const rec = h.restore.restore({ anchor: "oct-001" })
    const done = await settle((id) => h.restore.get(id), rec.id)
    expect(done.status, JSON.stringify(done.error)).toBe("committed")

    // 页回迁成功
    expect(fs.existsSync(path.join(h.wikiRoot, "topics", "top-zombie.md"))).toBe(true)
    // 漂移宿主保持现文（不被反放覆盖），入链回补显形缺席
    expect(fs.readFileSync(hostPath, "utf-8")).toContain("漂移补充")
    expect(done.result?.inboundRestored).toEqual([])
    expect(done.result?.warnings.join("")).toContain("entities/ent-host.md")
  })

  it("幂等与缺席：恢复成功后再恢复=RESTORE_TARGET_MISSING（404，不建任务）；未知锚点同码；按 path 定位恢复可走通", async () => {
    const h = harness()
    await retireOne(h)
    const rec = h.restore.restore({ path: "topics/top-zombie.md" })
    const done = await settle((id) => h.restore.get(id), rec.id)
    expect(done.status).toBe("committed") // path 定位形态可恢复（同款接线第二入口）

    expect(() => h.restore.restore({ anchor: "oct-001" })).toThrowError(
      expect.objectContaining({ code: "RESTORE_TARGET_MISSING" }) as unknown as Error,
    )
    expect(() => h.restore.restore({ anchor: "oct-999" })).toThrowError(
      expect.objectContaining({ code: "RESTORE_TARGET_MISSING" }) as unknown as Error,
    )
    expect(h.restore.list()).toHaveLength(1) // 两次缺席拒都不建任务
  })

  it("错误面类型：PageRestoreError 携带 status（路由映射 400/404/409 用）", () => {
    const err = new PageRestoreError("INVALID_PARAM", "示例", 400)
    expect(err.code).toBe("INVALID_PARAM")
    expect(err.status).toBe(400)
    expect(err.message).toContain("INVALID_PARAM")
  })
})
