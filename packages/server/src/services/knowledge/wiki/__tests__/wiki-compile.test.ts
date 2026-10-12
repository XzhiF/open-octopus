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
    const r = spawnSync("git", args, { cwd, timeout: 30000 })
    return { status: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
  },
})

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

describe("wiki compile service (ticket 01 tracer-bullet)", () => {
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

  it("skeleton has the 4 domains + cases/ + _retired/", () => {
    for (const d of ["projects", "workflows", "business", "research", "cases", "_retired"]) {
      expect(fs.statSync(path.join(root, d)).isDirectory()).toBe(true)
    }
  })

  it("compiles the sample entry: file + INDEX + LOG + git commit + DB row + FTS hit", () => {
    const svc = makeService()
    const res = svc.compileEntry({
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

    // ── INDEX.md — expected shape QUOTED from prototype Tab③ lines 46-70
    const index = fs.readFileSync(path.join(root, "INDEX.md"), "utf-8")
    expect(index).toContain("# Octopus Knowledge Wiki — testorg")
    expect(index).toContain("> Agent 导航协议：先读本索引 → 选词条整读 → 未命中再 search API。禁止全库遍历。")
    expect(index).toContain("## projects/ （项目知识 · 1 词条 · 6 规则）")
    // 每词条一行摘要 — llms.txt 惯例（prototype line 51 行式，路径与 summary/topics 来自 fixture）
    expect(index).toContain("- projects/prj-octopus.md — monorepo 构建/测试/端口规则与已知陷阱｜topics: build,test,ports,pitfall")
    expect(index).toContain("## 统计")
    expect(index).toContain(`词条 1 · 案例 0 · 规则 6 · 最近编译 2026-10-12 · 待审核 0 ｜ 变更史见 LOG.md / git log`)

    // ── LOG.md — header verbatim from prototype Tab③ lines 500-507 + append 行
    const log = fs.readFileSync(path.join(root, "LOG.md"), "utf-8")
    expect(log).toContain("# Curation Log（append-only · 编译器自动写 · 详情看 git show <hash>）")
    expect(log).toContain("| 日期 | 动作 | 词条 | 摘要 | 来源 | 审核 |")
    expect(log).toContain(`| ${today()} | compile | projects/prj-octopus.md | +oct-001…oct-012 初始编译 | task-207 归档提炼 | xzf ✓ |`)

    // ── git: 独立仓库 + 编译 commit 可查（真 git，workspace-git.test.ts fixture 先例）
    expect(fs.existsSync(path.join(root, ".git"))).toBe(true)
    const gitLog = execFileSync("git", ["log", "--format=%s"], { cwd: root, encoding: "utf-8" })
    expect(gitLog).toContain("compile: projects/prj-octopus.md")
    const shown = execFileSync("git", ["show", "--name-only", "--format=", res.commit!], { cwd: root, encoding: "utf-8" })
    expect(shown).toContain("projects/prj-octopus.md")
    expect(shown).toContain("INDEX.md")
    expect(shown).toContain("LOG.md")

    // ── DB 行 + FTS 同步（外部产物，不是内部调用序列）
    const row = db.prepare("SELECT * FROM wiki_articles WHERE org='testorg' AND id='prj-octopus'").get() as Record<string, unknown>
    expect(row.domain).toBe("projects")
    expect(row.title).toBe("Octopus 平台工程知识")
    expect(JSON.parse(row.topics as string)).toEqual(["build", "test", "ports", "pitfall"])
    expect(row.confidence).toBe(0.86)
    const hits = db.prepare("SELECT id FROM wiki_fts WHERE wiki_fts MATCH 'Promise'").all() as { id: string }[]
    expect(hits.map(h => h.id)).toContain("prj-octopus")
  })

  it("rejects an entry violating the front-matter schema, leaving zero traces", () => {
    const svc = makeService()
    const bad = SAMPLE_ENTRY.replace("summary: monorepo 构建/测试/端口规则与已知陷阱\n", "")
    expect(() => svc.compileEntry({ content: bad })).toThrow(/INVALID_FRONTMATTER.*summary/s)

    // 不留半成品：无词条、无 INDEX/LOG、无 git 仓库、无 DB 行
    expect(fs.existsSync(path.join(root, "projects", "prj-octopus.md"))).toBe(false)
    expect(fs.existsSync(path.join(root, "INDEX.md"))).toBe(false)
    expect(fs.existsSync(path.join(root, "LOG.md"))).toBe(false)
    expect((db.prepare("SELECT COUNT(*) AS n FROM wiki_articles").get() as { n: number }).n).toBe(0)
  })

  it("rejects a duplicate rule anchor across entries — anchor 全库唯一", () => {
    const svc = makeService()
    svc.compileEntry({ content: SAMPLE_ENTRY })
    expect(() => svc.compileEntry({ content: CLashingEntry })).toThrow(/ANCHOR_CONFLICT.*oct-007/s)
    expect(fs.existsSync(path.join(root, "workflows", "wf-bug-hunter.md"))).toBe(false)
    const index = fs.readFileSync(path.join(root, "INDEX.md"), "utf-8")
    expect(index).not.toContain("wf-bug-hunter")
  })

  it("rolls back atomically when the git commit fails — no half-written state", () => {
    const svc = makeService()
    svc.compileEntry({ content: SAMPLE_ENTRY })
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
    expect(() => svc2.compileEntry({ content: second, note: "应当被回滚" })).toThrow(/commit/)

    // 词条文件未留下、INDEX/LOG 逐字节回到第一编译后的状态、DB 只有第一行
    expect(fs.existsSync(path.join(root, "projects", "prj-octopus-b.md"))).toBe(false)
    expect(fs.readFileSync(path.join(root, "INDEX.md"), "utf-8")).toBe(indexBefore)
    expect(fs.readFileSync(path.join(root, "LOG.md"), "utf-8")).toBe(logBefore)
    expect((db.prepare("SELECT COUNT(*) AS n FROM wiki_articles").get() as { n: number }).n).toBe(1)
    expect((db.prepare("SELECT COUNT(*) AS n FROM wiki_fts").get() as { n: number }).n).toBe(1)
  })

  it("warns (non-blocking) when the body contains dates — L5 预检", () => {
    const svc = makeService()
    const dated = SAMPLE_ENTRY.replace(
      "## 端口规则",
      "## 带日期小节\n- 2026-06-23 那次 CI 挂了 <!--#oct-020-->\n\n## 端口规则",
    )
    const res = svc.compileEntry({ content: dated })
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/) // 仍然编译成功（warn 级，完整 lint 闸属票 02）
    expect(res.warnings.some(w => w.includes("L5") && w.includes("2026-06-23"))).toBe(true)
  })

  it("recompiling the same entry upserts: one DB row, INDEX lists it once, git history grows", () => {
    const svc = makeService()
    svc.compileEntry({ content: SAMPLE_ENTRY })
    const updated = SAMPLE_ENTRY.replace("summary: monorepo 构建/测试/端口规则与已知陷阱", "summary: 构建/测试/端口/CI 规则与已知陷阱")
    const res2 = svc.compileEntry({ content: updated, note: "修订 summary" })

    expect((db.prepare("SELECT COUNT(*) AS n FROM wiki_articles WHERE org='testorg'").get() as { n: number }).n).toBe(1)
    const row = db.prepare("SELECT summary FROM wiki_articles WHERE id='prj-octopus'").get() as { summary: string }
    expect(row.summary).toBe("构建/测试/端口/CI 规则与已知陷阱")
    const index = fs.readFileSync(path.join(root, "INDEX.md"), "utf-8")
    expect(index.match(/projects\/prj-octopus\.md/g)!.length).toBe(1)
    expect(index).toContain("- projects/prj-octopus.md — 构建/测试/端口/CI 规则与已知陷阱｜topics: build,test,ports,pitfall")
    const hits = db.prepare("SELECT id FROM wiki_fts WHERE wiki_fts MATCH 'CI'").all() as { id: string }[]
    expect(hits.map(h => h.id)).toContain("prj-octopus")
    // LOG 不重复表头、追加第二行
    const log = fs.readFileSync(path.join(root, "LOG.md"), "utf-8")
    expect(log.match(/# Curation Log/g)!.length).toBe(1)
    expect(log).toContain(`| ${today()} | compile | projects/prj-octopus.md | 修订 summary | manual | curator ✓ |`)
    expect(res2.commit).toMatch(/^[0-9a-f]{40}$/)
  })
})
