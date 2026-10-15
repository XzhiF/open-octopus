/**
 * 票02 · S1 深回滚 = 状态重建（真 git + tmpdir 知识根，零触真盘）。
 * spec 故事 22-23/31；复现靶 = D-kc15-3 现场形状（笔记 04 §1）：
 * 目标编译 commit 之后又有 ≥2 次触 INDEX/LOG 共行的编译——旧语义
 * `git revert --no-commit` 三方合并必冲突（REVERT_CONFLICT），新语义状态重建必成功。
 * 断言全走外部产物：页文件 fs / INDEX 重建 / LOG 审计行（原 compile 行保留 +
 * deep-revert 行 append，append-only 换芯）/ DB+FTS 四路一致；
 * git 线性无 merge commit、恰新增一枚；日期走注入时钟（不再钉真实日）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { spawnSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { applySchema } from "../../../../db/schema"
import { WikiArticleDAO } from "../../../../db/dao/wiki-article-dao"
import { GLOBAL_WIKI_ORG, WIKI_RETIRED_DIR } from "../../global-paths"
import { ensureWikiSkeleton } from "../paths"
import { scanWikiEntries, renderBudgetedWikiIndex, WIKI_INDEX_FILE, WIKI_LOG_FILE, WIKI_LOG_HEADER } from "../compile"
import { RevertTaskService, type RevertTaskRecord } from "../revert"
import type { GitRunner } from "../wiki-git"

const FROZEN = () => new Date("2026-10-14T08:00:00.000Z")
const realGit = (cwd: string): GitRunner => ({
  run(args: string[]) {
    const r = spawnSync("git", args, { cwd, timeout: 30000, env: { ...process.env, OCTOPUS_WIKI_COMMIT_SOURCE: "curate" } })
    return { status: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
  },
})

/** 合法 v3 概念页（page-retire.test.ts 同族形制，parseWikiFile/entryRowFromDisk 可解析）。 */
function conceptPage(id: string, title: string, bodyWord: string): string {
  return `---
id: ${id}
type: concept
title: ${title}
summary: 深回滚复现靶页 ${id}
topics: [probe]
links: []
last_compiled: 2026-10-14
sources: [doc:deep-${id}]
---

## 规则节
- ${bodyWord}纪律 <!--#oct-090-->
`
}

async function settle(svc: RevertTaskService, id: string, capMs = 30000): Promise<RevertTaskRecord> {
  const start = Date.now()
  for (;;) {
    const rec = svc.get(id)
    if (rec && (rec.status === "committed" || rec.status === "failed")) return rec
    if (Date.now() - start > capMs) throw new Error(`revert task ${id} did not settle: ${JSON.stringify(rec)}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe("RevertTaskService — 深回滚状态重建（票02 · 故事22/23/31 · D-kc15-3 复现靶）", () => {
  let db: Database.Database
  let tmpDir: string
  let knowledgeRoot: string
  let wikiRoot: string
  let git: GitRunner

  /** 模拟编译通道的落盘形态：写页 → INDEX 程序化重建 → LOG append 一行 → 单 commit。返回 commit 全 hash。 */
  function compileCommit(relPath: string, id: string, title: string, bodyWord: string): string {
    fs.writeFileSync(path.join(wikiRoot, relPath), conceptPage(id, title, bodyWord), "utf-8")
    const entries = scanWikiEntries(wikiRoot)
    fs.writeFileSync(path.join(wikiRoot, WIKI_INDEX_FILE), renderBudgetedWikiIndex(entries, GLOBAL_WIKI_ORG).content, "utf-8")
    const logPath = path.join(wikiRoot, WIKI_LOG_FILE)
    const logBase = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : WIKI_LOG_HEADER
    fs.writeFileSync(logPath, logBase + `## [2026-10-14] compile | ${relPath}\n  → 深回滚靶编译 · doc:deep-${id} · owner ✓\n`, "utf-8")
    const dao = new WikiArticleDAO(db)
    dao.upsert({
      org: GLOBAL_WIKI_ORG, id, domain: "concept",
      title, summary: `深回滚复现靶页 ${id}`,
      topics: '["probe"]', stability: "stable", last_compiled: "2026-10-14",
      sources: JSON.stringify([`doc:deep-${id}`]),
      confidence: 0.5, body: `\n## 规则节\n- ${bodyWord}纪律 <!--#oct-090-->\n`,
      path: relPath,
    })
    const rowid = dao.getRowid(GLOBAL_WIKI_ORG, id)
    if (rowid !== undefined) {
      dao.deleteFts(rowid)
      dao.insertFts({ rowid, id, domain: "concept", title, summary: `深回滚复现靶页 ${id}`, topics: '["probe"]', body: `${bodyWord}纪律` })
    }
    git.run(["add", "-A"])
    const r = git.run(["commit", "-m", `compile: ${relPath} — 深回滚靶`])
    if (r.status !== 0) throw new Error(`fixture commit failed: ${r.stderr}`)
    return git.run(["rev-parse", "HEAD"]).stdout.trim()
  }

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "we02-deep-revert-"))
    knowledgeRoot = path.join(tmpDir, "knowledge")
    wikiRoot = path.join(knowledgeRoot, "wiki")
    ensureWikiSkeleton(wikiRoot)
    git = realGit(wikiRoot)
    git.run(["init"])
    git.run(["config", "user.email", "we02@test.local"])
    git.run(["config", "user.name", "we02-test"])
    git.run(["config", "core.autocrlf", "false"])
    // seed：空导航层入库（真仓首编译前形态）
    fs.writeFileSync(path.join(wikiRoot, WIKI_LOG_FILE), WIKI_LOG_HEADER, "utf-8")
    fs.writeFileSync(path.join(wikiRoot, WIKI_INDEX_FILE), renderBudgetedWikiIndex([], GLOBAL_WIKI_ORG).content, "utf-8")
    git.run(["add", "-A"])
    const seed = git.run(["commit", "-m", "seed: 骨架+导航层"])
    if (seed.status !== 0) throw new Error(`seed commit failed: ${seed.stderr}`)
  })

  afterEach(() => {
    db?.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /** 模拟改页 commit（重编译/finding 修订形态）：覆盖内容 + INDEX/LOG 照触 + commit。 */
  function modifyCommit(relPath: string, content: string, msg: string): string {
    fs.writeFileSync(path.join(wikiRoot, relPath), content, "utf-8")
    const entries = scanWikiEntries(wikiRoot)
    fs.writeFileSync(path.join(wikiRoot, WIKI_INDEX_FILE), renderBudgetedWikiIndex(entries, GLOBAL_WIKI_ORG).content, "utf-8")
    const logPath = path.join(wikiRoot, WIKI_LOG_FILE)
    fs.writeFileSync(logPath, fs.readFileSync(logPath, "utf-8") + `## [2026-10-14] compile | ${relPath}\n  → ${msg} · doc:mod · owner ✓\n`, "utf-8")
    git.run(["add", "-A"])
    const r = git.run(["commit", "-m", `compile: ${relPath} — ${msg}`])
    if (r.status !== 0) throw new Error(`fixture commit failed: ${r.stderr}`)
    return git.run(["rev-parse", "HEAD"]).stdout.trim()
  }

  /** 模拟退役 commit（page-retire 落盘形制）：live→_retired 迁位 + INDEX/LOG + DB 摘除 + commit。 */
  function retireCommit(relPath: string, id: string): string {
    const abs = path.join(wikiRoot, relPath)
    const retiredAbs = path.join(wikiRoot, WIKI_RETIRED_DIR, relPath)
    fs.mkdirSync(path.dirname(retiredAbs), { recursive: true })
    fs.writeFileSync(retiredAbs, fs.readFileSync(abs, "utf-8"), "utf-8")
    fs.rmSync(abs)
    const entries = scanWikiEntries(wikiRoot)
    fs.writeFileSync(path.join(wikiRoot, WIKI_INDEX_FILE), renderBudgetedWikiIndex(entries, GLOBAL_WIKI_ORG).content, "utf-8")
    const logPath = path.join(wikiRoot, WIKI_LOG_FILE)
    fs.writeFileSync(logPath, fs.readFileSync(logPath, "utf-8") + `## [2026-10-14] retire | ${relPath}\n  → 退役入 _retired/ · fixture · owner ✓\n`, "utf-8")
    const dao = new WikiArticleDAO(db)
    const rowid = dao.getRowid(GLOBAL_WIKI_ORG, id)
    if (rowid !== undefined) dao.deleteFts(rowid)
    dao.delete(GLOBAL_WIKI_ORG, id)
    git.run(["add", "-A"])
    const r = git.run(["commit", "-m", `retire: ${relPath} → _retired/（superseded）`])
    if (r.status !== 0) throw new Error(`fixture commit failed: ${r.stderr}`)
    return git.run(["rev-parse", "HEAD"]).stdout.trim()
  }

  it("目标编译之后又有两枚共行编译 ⇒ 深回滚成功、四路一致、git 线性、审计行完整（D-kc15-3 翻正）", async () => {
    const c1 = compileCommit("concepts/con-deep-a.md", "con-deep-a", "深靶概念A", "甲")
    const c2 = compileCommit("concepts/con-deep-b.md", "con-deep-b", "深靶概念B", "乙")
    const c3 = compileCommit("concepts/con-deep-c.md", "con-deep-c", "深靶概念C", "丙")
    // 现场形状自查：目标之后 ≥2 枚 commit 触及 INDEX/LOG 共行（D-kc15-3 真形 = 44 枚，此处 2 枚同型）
    const shared = parseInt(git.run(["rev-list", "--count", `${c1}..HEAD`, "--", "INDEX.md", "LOG.md"]).stdout.trim(), 10)
    expect(shared).toBeGreaterThanOrEqual(2)

    const before = parseInt(git.run(["rev-list", "--count", "HEAD"]).stdout.trim(), 10)
    const svc = new RevertTaskService({ db, root: knowledgeRoot, git, now: FROZEN })
    const rec = svc.revert(c1)
    expect(rec.status).toBe("queued")
    expect(rec.id).toMatch(/^rvt-/)

    const done = await settle(svc, rec.id)
    expect(done.status, JSON.stringify(done.error)).toBe("committed")
    expect(done.result.target).toBe(c1)
    expect(done.result.revertCommit).toMatch(/^[0-9a-f]{40}$/)
    expect([c1, c2, c3, done.result.revertCommit].filter((h, i, a) => a.indexOf(h) === i)).toHaveLength(4)

    // ── 页文件：目标 commit 的产物被撤销，后续 commit 的产物保留 ──
    expect(fs.existsSync(path.join(wikiRoot, "concepts", "con-deep-a.md"))).toBe(false)
    expect(fs.existsSync(path.join(wikiRoot, "concepts", "con-deep-b.md"))).toBe(true)
    expect(fs.existsSync(path.join(wikiRoot, "concepts", "con-deep-c.md"))).toBe(true)
    const aEntry = done.result.touched.find((t) => t.path === "concepts/con-deep-a.md")
    expect(aEntry?.action).toBe("removed")

    // ── INDEX 程序化重建：摘目标页、保留后续页 ──
    const index = fs.readFileSync(path.join(wikiRoot, WIKI_INDEX_FILE), "utf-8")
    expect(index).not.toContain("con-deep-a")
    expect(index).toContain("con-deep-b")
    expect(index).toContain("con-deep-c")

    // ── LOG 审计面换芯：append-only——历史 compile 行不再被回退，deep-revert 行追加 ──
    const log = fs.readFileSync(path.join(wikiRoot, WIKI_LOG_FILE), "utf-8")
    expect(log).toContain("## [2026-10-14] compile | concepts/con-deep-a.md")
    expect(log).toContain("## [2026-10-14] compile | concepts/con-deep-c.md")
    expect(log).toMatch(new RegExp(`^## \\[2026-10-14\\] deep-revert \\| compile ${c1.slice(0, 7)}$`, "m"))
    expect(log).toMatch(/^  → 回滚本次编译 · 状态重建 \d+ 页 · owner ✓$/m)

    // ── DB/FTS 与盘一致（FTS 查询用 unicode61 全 token——CJK 子串不可 MATCH，DAO 注先例）──
    const rows = (db.prepare("SELECT COUNT(*) AS n FROM wiki_articles WHERE id = 'con-deep-a'").get() as { n: number }).n
    expect(rows).toBe(0)
    expect(db.prepare("SELECT id FROM wiki_articles WHERE id IN ('con-deep-b','con-deep-c')").all()).toHaveLength(2)
    expect(db.prepare("SELECT rowid FROM wiki_fts WHERE wiki_fts MATCH ?").all("深靶概念A")).toHaveLength(0)
    expect(db.prepare("SELECT rowid FROM wiki_fts WHERE wiki_fts MATCH ?").all("深靶概念C")).toHaveLength(1)

    // ── git：线性（无 merge commit）、恰新增一枚、顶行同族可 grep ──
    const after = parseInt(git.run(["rev-list", "--count", "HEAD"]).stdout.trim(), 10)
    expect(after).toBe(before + 1)
    expect(git.run(["log", "--merges", "--oneline"]).stdout.trim()).toBe("")
    expect(git.run(["log", "-1", "--format=%s"]).stdout).toMatch(/^deep-revert: [0-9a-f]{7,} — 回滚本次编译/)
  })

  it("回滚改页 commit ⇒ restored 分支：内容强制回 T^ 版（后续人工补充同被强制对齐——无冲突面语义的另一半）", async () => {
    compileCommit("concepts/con-deep-a.md", "con-deep-a", "深靶概念A", "甲")
    const c2 = modifyCommit("concepts/con-deep-a.md", conceptPage("con-deep-a", "深靶概念A", "甲改") + "\n后续人工补充。\n", "补纪律")
    const svc = new RevertTaskService({ db, root: knowledgeRoot, git, now: FROZEN })
    const done = await settle(svc, svc.revert(c2).id)
    expect(done.status, JSON.stringify(done.error)).toBe("committed")
    expect(done.result.touched.find((t) => t.path === "concepts/con-deep-a.md")?.action).toBe("restored")
    const body = fs.readFileSync(path.join(wikiRoot, "concepts", "con-deep-a.md"), "utf-8")
    expect(body).toContain("甲纪律")
    expect(body).not.toContain("甲改纪律")
    expect(body).not.toContain("后续人工补充")
  })

  it("回滚退役 commit ⇒ readded 分支：活页还原 + _retired 位摘除 + INDEX/DB/FTS 重回账", async () => {
    compileCommit("concepts/con-deep-a.md", "con-deep-a", "深靶概念A", "甲")
    const c2 = retireCommit("concepts/con-deep-a.md", "con-deep-a")
    expect(fs.existsSync(path.join(wikiRoot, WIKI_RETIRED_DIR, "concepts", "con-deep-a.md"))).toBe(true)

    const svc = new RevertTaskService({ db, root: knowledgeRoot, git, now: FROZEN })
    const done = await settle(svc, svc.revert(c2).id)
    expect(done.status, JSON.stringify(done.error)).toBe("committed")

    // 活页还原、退役位摘除
    expect(fs.existsSync(path.join(wikiRoot, "concepts", "con-deep-a.md"))).toBe(true)
    expect(fs.existsSync(path.join(wikiRoot, WIKI_RETIRED_DIR, "concepts", "con-deep-a.md"))).toBe(false)
    // 触及清单双条：活页 readded · _retired 路径 removed（后者不进账，登记面由活页驱动）
    expect(done.result.touched.find((t) => t.path === "concepts/con-deep-a.md")?.action).toBe("readded")
    expect(done.result.touched.find((t) => t.path.startsWith(`${WIKI_RETIRED_DIR}/`))?.action).toBe("removed")
    // INDEX/DB/FTS 重回账
    expect(fs.readFileSync(path.join(wikiRoot, WIKI_INDEX_FILE), "utf-8")).toContain("con-deep-a")
    expect((db.prepare("SELECT COUNT(*) AS n FROM wiki_articles WHERE id = 'con-deep-a'").get() as { n: number }).n).toBe(1)
    expect(db.prepare("SELECT rowid FROM wiki_fts WHERE wiki_fts MATCH ?").all("深靶概念A")).toHaveLength(1)
  })

  it("页已退役后回滚更早的改页 ⇒ 强制对齐在册面：live 页写回 T^ 版 + _retired 镜像摘除（防双登记）；退役审计行保留", async () => {
    compileCommit("concepts/con-deep-a.md", "con-deep-a", "深靶概念A", "甲")
    const c2 = modifyCommit("concepts/con-deep-a.md", conceptPage("con-deep-a", "深靶概念A", "甲改"), "改纪律")
    retireCommit("concepts/con-deep-a.md", "con-deep-a")

    const svc = new RevertTaskService({ db, root: knowledgeRoot, git, now: FROZEN })
    const done = await settle(svc, svc.revert(c2).id)
    expect(done.status, JSON.stringify(done.error)).toBe("committed")

    // 强制对齐目标态：live 页 = c2^（甲版）；`_retired/` 镜像（甲改版）摘除防双登记
    expect(fs.readFileSync(path.join(wikiRoot, "concepts", "con-deep-a.md"), "utf-8")).toContain("甲纪律")
    expect(fs.existsSync(path.join(wikiRoot, WIKI_RETIRED_DIR, "concepts", "con-deep-a.md"))).toBe(false)
    // 审计真相面 = git 史 + LOG append-only：退役 commit 与退役 LOG 行都不被动用
    expect(fs.readFileSync(path.join(wikiRoot, WIKI_LOG_FILE), "utf-8")).toContain("## [2026-10-14] retire | concepts/con-deep-a.md")
    expect(git.run(["log", "--merges", "--oneline"]).stdout.trim()).toBe("")
  })
})
