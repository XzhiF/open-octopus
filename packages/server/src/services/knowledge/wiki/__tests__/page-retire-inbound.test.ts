/**
 * 票04 · S1 — 退役清入链（spec 故事 26 · D-aa16-3 清偿）。
 * 真 git + tmpdir 知识根，零触真盘（复现靶形状参照 notes/04 §3.2 真盘现场）。
 * 断言全走外部产物：fs（宿主页链摘除后的正文/front-matter、退役页指针）、
 * git（入链摘除与退役**同一 commit**）、DB/FTS（宿主页正文与盘一致）、
 * L5 零潜伏扫描（全库活页 [[链接]] 无指向退役页者）。
 * LOG 日期断言宽松匹配（formatLogRow 走真 today()，基线红档案同款陷阱，勿钉冻结日期）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { applySchema } from "../../../../db/schema"
import { GLOBAL_WIKI_ORG } from "../../global-paths"
import { WikiArticleDAO } from "../../../../db/dao/wiki-article-dao"
import { ensureWikiSkeleton } from "../paths"
import { scanWikiEntries } from "../compile"
import { resolveWikiLink, WIKILINK_RE } from "../lint"
import { PageRetireTaskService, type PageRetireTaskRecord } from "../page-retire"
import type { GitRunner } from "../wiki-git"

const FROZEN = () => new Date("2026-10-14T08:00:00.000Z")
const realGit = (cwd: string): GitRunner => ({
  run(args: string[]) {
    const r = spawnSync("git", args, { cwd, timeout: 30000, env: { ...process.env, OCTOPUS_WIKI_COMMIT_SOURCE: "curate" } })
    return { status: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
  },
})

const RETIREE_PAGE = `---
id: con-retire-me
type: concept
title: 被退役概念页
summary: 活页入链摘除 S1 的被退役目标
topics: [probe]
links: []
last_compiled: 2026-10-13
sources: [doc:s1]
---

## 规则节
- 将被退役的纪律 <!--#oct-042-->
`

const HUB_A_PAGE = `---
id: top-hub-a
type: topic
title: 宿主A
summary: id 式与锚点式双引用退役页的活页宿主
topics: [probe]
links: [[con-retire-me], [con-keep]]
last_compiled: 2026-10-13
sources: [doc:s1]
---

## 导航
- 退役目标纪律指针：[[con-retire-me]]。
- 带锚点引用：见 [[con-retire-me#oct-042]] 一条。
- 无关页引用保留：[[con-keep]]。
`

const HUB_B_PAGE = `---
id: top-hub-b
type: topic
title: 宿主B
summary: 路径式引用退役页的活页宿主
topics: [probe]
links: [[con-retire-me]]
last_compiled: 2026-10-13
sources: [doc:s1]
---

## 导航
- 路径式：[[concepts/con-retire-me.md]]。
- 目录去缀式：[[concepts/con-retire-me]]。
`

const KEEP_PAGE = `---
id: con-keep
type: concept
title: 无关页
summary: 不被退役波及的概念页
topics: [probe]
links: []
last_compiled: 2026-10-13
sources: [doc:s1]
---

## 定义
与退役目标无关，只被宿主A活链引用。
`

function seedRow(dao: WikiArticleDAO, id: string, domain: string, title: string, body: string, relPath: string): void {
  dao.upsert({
    org: GLOBAL_WIKI_ORG, id, domain, title, summary: `${title} 摘要`,
    topics: '["probe"]', stability: "stable", last_compiled: "2026-10-13",
    sources: '["doc:s1"]', confidence: 0.5, body, path: relPath,
  })
  const rowid = dao.getRowid(GLOBAL_WIKI_ORG, id)!
  dao.insertFts({ rowid, id, domain, title, summary: `${title} 摘要`, topics: '["probe"]', body })
}

async function settle(svc: PageRetireTaskService, id: string, capMs = 8000): Promise<PageRetireTaskRecord> {
  const start = Date.now()
  for (;;) {
    const rec = svc.get(id)
    if (rec && (rec.status === "committed" || rec.status === "failed")) return rec
    if (Date.now() - start > capMs) throw new Error(`retire task ${id} did not settle: ${JSON.stringify(rec)}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe("PageRetireTaskService — 退役清入链（票04 · 故事26 · D-aa16-3）", () => {
  let db: Database.Database
  let tmpDir: string
  let knowledgeRoot: string
  let wikiRoot: string
  let git: GitRunner

  const read = (rel: string) => fs.readFileSync(path.join(wikiRoot, rel), "utf-8")

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "we04-inbound-"))
    knowledgeRoot = path.join(tmpDir, "knowledge")
    wikiRoot = path.join(knowledgeRoot, "wiki")
    ensureWikiSkeleton(wikiRoot)
    fs.writeFileSync(path.join(wikiRoot, "concepts", "con-retire-me.md"), RETIREE_PAGE, "utf-8")
    fs.writeFileSync(path.join(wikiRoot, "topics", "top-hub-a.md"), HUB_A_PAGE, "utf-8")
    fs.writeFileSync(path.join(wikiRoot, "topics", "top-hub-b.md"), HUB_B_PAGE, "utf-8")
    fs.writeFileSync(path.join(wikiRoot, "concepts", "con-keep.md"), KEEP_PAGE, "utf-8")
    // 知识根人工文件（真盘同位）：持链但在写保护/射程外——字节级不动的负断言材料
    fs.writeFileSync(path.join(knowledgeRoot, "user_preference.md"), "偏好：退役目标纪律见 [[con-retire-me]]。\n", "utf-8")

    git = realGit(wikiRoot)
    git.run(["init"])
    git.run(["config", "user.email", "we04@test.local"])
    git.run(["config", "user.name", "we04-test"])
    git.run(["config", "core.autocrlf", "false"])
    git.run(["add", "-A"])
    const seed = git.run(["commit", "-m", "seed: 宿主+退役目标+无关页"])
    if (seed.status !== 0) throw new Error(`seed commit failed: ${seed.stderr}`)

    const dao = new WikiArticleDAO(db)
    seedRow(dao, "con-retire-me", "concept", "被退役概念页", "\n## 规则节\n- 将被退役的纪律 <!--#oct-042-->\n", "concepts/con-retire-me.md")
    seedRow(dao, "top-hub-a", "topic", "宿主A", "\n## 导航\n- 退役目标纪律指针：[[con-retire-me]]。\n- 带锚点引用：见 [[con-retire-me#oct-042]] 一条。\n- 无关页引用保留：[[con-keep]]。\n", "topics/top-hub-a.md")
    seedRow(dao, "top-hub-b", "topic", "宿主B", "\n## 导航\n- 路径式：[[concepts/con-retire-me.md]]。\n- 目录去缀式：[[concepts/con-retire-me]]。\n", "topics/top-hub-b.md")
    seedRow(dao, "con-keep", "concept", "无关页", "\n## 定义\n与退役目标无关，只被宿主A活链引用。\n", "concepts/con-keep.md")
  })

  afterEach(() => {
    db?.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /** L5 零潜伏扫描：全库活页（INDEX/LOG 除外，即 scan 面）[[链接]] 目标均可解析。 */
  function scanBrokenLinks(): string[] {
    const corpus = scanWikiEntries(wikiRoot).map(e => ({ id: e.meta.id, path: e.relPath }))
    const broken: string[] = []
    for (const e of scanWikiEntries(wikiRoot)) {
      const raw = read(e.relPath)
      const body = raw.split("---\n")[2] ?? raw // 只扫正文段（front-matter links 单独断言）
      for (const m of body.matchAll(WIKILINK_RE)) {
        const t = (m[1] ?? "").trim()
        if (t && !resolveWikiLink(t, wikiRoot, corpus)) broken.push(`${e.relPath}: [[${t}]]`)
      }
    }
    return broken
  }

  it("退役执行体统一机械：活页入链摘除与退役同一 commit，全库零潜伏断链", async () => {
    const before = parseInt(git.run(["rev-list", "--count", "HEAD"]).stdout.trim(), 10)
    const keepBefore = read("concepts/con-keep.md")
    const svc = new PageRetireTaskService({ db, root: knowledgeRoot, git, now: FROZEN })
    const rec = svc.retire({ path: "concepts/con-retire-me.md", reason: "D-aa16-3 复现靶清链验证" })
    const done = await settle(svc, rec.id)
    expect(done.status, JSON.stringify(done.error)).toBe("committed")

    // 1. 退役位照旧：原位消失、_retired/ 带 superseded（票08 面零回归）
    expect(fs.existsSync(path.join(wikiRoot, "concepts", "con-retire-me.md"))).toBe(false)
    expect(read("_retired/concepts/con-retire-me.md")).toMatch(/^status: superseded$/m)

    // 2. 宿主A：id 式与锚点式入链均改指针文本，links 项摘除，无关活链保留
    const hubA = read("topics/top-hub-a.md")
    expect(hubA).not.toContain("[[con-retire-me")
    expect(hubA).toContain("[[con-keep]]")
    expect(hubA).toContain("[已退役]")
    expect(hubA).toMatch(/^links: \[\[con-keep\]\]$/m)

    // 3. 宿主B：路径式与目录去缀式同摘
    const hubB = read("topics/top-hub-b.md")
    expect(hubB).not.toContain("concepts/con-retire-me")
    expect(hubB).not.toContain("[[")
    expect(hubB).toContain("[已退役]")

    // 4. 无关页零触碰（逐字节）
    expect(read("concepts/con-keep.md")).toBe(keepBefore)

    // 5. 人工文件写保护不松动：知识根 user_preference.md 射程外且受保护——逐字节不动
    expect(fs.readFileSync(path.join(knowledgeRoot, "user_preference.md"), "utf-8")).toBe("偏好：退役目标纪律见 [[con-retire-me]]。\n")

    // 6. L5 零潜伏断言：退役执行后全库活页扫描无断链指向 _retired 页
    expect(scanBrokenLinks()).toEqual([])

    // 7. 同一 commit：恰 +1，且该 commit 同时携带页迁/INDEX/LOG/两宿主
    const after = parseInt(git.run(["rev-list", "--count", "HEAD"]).stdout.trim(), 10)
    expect(after).toBe(before + 1)
    const files = git.run(["show", "--name-only", "--format=", "HEAD"]).stdout.split(/\r?\n/).filter(Boolean)
    expect(files).toContain("_retired/concepts/con-retire-me.md")
    expect(files).toContain("topics/top-hub-a.md")
    expect(files).toContain("topics/top-hub-b.md")
    expect(files).toContain("INDEX.md")
    expect(files).toContain("LOG.md")

    // 8. LOG retire 行存在且带清链注记（日期宽松：真 today() 口径）
    const log = read("LOG.md")
    expect(log).toMatch(/## \[\d{4}-\d{2}-\d{2}\] retire \| concepts\/con-retire-me\.md/)
    expect(log).toContain("摘除 2 页入链")

    // 9. DB/FTS 与盘一致：宿主行正文已无退役引用，且检索面未受损
    const dao = new WikiArticleDAO(db)
    const rowA = dao.get(GLOBAL_WIKI_ORG, "top-hub-a")
    expect(rowA).toBeDefined()
    expect(rowA!.body).not.toContain("con-retire-me")
    expect(rowA!.body).toContain("[已退役]")
    const ftsA = dao.getFtsByRowid(dao.getRowid(GLOBAL_WIKI_ORG, "top-hub-a")!)
    expect(ftsA?.body).toContain("[已退役]") // FTS 面同步到摘链后正文
    // FTS5 unicode61 连续 CJK 为单 token——查询用精确 token 词形（既有测试「概念A」同款口径）
    expect(dao.search(GLOBAL_WIKI_ORG, "无关页").map(h => h.id)).toContain("con-keep") // 无关页检索面未波及
    expect(dao.search(GLOBAL_WIKI_ORG, "宿主A").map(h => h.id)).toContain("top-hub-a") // 宿主同步后仍可检索
    expect(dao.search(GLOBAL_WIKI_ORG, "宿主B").map(h => h.id)).toContain("top-hub-b")
  })

  it("replaced_by 指针落地：入参带替换者 ⇒ 退役页 front-matter 写机读行；不带 ⇒ 零噪音", async () => {
    const svc = new PageRetireTaskService({ db, root: knowledgeRoot, git, now: FROZEN })
    const withPtr = await settle(svc, svc.retire({ path: "concepts/con-retire-me.md", replacedBy: "con-successor" }).id)
    expect(withPtr.status, JSON.stringify(withPtr.error)).toBe("committed")
    const retired = read("_retired/concepts/con-retire-me.md")
    expect(retired).toMatch(/^status: superseded$/m)
    expect(retired).toMatch(/^replaced_by: con-successor$/m)
  })

  it("replaced_by 缺席 ⇒ 退役页不写该字段（旧页形态零扰动）", async () => {
    const svc = new PageRetireTaskService({ db, root: knowledgeRoot, git, now: FROZEN })
    const rec = await settle(svc, svc.retire({ path: "concepts/con-retire-me.md" }).id)
    expect(rec.status, JSON.stringify(rec.error)).toBe("committed")
    expect(read("_retired/concepts/con-retire-me.md")).not.toContain("replaced_by")
  })

  it("无入链宿主时退役照旧（票08 行为零回归：单页零链也 committed）", async () => {
    // 先手工摘掉两宿主页（模拟零入链库面），仅存退役目标 + 无关页
    fs.rmSync(path.join(wikiRoot, "topics", "top-hub-a.md"))
    fs.rmSync(path.join(wikiRoot, "topics", "top-hub-b.md"))
    git.run(["add", "-A"])
    git.run(["commit", "-m", "test: 移走宿主"])
    const svc = new PageRetireTaskService({ db, root: knowledgeRoot, git, now: FROZEN })
    const rec = await settle(svc, svc.retire({ path: "concepts/con-retire-me.md" }).id)
    expect(rec.status, JSON.stringify(rec.error)).toBe("committed")
    expect(read("LOG.md")).not.toContain("摘除")
  })
})
