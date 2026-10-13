import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { spawnSync } from "child_process"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../../../../db/schema"
import { WikiArticleDAO } from "../../../../db/dao/wiki-article-dao"
import { WikiCompileService, type GitRunner } from "../compile"
import { ensureWikiSkeleton } from "../paths"

/**
 * 票05 · 多页编译基座（写入闸门批通道）S1 — compilePages。
 * 真 fs tmpdir + in-memory DB + 真 git（wiki-compile.test.ts / wiki-page-v3.test.ts 同款 harness）。
 * 契约（票面 AC1 + spec §审批废除与写入闸门）：一次编译写 N 页 + INDEX 重建 + LOG 一行
 * + FTS 同步 + **单一 git commit**；中途失败 ⇒ 全部回滚零半成品。
 * Expected 形态取自 prototype Tab③ 编译 DIFF 卡（触及 N 页 · 一个 commit · FTS/DB 同步 ✓）。
 */

function stubPage(id: string, type: string, title: string, summary: string): string {
  return `---
id: ${id}
type: ${type}
title: ${title}
summary: ${summary}
links: []
sources: [raw/inbox/2026-10-13-fixture-raw.md]
last_compiled: 2026-10-13
---

## 桩
- 票05 批通道桩页，无规则锚点。
`
}

const realGit = (cwd: string): GitRunner => ({
  run(args: string[]) {
    const r = spawnSync("git", args, { cwd, timeout: 30000, env: { ...process.env, OCTOPUS_WIKI_COMMIT_SOURCE: "curate" } })
    return { status: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
  },
})

describe("compilePages — 一次编译多页单 commit（票05 基座）", () => {
  let db: Database.Database
  let tmpDir: string
  let root: string

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-batch-"))
    root = path.join(tmpDir, "wiki")
    ensureWikiSkeleton(root)
  })

  afterEach(() => {
    db?.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function makeService(git?: GitRunner) {
    return new WikiCompileService({ db, org: "testorg", rootDir: root, git: git ?? realGit(root) })
  }

  it("writes N pages + INDEX + LOG + FTS in a SINGLE git commit", async () => {
    const svc = makeService()
    const res = await svc.compilePages(
      [
        { content: stubPage("ent-hermes", "entity", "hermes 通知服务", "消息推送通道服务") },
        { content: stubPage("con-compiled-rag", "concept", "编译型 RAG", "检索重活挪到维护期，答案从编译产物合成") },
        { content: stubPage("top-windows-bash-ops", "topic", "Windows 拆机操作", "拆机三段式与保护端口纪律") },
      ],
      { entry: "fixture raw", note: "触 3 页 · 新页 3", source: "raw/inbox/2026-10-13-fixture-raw.md" },
    )

    // 单 commit：整个仓历史恰好 1 个 commit
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(res.changed).toBe(true)
    const count = realGit(root).run(["rev-list", "--count", "HEAD"]).stdout.trim()
    expect(count).toBe("1")

    // N 页落盘（按 type 进五类目录）
    expect(fs.existsSync(path.join(root, "entities", "ent-hermes.md"))).toBe(true)
    expect(fs.existsSync(path.join(root, "concepts", "con-compiled-rag.md"))).toBe(true)
    expect(fs.existsSync(path.join(root, "topics", "top-windows-bash-ops.md"))).toBe(true)

    // 触及明细（顺序回显 + created 标记，供 DIFF 卡消费）
    expect(res.pages.map(p => p.path)).toEqual([
      "entities/ent-hermes.md",
      "concepts/con-compiled-rag.md",
      "topics/top-windows-bash-ops.md",
    ])
    expect(res.pages.every(p => p.created)).toBe(true)

    // 单一 commit 同时含三页 + INDEX.md + LOG.md（git show --name-only 断言）
    const show = realGit(root).run(["show", "--name-only", "--format=", "HEAD"]).stdout
    for (const f of [
      "entities/ent-hermes.md",
      "concepts/con-compiled-rag.md",
      "topics/top-windows-bash-ops.md",
      "INDEX.md",
      "LOG.md",
    ]) {
      expect(show.split(/\r?\n/)).toContain(f)
    }

    // INDEX 程序化重建：三页各列一行
    const index = fs.readFileSync(path.join(root, "INDEX.md"), "utf-8")
    expect(index).toContain("- entities/ent-hermes.md — 消息推送通道服务")
    expect(index).toContain("- concepts/con-compiled-rag.md — 检索重活挪到维护期，答案从编译产物合成")
    expect(index).toContain("- topics/top-windows-bash-ops.md — 拆机三段式与保护端口纪律")

    // LOG 仅新增一行（批 = 一行，不是 N 行）
    const log = fs.readFileSync(path.join(root, "LOG.md"), "utf-8")
    expect((log.match(/^## \[/gm) ?? []).length).toBe(1)
    expect(log).toContain("## [")
    expect(log).toContain("触 3 页 · 新页 3")

    // DB/FTS 同步（domain 列存 v3 type 值，票04 AC6 口径）
    const dao = new WikiArticleDAO(db)
    expect(dao.get("testorg", "ent-hermes")?.domain).toBe("entity")
    expect(dao.get("testorg", "con-compiled-rag")?.domain).toBe("concept")
    expect(dao.get("testorg", "top-windows-bash-ops")?.domain).toBe("topic")
    expect(dao.search("testorg", "LOCKFILE_CONFIG_MISMATCH")).toHaveLength(0)
    // FTS5 unicode61 不分 CJK（DAO 注释 gotcha）——FTS 同步证据用 ASCII token
    expect(dao.search("testorg", "hermes").length).toBeGreaterThan(0)
    expect(dao.searchLike("testorg", "推送通道").length).toBeGreaterThan(0)
  })

  it("rejects the whole batch (zero artifacts) when any page fails validation", async () => {
    const svc = makeService()
    // 第二页断链（[[no-such-page]] 不存在）⇒ 整批拒写，第一页也不许留盘
    const err = await svc
      .compilePages(
        [
          { content: stubPage("ent-hermes", "entity", "hermes 通知服务", "消息推送通道服务") },
          (() => {
            const broken = stubPage("con-broken", "concept", "断链页", "链接指向不存在页").replace(
              "## 桩",
              "## 引用\n- 指向不存在页 → [[no-such-page]]\n\n## 桩",
            )
            return { content: broken }
          })(),
        ],
        { entry: "fixture raw", note: "触 2 页", source: "raw/inbox/2026-10-13-fixture-raw.md" },
      )
      .catch(e => e)
    expect(String(err.message)).toMatch(/L5_LINK_BROKEN/)
    expect(fs.existsSync(path.join(root, "entities", "ent-hermes.md"))).toBe(false)
    expect(fs.existsSync(path.join(root, "concepts", "con-broken.md"))).toBe(false)
    expect(fs.existsSync(path.join(root, "INDEX.md"))).toBe(false)
    expect(fs.existsSync(path.join(root, "LOG.md"))).toBe(false)
    const dao = new WikiArticleDAO(db)
    expect(dao.get("testorg", "ent-hermes")).toBeUndefined()
  })

  it("rolls back everything (files/INDEX/LOG/DB) when git commit fails mid-write", async () => {
    // 预置一版可提交状态：单页通道先行（真实前态），再让批通道的 commit 失败
    const svc0 = makeService()
    await svc0.compilePages(
      [{ content: stubPage("ent-hermes", "entity", "hermes 通知服务", "消息推送通道服务") }],
      { entry: "seed", note: "触 1 页 · 新页 1", source: "seed" },
    )
    const beforeHead = realGit(root).run(["rev-parse", "HEAD"]).stdout.trim()
    const beforeIndex = fs.readFileSync(path.join(root, "INDEX.md"), "utf-8")
    const beforeLog = fs.readFileSync(path.join(root, "LOG.md"), "utf-8")

    const failingGit: GitRunner = {
      run(args) {
        if (args[0] === "commit") return { status: 1, stdout: "", stderr: "simulated commit failure" }
        return realGit(root).run(args)
      },
    }
    const svc = makeService(failingGit)
    const err = await svc
      .compilePages(
        [{ content: stubPage("ent-new", "entity", "新实体", "批内新页，commit 失败应整体回滚") }],
        { entry: "fixture raw", note: "触 1 页", source: "raw/inbox/2026-10-13-fixture-raw.md" },
      )
      .catch(e => e)
    expect(String(err.message)).toMatch(/GIT_FAILED/)

    // 零半成品：页文件消失，INDEX/LOG 回到前态，HEAD 不动
    expect(fs.existsSync(path.join(root, "entities", "ent-new.md"))).toBe(false)
    expect(fs.readFileSync(path.join(root, "INDEX.md"), "utf-8")).toBe(beforeIndex)
    expect(fs.readFileSync(path.join(root, "LOG.md"), "utf-8")).toBe(beforeLog)
    expect(realGit(root).run(["rev-parse", "HEAD"]).stdout.trim()).toBe(beforeHead)
    // 工作树干净（git 索引的 add -A 被 reset 补偿掉）
    expect(realGit(root).run(["status", "--porcelain"]).stdout.trim()).toBe("")
    const dao = new WikiArticleDAO(db)
    expect(dao.get("testorg", "ent-new")).toBeUndefined()
  })
})
