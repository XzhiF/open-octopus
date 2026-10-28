import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { execFileSync, spawnSync } from "child_process"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../../../../db/schema"
import { WikiCompileService, type GitRunner } from "../compile"
import { ensureWikiSkeleton } from "../paths"

/**
 * S1 缝（spec §Testing Decisions）：wiki 编译环级测试 — knowledge-loop.test.ts 先例。
 * 真 fs tmpdir + in-memory DB + 真 git（spawnSync 先例 workspace-git.test.ts fixture 写法）。
 * 只断言外部产物：文件内容 / INDEX.md / LOG.md / git log / DB 行 / FTS 命中。
 * Expected 值逐字取自 prototype.md Tab③ 样例（禁止 Tautological Test）。
 */

const SAMPLE_ENTRY = `---
id: prj-octopus
domain: projects
title: Octopus 平台工程知识
summary: monorepo 构建/测试/端口规则与已知陷阱
topics: [build, test, ports, pitfall]
stability: stable
last_compiled: 2026-10-12
sources: [archive:task-207, chat:session-8f21, doc:windows-bash.md]
confidence: 0.86
---

## 构建规则
- 修改 shared/ 后必须 \`pnpm build -w shared\` 再全量构建 <!--#oct-001-->
- 构建命令: \`pnpm build\` <!--#oct-002-->

## 已知陷阱
- Promise.allSettled 聚合调用必须设全局超时 <!--#oct-007-->
- stale 检测一律用 updated_at（不是 started_at） <!--#oct-008-->

## 端口规则
- ⛔ 保护端口: 3000, 3001, 3098, 3099 <!--#oct-010-->
- Windows 拆机三段式: pnpm port → kill:port → netstat 复核 <!--#oct-012-->
`

/** Second fixture — used for cross-entry anchor collision (shares oct-007). */
const CLashingEntry = `---
id: wf-bug-hunter
domain: workflows
title: bug-hunter 工作流经验
summary: scan 节点 Grep 优先策略
topics: [scan]
stability: stable
last_compiled: 2026-10-12
sources: [archive:task-999]
confidence: 0.7
---

## 扫描规则
- Promise.allSettled 聚合调用必须设全局超时 <!--#oct-007-->
`

const realGit = (cwd: string): GitRunner => ({
  run(args: string[]) {
    // 票06 起 wiki 仓带 pre-commit 写闸：服务通道同款提交来源标记
    const r = spawnSync("git", args, { cwd, timeout: 30000, env: { ...process.env, OCTOPUS_WIKI_COMMIT_SOURCE: "curate" } })
    return { status: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
  },
})

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

describe("wiki compile service (ticket 01 tracer-bullet)", async () => {
  let db: Database.Database
  let tmpDir: string
  let root: string

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-compile-"))
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

  it("skeleton has v3 五类页目录 + _retired/，不再建 v2 四域目录（票08 · 故事29）", async () => {
    for (const d of ["entities", "concepts", "topics", "sources", "cases", "_retired"]) {
      expect(fs.statSync(path.join(root, d)).isDirectory()).toBe(true)
    }
    // v2 存量域目录不再由骨架生成（历史遗留空目录清而不净的根因修复）
    for (const d of ["projects", "workflows", "business", "research"]) {
      expect(fs.existsSync(path.join(root, d))).toBe(false)
    }
  })

  it("compiles the sample entry: file + INDEX + LOG + git commit + DB row + FTS hit", async () => {
    const svc = makeService()
    const res = await svc.compileEntry({
      content: SAMPLE_ENTRY,
      source: "task-207 归档提炼",
      reviewer: "xzf",
      note: "+oct-001…oct-012 初始编译",
    })

    expect(res.id).toBe("prj-octopus")
    expect(res.path).toBe("projects/prj-octopus.md")
    expect(res.anchors).toEqual(["oct-001", "oct-002", "oct-007", "oct-008", "oct-010", "oct-012"])
    expect(res.warnings).toEqual([])
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/)

    // ── 词条文件落盘（front-matter 与锚点原样保留）
    const entryFile = path.join(root, "projects", "prj-octopus.md")
    const written = fs.readFileSync(entryFile, "utf-8")
    expect(written).toContain("id: prj-octopus")
    expect(written).toContain("<!--#oct-007-->")

    // ── INDEX.md — 票04 v3 分组形状（expected 逐字 prototype Tab② INDEX 样例行式）
    const index = fs.readFileSync(path.join(root, "INDEX.md"), "utf-8")
    expect(index).toContain("# Octopus Knowledge Wiki")
    expect(index).toContain("> 导航协议：先读本索引 → 选页整读 → 未命中再 search API。禁止全库遍历。")
    expect(index).toContain("## 必读")
    // D-kc15-2 路径形制（票07 教训承接）：必读行输出 agent Read 可达路径——
    // `../SCHEMA.md` 相对 INDEX 所在 wiki 根（裸写会被解析成 wiki/ 下文件 → File not found）
    expect(index).toContain("- ../SCHEMA.md — 人机共演约定（人工维护；住在知识根 = wiki 根上一级，wiki 子树内无此文件）")
    expect(index).not.toContain("\n- ../user")
    // v2 词条（projects 域）按映射进 Topics 组；行式 `- {relPath} — {summary} · 硬约束 ×N`
    expect(index).toContain("## Topics (1)")
    expect(index).toContain("- projects/prj-octopus.md — monorepo 构建/测试/端口规则与已知陷阱 · 硬约束 ×6")
    // 审批遗产字样已随概念废除（待审核计数行删除）
    expect(index).not.toContain("待审核")

    // ── LOG.md — 票04 v3 行格式（`## [date] op | title` + `→ 结果` 续行）
    const log = fs.readFileSync(path.join(root, "LOG.md"), "utf-8")
    expect(log).toContain("# LOG.md — 时间线（append-only · 编译器自动写")
    expect(log).toContain(`## [${today()}] compile | projects/prj-octopus.md`)
    expect(log).toContain("  → +oct-001…oct-012 初始编译 · task-207 归档提炼 · xzf ✓")

    // ── git: 独立仓库 + 编译 commit 可查（真 git，workspace-git.test.ts fixture 先例）
    expect(fs.existsSync(path.join(root, ".git"))).toBe(true)
    const gitLog = execFileSync("git", ["log", "--format=%s"], { cwd: root, encoding: "utf-8" })
    expect(gitLog).toContain("compile: projects/prj-octopus.md")
    const shown = execFileSync("git", ["show", "--name-only", "--format=", res.commit!], { cwd: root, encoding: "utf-8" })
    expect(shown).toContain("projects/prj-octopus.md")
    expect(shown).toContain("INDEX.md")
    expect(shown).toContain("LOG.md")

    // ── DB 行 + FTS 同步（外部产物，不是内部调用序列）
    const row = db.prepare("SELECT * FROM wiki_articles WHERE id='prj-octopus'").get() as Record<string, unknown>
    expect(row.domain).toBe("projects")
    expect(row.title).toBe("Octopus 平台工程知识")
    expect(JSON.parse(row.topics as string)).toEqual(["build", "test", "ports", "pitfall"])
    expect(row.confidence).toBe(0.86)
    const hits = db.prepare("SELECT id FROM wiki_fts WHERE wiki_fts MATCH 'Promise'").all() as { id: string }[]
    expect(hits.map(h => h.id)).toContain("prj-octopus")
  })

  it("rejects an entry violating the front-matter schema, leaving zero traces", async () => {
    const svc = makeService()
    const bad = SAMPLE_ENTRY.replace("summary: monorepo 构建/测试/端口规则与已知陷阱\n", "")
    await expect(svc.compileEntry({ content: bad })).rejects.toThrow(/INVALID_FRONTMATTER.*summary/s)

    // 不留半成品：无词条、无 INDEX/LOG、无 git 仓库、无 DB 行
    expect(fs.existsSync(path.join(root, "projects", "prj-octopus.md"))).toBe(false)
    expect(fs.existsSync(path.join(root, "INDEX.md"))).toBe(false)
    expect(fs.existsSync(path.join(root, "LOG.md"))).toBe(false)
    expect((db.prepare("SELECT COUNT(*) AS n FROM wiki_articles").get() as { n: number }).n).toBe(0)
  })

  it("rejects a duplicate rule anchor across entries — anchor 全库唯一", async () => {
    const svc = makeService()
    await svc.compileEntry({ content: SAMPLE_ENTRY })
    await expect(svc.compileEntry({ content: CLashingEntry })).rejects.toThrow(/ANCHOR_CONFLICT.*oct-007/s)
    expect(fs.existsSync(path.join(root, "workflows", "wf-bug-hunter.md"))).toBe(false)
    const index = fs.readFileSync(path.join(root, "INDEX.md"), "utf-8")
    expect(index).not.toContain("wf-bug-hunter")
  })

  it("rolls back atomically when the git commit fails — no half-written state", async () => {
    const svc = makeService()
    await svc.compileEntry({ content: SAMPLE_ENTRY })
    const indexBefore = fs.readFileSync(path.join(root, "INDEX.md"), "utf-8")
    const logBefore = fs.readFileSync(path.join(root, "LOG.md"), "utf-8")

    // 注入一个在 commit 上失败的最小 git runner（其余命令透传真 git）
    const inner = realGit(root)
    const failingGit: GitRunner = {
      run(args) {
        if (args[0] === "commit") throw new Error("git commit exploded")
        return inner.run(args)
      },
    }
    const svc2 = new WikiCompileService({ db, org: "testorg", rootDir: root, git: failingGit })
    const second = SAMPLE_ENTRY.replace("id: prj-octopus", "id: prj-octopus-b")
      .replace("<!--#oct-001-->", "<!--#oct-101-->").replace("<!--#oct-002-->", "<!--#oct-102-->")
      .replace("<!--#oct-007-->", "<!--#oct-107-->").replace("<!--#oct-008-->", "<!--#oct-108-->")
      .replace("<!--#oct-010-->", "<!--#oct-110-->").replace("<!--#oct-012-->", "<!--#oct-112-->")
    await expect(svc2.compileEntry({ content: second, note: "应当被回滚" })).rejects.toThrow(/commit/)

    // 词条文件未留下、INDEX/LOG 逐字节回到第一编译后的状态、DB 只有第一行
    expect(fs.existsSync(path.join(root, "projects", "prj-octopus-b.md"))).toBe(false)
    expect(fs.readFileSync(path.join(root, "INDEX.md"), "utf-8")).toBe(indexBefore)
    expect(fs.readFileSync(path.join(root, "LOG.md"), "utf-8")).toBe(logBefore)
    expect((db.prepare("SELECT COUNT(*) AS n FROM wiki_articles").get() as { n: number }).n).toBe(1)
    expect((db.prepare("SELECT COUNT(*) AS n FROM wiki_fts").get() as { n: number }).n).toBe(1)
  })

  it("blocks (L5 gate) when the body contains dates — 票02 将 warn 预检升级为闸", async () => {
    const svc = makeService()
    const dated = SAMPLE_ENTRY.replace(
      "## 端口规则",
      "## 带日期小节\n- 2026-06-23 那次 CI 挂了 <!--#oct-020-->\n\n## 端口规则",
    )
    await expect(svc.compileEntry({ content: dated })).rejects.toThrow(/L5_DATES_IN_BODY.*2026-06-23/s)
    // 拒写零痕迹（beforeEach 全新 tmp 根，未过闸则不留任何文件）
    expect(fs.existsSync(path.join(root, "projects", "prj-octopus.md"))).toBe(false)
  })

  it("recompiling the same entry upserts: one DB row, INDEX lists it once, git history grows", async () => {
    const svc = makeService()
    await svc.compileEntry({ content: SAMPLE_ENTRY })
    const updated = SAMPLE_ENTRY.replace("summary: monorepo 构建/测试/端口规则与已知陷阱", "summary: 构建/测试/端口/CI 规则与已知陷阱")
    const res2 = await svc.compileEntry({ content: updated, note: "修订 summary" })

    expect((db.prepare("SELECT COUNT(*) AS n FROM wiki_articles ").get() as { n: number }).n).toBe(1)
    const row = db.prepare("SELECT summary FROM wiki_articles WHERE id='prj-octopus'").get() as { summary: string }
    expect(row.summary).toBe("构建/测试/端口/CI 规则与已知陷阱")
    const index = fs.readFileSync(path.join(root, "INDEX.md"), "utf-8")
    expect(index.match(/projects\/prj-octopus\.md/g)!.length).toBe(1)
    expect(index).toContain("- projects/prj-octopus.md — 构建/测试/端口/CI 规则与已知陷阱 · 硬约束 ×6")
    const hits = db.prepare("SELECT id FROM wiki_fts WHERE wiki_fts MATCH 'CI'").all() as { id: string }[]
    expect(hits.map(h => h.id)).toContain("prj-octopus")
    // LOG 不重复头、追加第二行
    const log = fs.readFileSync(path.join(root, "LOG.md"), "utf-8")
    expect(log.match(/# LOG\.md/g)!.length).toBe(1)
    expect(log).toContain("  → 修订 summary · manual · curator ✓")
    expect(res2.commit).toMatch(/^[0-9a-f]{40}$/)
  })
})
