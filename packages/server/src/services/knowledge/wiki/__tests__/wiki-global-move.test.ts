import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { spawnSync } from "child_process"
import { applySchema } from "../../../../db/schema"
import { WikiGlobalMigrator, type GlobalMoveReport } from "../global-move"
import { WikiArticleDAO } from "../../../../db/dao/wiki-article-dao"
import { spawnGit, type GitRunner } from "../wiki-git"
import { ensureWikiSkeleton, resolveWikiRootCompat, hasWikiContent } from "../paths"
import { createWikiRoutes } from "../../../../routes/wiki"

/**
 * S1 缝（票03 wiki 全局化搬家）— wiki-migrate.test.ts 同先例：真 fs tmpdir + in-memory DB + 真 git。
 * fixture 全部合成（假 org 树：xzf-dev 带 .git 的存量 wiki + testorg 空骨架），绝不碰真实 ~/.octopus。
 * 只断言外部产物：全局根文件树 / git commit hash 集合 / DB 行 / 归档与人工文件 / 报告形状。
 * Expected 值来自独立真相源：fixture 手搓 + spec D6①④ + prototype Tab⑥ 步骤 1。
 */

const realGit = (cwd: string): GitRunner => spawnGit(cwd)

/** 存量词条（v2 形态，够 scan 出 md 文件即可，本票不重编）。 */
const ENTRY_A = `---
id: prj-alpha
domain: projects
title: Alpha 项目知识
summary: 存量词条 A
topics: [alpha]
stability: stable
last_compiled: 2026-10-01
sources: [doc:knowledge/projects/alpha.md]
confidence: 0.8
---

## 构建规则

- 修改 shared/ 后必须先 pnpm build <!--#oct-001-->
`

const ENTRY_B = `---
id: wf-beta
domain: workflows
title: Beta 工作流知识
summary: 存量词条 B
topics: [beta]
stability: stable
last_compiled: 2026-10-02
sources: [doc:knowledge/workflows/beta.md]
confidence: 0.8
---

## 执行规则

- 端口冲突先清旧进程 <!--#oct-002-->
`

interface Fixture {
  tmpDir: string
  octopusHome: string        // = 假 HOME/.octopus
  orgsBase: string           // octopusHome/orgs
  knowledgeRoot: string      // octopusHome/knowledge（全局知识根）
  xzfWiki: string            // orgsBase/xzf-dev/knowledge/wiki（存量，含 .git）
  testorgWiki: string        // orgsBase/testorg/knowledge/wiki（空骨架）
}

/** 造 xzf-dev 存量 wiki：2 词条 + INDEX/LOG + 真 git 两 commit（首 commit = 初始编译，史断言锚）。 */
function seedOrgWiki(root: string): void {
  ensureWikiSkeleton(root)
  fs.mkdirSync(path.join(root, "projects"), { recursive: true })
  fs.mkdirSync(path.join(root, "workflows"), { recursive: true })
  fs.writeFileSync(path.join(root, "projects", "prj-alpha.md"), ENTRY_A, "utf-8")
  fs.writeFileSync(path.join(root, "INDEX.md"), `# Octopus Knowledge Wiki — xzf-dev\n\n## projects/\n\n- projects/prj-alpha.md — 存量词条 A\n`, "utf-8")
  fs.writeFileSync(path.join(root, "LOG.md"), `# Curation Log\n\n| 日期 | 动作 | 词条 | 摘要 | 来源 | 审核 |\n|------|------|------|------|------|------|\n| 2026-10-01 | compile | projects/prj-alpha.md | +1 条规则 | manual | curator ✓ |\n`, "utf-8")
  const git = realGit(root)
  git.run(["init"])
  git.run(["config", "user.name", "octopus-curator"])
  git.run(["config", "user.email", "wiki@octopus.local"])
  git.run(["add", "-A"])
  git.run(["commit", "-m", "compile: projects/prj-alpha.md — 初始编译 +1 条规则"])
  fs.writeFileSync(path.join(root, "workflows", "wf-beta.md"), ENTRY_B, "utf-8")
  git.run(["add", "-A"])
  git.run(["commit", "-m", "compile: workflows/wf-beta.md — +1 条规则"])
}

function commitHashes(root: string): string[] {
  const r = spawnSync("git", ["rev-list", "--all"], { cwd: root, timeout: 30000 })
  if (r.status !== 0) return []
  return r.stdout.toString().trim().split(/\r?\n/).filter(Boolean).sort()
}

function makeFixture(): Fixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-global-move-"))
  const octopusHome = path.join(tmpDir, ".octopus")
  const orgsBase = path.join(octopusHome, "orgs")
  const knowledgeRoot = path.join(octopusHome, "knowledge")
  const xzfWiki = path.join(orgsBase, "xzf-dev", "knowledge", "wiki")
  const testorgWiki = path.join(orgsBase, "testorg", "knowledge", "wiki")
  seedOrgWiki(xzfWiki)
  ensureWikiSkeleton(testorgWiki) // 空骨架：无词条、无 git — 真实形态
  // 各 org 的人工偏好原件
  fs.writeFileSync(path.join(orgsBase, "xzf-dev", "knowledge", "user_preference.md"), "PREF-XZF-ORIGINAL\n", "utf-8")
  fs.writeFileSync(path.join(orgsBase, "testorg", "knowledge", "user_preference.md"), "PREF-TESTORG-ORIGINAL\n", "utf-8")
  return { tmpDir, octopusHome, orgsBase, knowledgeRoot, xzfWiki, testorgWiki }
}

describe("wiki global move migrator (ticket 03)", () => {
  let db: Database.Database
  let fx: Fixture

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    fx = makeFixture()
  })

  afterEach(() => {
    db?.close()
    fs.rmSync(fx.tmpDir, { recursive: true, force: true })
  })

  function makeMigrator(apply: boolean, over: Partial<ConstructorParameters<typeof WikiGlobalMigrator>[0]> = {}) {
    return new WikiGlobalMigrator({
      db,
      orgsBaseDir: fx.orgsBase,
      knowledgeRoot: fx.knowledgeRoot,
      apply,
      ...over,
    })
  }

  it("dry-run（默认）：列出将迁移的 xzf-dev wiki（含 commit 数）与空 org 跳过，零写盘零改库", async () => {
    const report: GlobalMoveReport = await makeMigrator(false).run()

    // ── 计划主体：xzf-dev 有搬家动作，commits 来自真 git（独立真相 = 我们手搓的两 commit）
    const xzf = report.wikiMoves.find(m => m.org === "xzf-dev")
    expect(xzf).toBeDefined()
    expect(xzf!.action).toBe("move")
    expect(xzf!.commits).toBe(2)
    expect(xzf!.to).toBe(path.join(fx.knowledgeRoot, "wiki"))

    // ── 空 wiki：无迁移动作、不报错
    const testorg = report.wikiMoves.find(m => m.org === "testorg")
    expect(testorg!.action).toBe("skip-empty")

    // ── 偏好计划：两 org 都列归档 + xzf-dev 成为知识根现行版
    expect(report.preferences.map(p => p.org).sort()).toEqual(["testorg", "xzf-dev"])
    const prefXzf = report.preferences.find(p => p.org === "xzf-dev")!
    expect(prefXzf.archiveAction).toBe("copy")
    expect(prefXzf.rootAction).toBe("copy-to-root")
    const prefTestorg = report.preferences.find(p => p.org === "testorg")!
    expect(prefTestorg.rootAction).toBe("none") // 非现行版候选，只归档

    // ── re-key 计划投影：钉 global 前后行数对账口径
    expect(report.rekey.beforeTotal).toBe(0)
    expect(report.rekey.projectedTotal).toBe(0)
    expect(report.rekey.applied).toBe(false)

    // ── 备份纪律提示（真跑前置，主控执行）
    expect(report.backupHint).toContain("VACUUM INTO")

    // ── 零写盘：旧树还在、全局根未建、偏好未归档、原件未动
    expect(fs.existsSync(fx.xzfWiki)).toBe(true)
    expect(fs.existsSync(path.join(fx.knowledgeRoot, "wiki"))).toBe(false)
    expect(fs.existsSync(path.join(fx.knowledgeRoot, "user_preference.md"))).toBe(false)
    expect(fs.existsSync(path.join(fx.knowledgeRoot, "_archive"))).toBe(false)
    expect(fs.readFileSync(path.join(fx.orgsBase, "xzf-dev", "knowledge", "user_preference.md"), "utf-8")).toBe("PREF-XZF-ORIGINAL\n")
  })

  it("apply：xzf-dev wiki 连 .git 整体搬入全局根——git 史 hash 集合相同（初始编译 commit 仍在）、源目录删除、重跑零 diff", async () => {
    const hashesBefore = commitHashes(fx.xzfWiki)
    expect(hashesBefore).toHaveLength(2) // fixture 独立真相：我们手搓了两个 commit

    const globalWiki = path.join(fx.knowledgeRoot, "wiki")
    const run1 = await makeMigrator(true).run()
    expect(run1.dryRun).toBe(false)
    expect(run1.wikiMoves.find(m => m.org === "xzf-dev")!.action).toBe("move")

    // ── 目的全量在场（词条逐字节 = 源 fixture 内容）
    expect(fs.existsSync(path.join(globalWiki, ".git"))).toBe(true)
    expect(fs.readFileSync(path.join(globalWiki, "projects", "prj-alpha.md"), "utf-8")).toBe(ENTRY_A)
    expect(fs.readFileSync(path.join(globalWiki, "workflows", "wf-beta.md"), "utf-8")).toBe(ENTRY_B)
    expect(fs.readFileSync(path.join(globalWiki, "INDEX.md"), "utf-8")).toContain("存量词条 A")

    // ── 史不断：迁后 hash 集合与迁前相同；初始编译 commit 主题仍在
    expect(commitHashes(globalWiki)).toEqual(hashesBefore)
    const subjects = spawnSync("git", ["log", "--format=%s"], { cwd: globalWiki, timeout: 30000 }).stdout.toString()
    expect(subjects).toContain("compile: projects/prj-alpha.md — 初始编译 +1 条规则")
    expect(subjects).toContain("compile: workflows/wf-beta.md — +1 条规则")

    // ── 搬（非复制）：旧源目录删；空骨架 testorg 原样不动
    expect(fs.existsSync(fx.xzfWiki)).toBe(false)
    expect(fs.existsSync(fx.testorgWiki)).toBe(true)

    // ── 幂等重跑：工作树零 diff、commit 数不变、INDEX 逐字节不变、动作全 skip
    const gitStatus = () => spawnSync("git", ["status", "--porcelain"], { cwd: globalWiki, timeout: 30000 }).stdout.toString().trim()
    const commitCount = () => spawnSync("git", ["rev-list", "--count", "HEAD"], { cwd: globalWiki, timeout: 30000 }).stdout.toString().trim()
    expect(gitStatus()).toBe("")
    const commitsBefore = commitCount()
    const indexBefore = fs.readFileSync(path.join(globalWiki, "INDEX.md"), "utf-8")

    const run2 = await makeMigrator(true).run()
    expect(run2.wikiMoves.find(m => m.org === "xzf-dev")!.action).toBe("skip-empty") // 旧根已空 ⇒ 无迁移动作、不报错
    expect(gitStatus()).toBe("") // ⇒ 重跑 diff 空
    expect(commitCount()).toBe(commitsBefore)
    expect(fs.readFileSync(path.join(globalWiki, "INDEX.md"), "utf-8")).toBe(indexBefore)
  })

  it("re-key：wiki_articles 全部钉 'global' + FTS 重建可检索，前后行数对账守恒，重跑跳过重建", async () => {
    // 索引层种子：DAO 直插 3 行（xzf-dev 两行 + testorg 一行）——wiki_fts 故意留空，
    // re-key 后检索命中 ⇒ 只能来自 FTS 重建灌数（反 tautological：命中不从旧索引"侥幸"）
    const dao = new WikiArticleDAO(db)
    for (const [org, id, domain, title, body, p] of [
      ["xzf-dev", "prj-alpha", "projects", "Alpha 项目", "- 修改 shared/ 后必须 pnpm build <!--#oct-001-->\n", "projects/prj-alpha.md"],
      ["xzf-dev", "wf-beta", "workflows", "Beta 工作流", "- 端口冲突先清旧进程 <!--#oct-002-->\n", "workflows/wf-beta.md"],
      ["testorg", "biz-glossary", "business", "术语口径", "- 术语定义行 <!--#oct-003-->\n", "business/biz-glossary.md"],
    ] as const) {
      dao.upsert({
        org, id, domain, title, summary: title, topics: JSON.stringify(["t"]), stability: "stable",
        last_compiled: "2026-10-01", sources: JSON.stringify([]), confidence: 0.8, body, path: p,
      })
    }

    const run = await makeMigrator(true).run()
    expect(run.rekey.beforeTotal).toBe(3)
    expect(run.rekey.beforeByOrg).toEqual({ "testorg": 1, "xzf-dev": 2 })
    expect(run.rekey.applied).toBe(true)
    expect(run.rekey.afterTotal).toBe(3) // 行数守恒：不丢行
    expect(run.rekey.afterByOrg).toEqual({ global: 3 })
    expect((db.prepare("SELECT COUNT(*) AS n FROM wiki_articles WHERE org != 'global'").get() as { n: number }).n).toBe(0)

    // FTS 重建后按 'global' 可检索（重建灌数证明；查询词用 ASCII——unicode61 下连续 CJK 是单 token，
    // CJK 子串检索走 searchLike，路由层已有降级，本断言只验 rowid 对齐与灌数）
    expect(dao.search("global", "pnpm").map(r => r.id)).toContain("prj-alpha")
    expect(dao.listByOrg("global")).toHaveLength(3)

    // 重跑：已全钉 global ⇒ 幂等跳过重建，行数与内容不变
    const bodiesBefore = db.prepare("SELECT id, body FROM wiki_articles ORDER BY id").all()
    const run2 = await makeMigrator(true).run()
    expect(run2.rekey.applied).toBe(false)
    expect(run2.rekey.afterTotal).toBe(3)
    expect(db.prepare("SELECT id, body FROM wiki_articles ORDER BY id").all()).toEqual(bodiesBefore)
  })

  it("re-key 冲突：跨 org 同 id 合并为 updated_at 最新行，对账报告合并数，钉后仍可检索新行", async () => {
    const dao = new WikiArticleDAO(db)
    for (const [org, body] of [["xzf-dev", "- 旧版本断言 <!--#oct-010-->\n"], ["testorg", "- 新版本断言 <!--#oct-011-->\n"]] as const) {
      dao.upsert({
        org, id: "dup-entry", domain: "projects", title: "Dup", summary: "Dup", topics: "[]", stability: "stable",
        last_compiled: "2026-10-01", sources: "[]", confidence: 0.8, body, path: "projects/dup-entry.md",
      })
    }
    // 显式钉 updated_at 定新旧（upsert 默认同秒会平局）
    db.prepare("UPDATE wiki_articles SET updated_at='2026-10-01 00:00:00' WHERE org='xzf-dev'").run()
    db.prepare("UPDATE wiki_articles SET updated_at='2026-10-05 00:00:00' WHERE org='testorg'").run()

    const run = await makeMigrator(true).run()
    expect(run.rekey.beforeTotal).toBe(2)
    expect(run.rekey.projectedTotal).toBe(1)
    expect(run.rekey.collisions).toBe(1)
    expect(run.rekey.afterTotal).toBe(1)
    const row = dao.get("global", "dup-entry")
    expect(row?.body).toContain("新版本断言") // updated_at 最新者胜
    // CJK 子串检索走 LIKE 降级（unicode61 不分中文词，路由 search 同款语义）；FTS 灌数由上一条用例证明
    expect(dao.searchLike("global", "新版本").map(r => r.id)).toEqual(["dup-entry"])
    expect(dao.search("global", "zzzmissingterm").length).toBe(0) // 新 FTS 表在场且可查（非遗留旧索引）
  })

  it("user_preference：原件复制 _archive/ 归档区（不删原件），现行版拷知识根；重跑零写；人工文件区已有不同版永不改写", async () => {
    const archiveXzf = path.join(fx.knowledgeRoot, "_archive", "user_preference", "xzf-dev.md")
    const archiveTestorg = path.join(fx.knowledgeRoot, "_archive", "user_preference", "testorg.md")
    const rootPref = path.join(fx.knowledgeRoot, "user_preference.md")

    const run1 = await makeMigrator(true).run()
    expect(run1.preferences.map(p => p.org).sort()).toEqual(["testorg", "xzf-dev"])
    // 归档先于一切：两 org 原件逐字节进归档区
    expect(fs.readFileSync(archiveXzf, "utf-8")).toBe("PREF-XZF-ORIGINAL\n")
    expect(fs.readFileSync(archiveTestorg, "utf-8")).toBe("PREF-TESTORG-ORIGINAL\n")
    // 现行版（preferenceSourceOrg=xzf-dev）拷知识根人工文件区
    expect(fs.readFileSync(rootPref, "utf-8")).toBe("PREF-XZF-ORIGINAL\n")
    // 红线：本票不删原件
    expect(fs.existsSync(path.join(fx.orgsBase, "xzf-dev", "knowledge", "user_preference.md"))).toBe(true)
    expect(fs.existsSync(path.join(fx.orgsBase, "testorg", "knowledge", "user_preference.md"))).toBe(true)

    // 重跑：归档同内容 skip-identical、现行版同内容 skip-identical-root，零写
    const mtimeBefore = fs.statSync(rootPref).mtimeMs
    const run2 = await makeMigrator(true).run()
    expect(run2.preferences.every(p => p.archiveAction === "skip-identical")).toBe(true)
    expect(run2.preferences.find(p => p.org === "xzf-dev")!.rootAction).toBe("skip-identical-root")
    expect(fs.statSync(rootPref).mtimeMs).toBe(mtimeBefore)

    // 人工文件保护：owner 手改知识根后重跑 → keep-existing-root，程序永不改写
    fs.writeFileSync(rootPref, "HUMAN-EDITED\n", "utf-8")
    const run3 = await makeMigrator(true).run()
    expect(run3.preferences.find(p => p.org === "xzf-dev")!.rootAction).toBe("keep-existing-root")
    expect(fs.readFileSync(rootPref, "utf-8")).toBe("HUMAN-EDITED\n")
  })

  it("全局根已有内容而旧 org wiki 也有内容（异常态）：skip-conflict，两边都不覆盖不删除", async () => {
    fs.mkdirSync(path.join(fx.knowledgeRoot, "wiki"), { recursive: true })
    fs.writeFileSync(path.join(fx.knowledgeRoot, "wiki", "INDEX.md"), "# 已有全局库\n", "utf-8")

    const run = await makeMigrator(true).run()
    const xzf = run.wikiMoves.find(m => m.org === "xzf-dev")!
    expect(xzf.action).toBe("skip-conflict")
    expect(xzf.reason).toContain("不覆盖不合并")
    // 两边原样：全局根未被 xzf-dev 内容污染，旧根仍在（主控裁决）
    expect(fs.readFileSync(path.join(fx.knowledgeRoot, "wiki", "INDEX.md"), "utf-8")).toBe("# 已有全局库\n")
    expect(fs.existsSync(path.join(fx.xzfWiki, "projects", "prj-alpha.md"))).toBe(true)
  })

  it("兼容读窗口：apply 前 tree 的 fs 面兼容读旧 org 路径、DB 面空（未 re-key）；apply 后切全局根且行全可见；旧路径此后不再读", async () => {
    // 旧 LOG 打窗口标记（搬家后随仓走——切径证明靠"旧路径复活注入另一标记"）
    fs.writeFileSync(path.join(fx.xzfWiki, "LOG.md"), `# Curation Log\n\n| 日期 | 动作 | 词条 | 摘要 | 来源 | 审核 |\n|------|------|------|------|------|------|\n| 2026-10-01 | compile | projects/prj-alpha.md | ORG-WINDOW-LOG | manual | curator ✓ |\n`, "utf-8")
    // DB 面：re-key 前的真实形态——行还挂 org 'xzf-dev'
    const dao = new WikiArticleDAO(db)
    dao.upsert({
      org: "xzf-dev", id: "prj-alpha", domain: "projects", title: "Alpha 项目知识", summary: "存量词条 A",
      topics: JSON.stringify(["alpha"]), stability: "stable", last_compiled: "2026-10-01",
      sources: JSON.stringify([]), confidence: 0.8, body: "- 修改 shared/ 后必须 pnpm build <!--#oct-001-->\n", path: "projects/prj-alpha.md",
    })
    const app = createWikiRoutes(dao, { octopusHome: fx.octopusHome })

    // ── 窗口期：fs 面兼容读旧 org 路径；DB 面钉 global 未 re-key ⇒ 诚实空树（不伪造，红线 2）
    const before = await (await app.request("/tree?org=xzf-dev")).json()
    expect(before.log).toContain("ORG-WINDOW-LOG")
    expect(before.domains).toEqual([])

    // ── apply：搬家 + re-key 一步完成 ⇒ DB 面全局行可见，fs 面=全局根（LOG 随仓搬走）
    await makeMigrator(true).run()
    const after = await (await app.request("/tree?org=xzf-dev")).json()
    expect(after.org).toBe("global")
    expect(after.log).toContain("ORG-WINDOW-LOG")
    expect(after.domains.flatMap((d: { entries: Array<{ id: string }> }) => d.entries).map((e: { id: string }) => e.id)).toEqual(["prj-alpha"])

    // search/article 返回全局库（org 参数容错）
    const search = await (await app.request("/search?q=pnpm&org=xzf-dev")).json()
    expect(search.org).toBe("global")
    expect(search.results.map((r: { id: string }) => r.id)).toContain("prj-alpha")
    const article = await (await app.request("/article/prj-alpha?org=anything")).json()
    expect(article.domain).toBe("projects")
    // git 近史来自全局根仓（史连续的证据面）
    expect(article.gitHistory.map((h: { message: string }) => h.message)).toContain("compile: projects/prj-alpha.md — 初始编译 +1 条规则")

    // ── 此后不再读：旧 org 路径"复活"注入别的标记，tree 仍返回全局根内容
    fs.mkdirSync(path.join(fx.xzfWiki, "projects"), { recursive: true })
    fs.writeFileSync(path.join(fx.xzfWiki, "LOG.md"), "# Curation Log\n| 2026-10-02 | compile | x | ZOMBIE-ORG-LOG | manual | curator ✓ |\n", "utf-8")
    const after2 = await (await app.request("/tree?org=xzf-dev")).json()
    expect(after2.log).toContain("ORG-WINDOW-LOG")
    expect(after2.log).not.toContain("ZOMBIE-ORG-LOG")
  })

  it("resolveWikiRootCompat 口径：全局根有内容指新根，未生成指旧 org 路径；骨架（无内容）不算全局根", () => {
    const home = fx.octopusHome
    // 迁移未跑：全局根不存在 ⇒ 旧 org 路径（窗口）
    expect(resolveWikiRootCompat("xzf-dev", undefined, home)).toBe(fx.xzfWiki)
    // testorg（空骨架）请求 ⇒ 也回骨架路径（只读降级，不报错）
    expect(resolveWikiRootCompat("testorg", undefined, home)).toBe(fx.testorgWiki)
    // 全局根落内容（骨架不算）⇒ 一切读切新根，org 参数失效
    expect(hasWikiContent(path.join(fx.knowledgeRoot, "wiki"))).toBe(false)
    fs.mkdirSync(path.join(fx.knowledgeRoot, "wiki"), { recursive: true })
    expect(resolveWikiRootCompat("xzf-dev", undefined, home)).toBe(fx.xzfWiki) // 空目录仍窗口
    ensureWikiSkeleton(path.join(fx.knowledgeRoot, "wiki"))
    expect(resolveWikiRootCompat("xzf-dev", undefined, home)).toBe(fx.xzfWiki) // 骨架仍窗口（骨架≠内容）
    fs.writeFileSync(path.join(fx.knowledgeRoot, "wiki", "INDEX.md"), "# x\n", "utf-8")
    expect(resolveWikiRootCompat("xzf-dev", undefined, home)).toBe(path.join(fx.knowledgeRoot, "wiki")) // 有内容=切新根
    expect(resolveWikiRootCompat(undefined, undefined, home)).toBe(path.join(fx.knowledgeRoot, "wiki"))
  })
})
