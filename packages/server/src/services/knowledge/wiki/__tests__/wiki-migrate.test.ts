import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { spawnSync } from "child_process"
import { applySchema } from "../../../../db/schema"
import { InitialCompileMigrator, type MigrationReport } from "../migrate"
import { spawnGit, type GitRunner } from "../wiki-git"

/**
 * S1 缝（票05 初始编译迁移）— wiki-compile.test.ts 同先例：真 fs tmpdir + in-memory DB + 真 git。
 * fixture 全部合成（形状逐字对照 data-plane notes §2 真实存量两变体），绝不碰真实 org 目录。
 * 只断言外部产物：词条文件 / _migration/state.json 锚点映射表 / LOG / git 历史 / DB 行。
 * Expected 值来自独立真相源：fixture 手搓 + spec §知识表示 + prototype Tab③ 初始编译表。
 */

// 票06 合并适配（与票04 同法）：迁移器写通道提交须走 spawnGit（自动携带
// OCTOPUS_WIKI_COMMIT_SOURCE=curate 标记，与生产 WikiCompileService 默认 this.git 同一
// 通道）；裸 spawnSync 无标记会被 pre-commit 闸门拒。只读断言仍用 spawnSync（不提交）。
const realGit = (cwd: string): GitRunner => spawnGit(cwd)

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** 真实变体(a)：无 front-matter、无 H1/H2，两行式注释（id 含 '/' → 过不了 isValidRuleId）。 */
const LEGACY_PROJECTS_TWO_LINE = `- 修改 shared/ 后必须先 pnpm build 再全量构建
<!-- id:projects/demo-proj-001 | 2026-07-02 | compact -->
- 提交前跑 pnpm test 全量通过
<!-- id:projects/demo-proj-002 | 2026-07-03 | compact -->
`

describe("initial-compile migrator (ticket 05)", async () => {
  let db: Database.Database
  let tmpDir: string
  let root: string
  let knowledgeDir: string

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-migrate-"))
    root = path.join(tmpDir, "wiki")
    knowledgeDir = path.join(tmpDir, "knowledge")
    fs.mkdirSync(path.join(knowledgeDir, "projects"), { recursive: true })
    fs.mkdirSync(path.join(knowledgeDir, "workflows"), { recursive: true })
  })

  afterEach(() => {
    db?.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function makeMigrator(over: Partial<ConstructorParameters<typeof InitialCompileMigrator>[0]> = {}) {
    return new InitialCompileMigrator({
      db,
      org: "testorg",
      rootDir: root,
      knowledgeDir,
      glossaryMapPath: path.join(tmpDir, "GLOSSARY-MAP.md"),
      git: realGit(root),
      ...over,
    })
  }

  it("migrates a two-line-variant projects file: v2 entry, oct-NNN remap, dates consolidated into sources, zero dates in body, LOG first-compile line", async () => {
    fs.writeFileSync(path.join(knowledgeDir, "projects", "demo-proj.md"), LEGACY_PROJECTS_TWO_LINE, "utf-8")

    const report = await makeMigrator().run()

    // ── report（外部可见的迁移结果清单）
    expect(report.compiled).toHaveLength(1)
    expect(report.compiled[0].entryId).toBe("prj-demo-proj")
    expect(report.compiled[0].source).toBe("projects/demo-proj.md")
    expect(report.skipped).toEqual([])
    expect(report.failed).toEqual([])

    // ── 词条文件：格式 v2 落 projects/prj-demo-proj.md
    const entryFile = path.join(root, "projects", "prj-demo-proj.md")
    expect(fs.existsSync(entryFile)).toBe(true)
    const written = fs.readFileSync(entryFile, "utf-8")
    expect(written).toContain("id: prj-demo-proj")
    expect(written).toContain("domain: projects")
    // sources 收编：回指原文件 + 行内 date/source 注释进 front-matter（spec：日期三处承接之一）
    expect(written).toContain("doc:knowledge/projects/demo-proj.md")
    expect(written).toContain("archive:compact@2026-07-02")
    expect(written).toContain("archive:compact@2026-07-03")
    // 规则保留、锚点重映射为 oct-NNN（不复用旧 id —— 旧 id 含 '/' 过不了 schema）
    expect(written).toContain("- 修改 shared/ 后必须先 pnpm build 再全量构建 <!--#oct-001-->")
    expect(written).toContain("- 提交前跑 pnpm test 全量通过 <!--#oct-002-->")
    // 常青正文零日期：front-matter 之后的正文里不许出现任何日期
    const body = written.slice(written.indexOf("\n---\n", 4) + 5)
    expect(body).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{4}\/\d{1,2}\/\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日/)
    // 旧式行内 id 注释不得残留
    expect(written).not.toContain("<!-- id:")

    // ── 锚点映射表：_migration/state.json（幂等键 + 审计锚）
    const state = JSON.parse(fs.readFileSync(path.join(root, "_migration", "state.json"), "utf-8"))
    expect(state.sources["projects/demo-proj.md"].anchors).toEqual({
      "projects/demo-proj-001": "oct-001",
      "projects/demo-proj-002": "oct-002",
    })
    expect(state.counter).toBe(2)

    // ── LOG.md 首编译行（compileEntry 事务内 append；票04 行格式）
    const log = fs.readFileSync(path.join(root, "LOG.md"), "utf-8")
    expect(log).toContain("# LOG.md — 时间线")
    expect(log.split("\n").filter(l => l.includes("] compile | "))).toHaveLength(1)
    expect(log).toContain(`## [${today()}] compile | projects/prj-demo-proj.md`)

    // ── DB 行 + FTS（编译服务同步，迁移不旁路）
    expect((db.prepare("SELECT COUNT(*) AS n FROM wiki_articles WHERE org='testorg'").get() as { n: number }).n).toBe(1)

    // ── git：独立 commit 链可审（每源文件一 commit）
    const gitLog = spawnSync("git", ["log", "--format=%s"], { cwd: root, timeout: 30000 }).stdout.toString()
    expect(gitLog).toContain("compile: projects/prj-demo-proj.md")
  })

  it("migrates the inline-variant workflows file preserving H2 sections, anchors numbered in document order", async () => {
    // 真实变体(b)：H1 + H2 小节 + 规则行尾内联注释（workflows/prd-impl.md 形状）
    fs.writeFileSync(
      path.join(knowledgeDir, "workflows", "demo-flow.md"),
      `# 工作流经验: demo-flow

## 构建规则

- 修改 shared/ 后必须先构建 shared 包 <!-- id:demo-flow-1 | 2026-07-02 | manual -->
- 改 schema 后同步 manifest <!-- id:demo-flow-2 | 2026-07-02 | manual -->

## 已知陷阱

- 端口冲突先清旧进程 <!-- id:demo-flow-3 | 2026-07-04 | manual -->
`,
      "utf-8",
    )

    const report = await makeMigrator().run()
    expect(report.compiled).toHaveLength(1)
    expect(report.compiled[0].entryId).toBe("wf-demo-flow")

    const written = fs.readFileSync(path.join(root, "workflows", "wf-demo-flow.md"), "utf-8")
    expect(written).toContain("domain: workflows")
    // H2 小节结构保留（L1 拆分提案按 H2 切，结构丢了提案就不可用）
    expect(written).toContain("## 构建规则")
    expect(written).toContain("## 已知陷阱")
    // 规则在正确小节下、锚点按文档序编号
    expect(written).toContain("- 修改 shared/ 后必须先构建 shared 包 <!--#oct-001-->")
    expect(written).toContain("- 改 schema 后同步 manifest <!--#oct-002-->")
    const buildIdx = written.indexOf("## 构建规则")
    const trapIdx = written.indexOf("## 已知陷阱")
    expect(written.indexOf("oct-002")).toBeGreaterThan(buildIdx)
    expect(written.indexOf("oct-002")).toBeLessThan(trapIdx)
    expect(written.indexOf("oct-003")).toBeGreaterThan(trapIdx)
    // 内联旧注释清除、日期收编进 sources
    expect(written).not.toMatch(/<!-- id:\S+ \| \S+ \| \S+ -->/)
    expect(written).toContain("archive:manual@2026-07-02")
    expect(written).toContain("archive:manual@2026-07-04")

    const state = JSON.parse(fs.readFileSync(path.join(root, "_migration", "state.json"), "utf-8"))
    expect(state.sources["workflows/demo-flow.md"].anchors).toEqual({
      "demo-flow-1": "oct-001",
      "demo-flow-2": "oct-002",
      "demo-flow-3": "oct-003",
    })
  })

  it("idempotent: re-run skips unchanged sources — git diff empty, no duplicate entries/anchors/LOG lines", async () => {
    fs.writeFileSync(path.join(knowledgeDir, "projects", "demo-proj.md"), LEGACY_PROJECTS_TWO_LINE, "utf-8")
    fs.writeFileSync(
      path.join(knowledgeDir, "workflows", "demo-flow.md"),
      `## 构建规则\n\n- 修改 shared/ 后必须先构建 <!-- id:demo-flow-1 | 2026-07-02 | manual -->\n`,
      "utf-8",
    )

    const run1 = await makeMigrator().run()
    expect(run1.compiled.map(c => c.source)).toEqual(["projects/demo-proj.md", "workflows/demo-flow.md"])

    const gitStatus = () => spawnSync("git", ["status", "--porcelain"], { cwd: root, timeout: 30000 }).stdout.toString().trim()
    const commitCount = () => spawnSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, timeout: 30000 }).stdout.toString().trim()
    expect(gitStatus()).toBe("") // 首跑后工作树干净

    const logBefore = fs.readFileSync(path.join(root, "LOG.md"), "utf-8")
    const indexBefore = fs.readFileSync(path.join(root, "INDEX.md"), "utf-8")
    const commitsBefore = commitCount()

    // 重跑 = 新实例 + 同一 wiki 根（模拟命令重执行）
    const run2 = await makeMigrator().run()
    expect(run2.compiled).toEqual([])
    expect(run2.skipped.sort()).toEqual(["projects/demo-proj.md", "workflows/demo-flow.md"])
    expect(run2.failed).toEqual([])

    expect(gitStatus()).toBe("") // ⇒ git diff 为空（幂等证明主体）
    expect(fs.readFileSync(path.join(root, "LOG.md"), "utf-8")).toBe(logBefore) // LOG 不重复 append
    expect(fs.readFileSync(path.join(root, "INDEX.md"), "utf-8")).toBe(indexBefore)
    expect(commitCount()).toBe(commitsBefore)
    expect((db.prepare("SELECT COUNT(*) AS n FROM wiki_articles").get() as { n: number }).n).toBe(2)
    // 无重复锚点：全库锚点两两不同
    const allAnchors = [
      ...fs.readFileSync(path.join(root, "projects", "prj-demo-proj.md"), "utf-8").matchAll(/<!--#(oct-\d+)-->/g),
      ...fs.readFileSync(path.join(root, "workflows", "wf-demo-flow.md"), "utf-8").matchAll(/<!--#(oct-\d+)-->/g),
    ].map(m => m[1])
    expect(new Set(allAnchors).size).toBe(allAnchors.length)
  })

  it("source changed after migration: existing anchors reused verbatim, new rule gets a never-reused fresh number", async () => {
    fs.writeFileSync(path.join(knowledgeDir, "projects", "demo-proj.md"), LEGACY_PROJECTS_TWO_LINE, "utf-8")
    fs.writeFileSync(
      path.join(knowledgeDir, "workflows", "demo-flow.md"),
      `## 构建规则\n\n- 修改 shared/ 后必须先构建 <!-- id:demo-flow-1 | 2026-07-02 | manual -->\n- 改 schema 后同步 manifest <!-- id:demo-flow-2 | 2026-07-03 | manual -->\n`,
      "utf-8",
    )
    await makeMigrator().run() // demo-proj: oct-001/002 · demo-flow: oct-003/004（文档序全局流水号）

    // 给已迁移源追加一条新规则（旧 id 不变）
    fs.appendFileSync(
      path.join(knowledgeDir, "projects", "demo-proj.md"),
      `- 端口占用先 netstat 复核\n<!-- id:projects/demo-proj-003 | 2026-07-05 | compact -->\n`,
      "utf-8",
    )

    const run2 = await makeMigrator().run()
    expect(run2.skipped).toEqual(["workflows/demo-flow.md"]) // 未变源不重编
    expect(run2.compiled.map(c => c.source)).toEqual(["projects/demo-proj.md"])

    const written = fs.readFileSync(path.join(root, "projects", "prj-demo-proj.md"), "utf-8")
    expect(written).toContain("- 修改 shared/ 后必须先 pnpm build 再全量构建 <!--#oct-001-->") // 映射表复用，不重铸
    expect(written).toContain("- 端口占用先 netstat 复核 <!--#oct-005-->") // 新号续排，避开 wf 的 003/004
    const state = JSON.parse(fs.readFileSync(path.join(root, "_migration", "state.json"), "utf-8"))
    expect(state.sources["projects/demo-proj.md"].anchors["projects/demo-proj-003"]).toBe("oct-005")
    expect(state.counter).toBe(5)

    // INDEX 不重复列，DB 仍两行
    const index = fs.readFileSync(path.join(root, "INDEX.md"), "utf-8")
    expect(index.match(/projects\/prj-demo-proj\.md/g)).toHaveLength(1)
    expect((db.prepare("SELECT COUNT(*) AS n FROM wiki_articles").get() as { n: number }).n).toBe(2)

    // 收敛幂等：变更消化后三跑再全跳过
    const run3 = await makeMigrator().run()
    expect(run3.compiled).toEqual([])
  })

  it("legacy path (no orgs/ segment) compat-read once: file migrated, old dir kept read-only, current dir wins on duplicate rel", async () => {
    const legacyDir = path.join(tmpDir, "legacy") // fixture 形态 = ~/.octopus/{org}/knowledge
    fs.mkdirSync(path.join(legacyDir, "projects"), { recursive: true })
    fs.writeFileSync(
      path.join(legacyDir, "projects", "old-layout.md"),
      `- 旧布局唯一规则\n<!-- id:projects/old-layout-001 | 2026-06-01 | compact -->\n`,
      "utf-8",
    )
    // 同 rel 在现行目录另有内容 ⇒ 现行优先（兼容读不是合并读）
    fs.writeFileSync(
      path.join(knowledgeDir, "projects", "both.md"),
      `- 现行版本规则\n<!-- id:projects/both-001 | 2026-06-02 | compact -->\n`,
      "utf-8",
    )
    fs.writeFileSync(
      path.join(legacyDir, "projects", "both.md"),
      `- 旧版本规则\n<!-- id:projects/both-999 | 2026-01-01 | compact -->\n`,
      "utf-8",
    )

    const run1 = await makeMigrator({ legacyKnowledgeDir: legacyDir }).run()
    expect(run1.compiled.map(c => c.source).sort()).toEqual(["projects/both.md", "projects/old-layout.md"])

    const state = JSON.parse(fs.readFileSync(path.join(root, "_migration", "state.json"), "utf-8"))
    expect(state.sources["projects/old-layout.md"].origin).toBe("legacy")
    expect(state.sources["projects/both.md"].origin).toBe("current")
    expect(state.sources["projects/both.md"].anchors["projects/both-999"]).toBeUndefined() // 旧版内容不迁移
    const both = fs.readFileSync(path.join(root, "projects", "prj-both.md"), "utf-8")
    expect(both).toContain("现行版本规则")
    expect(both).not.toContain("旧版本规则")

    // 红线：迁移后旧目录只读保留，不删除
    expect(fs.existsSync(path.join(legacyDir, "projects", "old-layout.md"))).toBe(true)
    expect(fs.existsSync(path.join(legacyDir, "projects", "both.md"))).toBe(true)

    // 幂等对 legacy 源同样成立
    const run2 = await makeMigrator({ legacyKnowledgeDir: legacyDir }).run()
    expect(run2.compiled).toEqual([])
    expect(run2.skipped.sort()).toEqual(["projects/both.md", "projects/old-layout.md"])
  })

  it("splits GLOSSARY-MAP system terms into business/ entries grouped by package domain, incl. the two-rows-glued-on-one-line anomaly", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "GLOSSARY-MAP.md"),
      `# Context Map — Test

## System-wide Glossary

| Term | Definition | Primary Package |
|------|-----------|----------------|
| **Alpha** | 首个术语定义 | engine |
| **Beta** | 第二个术语，含 **内嵌加粗** | engine, server |
| **Gamma** | 第三定义 | core-pack |
| **Delta** | 第四定义 | core-pack, server || **Epsilon** | 第五定义粘连行 | server |

## Anti-Patterns（禁止）

| Pattern | Why Banned |
|---------|-----------|
| **Nope** | 两列表格不该被抓进 business |
`,
      "utf-8",
    )

    const report = await makeMigrator().run()
    expect(report.compiled).toHaveLength(3) // 每拆分词条一条记录（独立 commit 链）
    expect([...new Set(report.compiled.map(c => c.source))]).toEqual(["GLOSSARY-MAP.md"])

    // 按域（Primary Package 首项）分组：engine 组含 "engine, server" 的 Beta
    const engine = fs.readFileSync(path.join(root, "business", "biz-glossary-engine.md"), "utf-8")
    expect(engine).toContain("domain: business")
    expect(engine).toContain("id: biz-glossary-engine")
    expect(engine).toContain("- **Alpha** — 首个术语定义 <!--#oct-001-->")
    expect(engine).toContain("- **Beta** — 第二个术语，含 **内嵌加粗** <!--#oct-002-->")
    const corepack = fs.readFileSync(path.join(root, "business", "biz-glossary-core-pack.md"), "utf-8")
    expect(corepack).toContain("- **Gamma** — 第三定义 <!--#oct-003-->")
    expect(corepack).toContain("- **Delta** — 第四定义 <!--#oct-004-->")
    const server = fs.readFileSync(path.join(root, "business", "biz-glossary-server.md"), "utf-8")
    expect(server).toContain("- **Epsilon** — 第五定义粘连行 <!--#oct-005-->") // 粘连行拆回两条
    expect(server).not.toContain("Delta")
    expect(corepack).not.toContain("Nope") // 二列 Anti-Patterns 表不误吞
    expect(engine).not.toContain("Nope")

    // 术语锚点同样进映射表（glossary:{term} 键），且 sources 回指原文件
    const state = JSON.parse(fs.readFileSync(path.join(root, "_migration", "state.json"), "utf-8"))
    expect(state.sources["GLOSSARY-MAP.md"].anchors).toEqual({
      "glossary:Alpha": "oct-001",
      "glossary:Beta": "oct-002",
      "glossary:Gamma": "oct-003",
      "glossary:Delta": "oct-004",
      "glossary:Epsilon": "oct-005",
    })
    expect(engine).toContain("doc:GLOSSARY-MAP.md")

    // 幂等：GLOSSARY 源重跑全跳
    const run2 = await makeMigrator().run()
    expect(run2.compiled).toEqual([])
    expect(run2.skipped).toEqual(["GLOSSARY-MAP.md"])
  })

  it("INDEX L4 两级（票03 翻转：硬拒→分层收敛）：36 源推爆 ⇒ Optional 重排收敛恒见段全放行——溢出页降级在尾非静默截断，预警 finding 伴随，不入队", async () => {
    // 票03 前本测试断言「其后短源 L4 拒写+建议随错」——旧口径把降入 Optional 的行仍算进
    // 预算，D-aa16-2「Optional 重排无法收敛」三连拒的病根。两级化后：重排目标=恒见部分，
    // 溢出页以压缩尾行（- relPath — title）留在 INDEX（可见面降级≠截断），全批放行。
    const fatBase = "ab-overflow-probe-0123456789abcdef0123456"
    fs.writeFileSync(
      path.join(knowledgeDir, "projects", `${fatBase}.md`),
      `## 构建\n\n- 规则甲\n<!-- id:projects/${fatBase}-001 | 2026-07-02 | compact -->\n- 规则乙\n<!-- id:projects/${fatBase}-002 | 2026-07-02 | compact -->\n\n## 陷阱\n\n- 规则丙\n<!-- id:projects/${fatBase}-003 | 2026-07-02 | compact -->\n`,
      "utf-8",
    )
    const SHORT = `- 短规则甲\n<!-- id:projects/filler-00X-001 | 2026-07-02 | compact -->\n- 短规则乙\n<!-- id:projects/filler-00X-002 | 2026-07-02 | compact -->\n`
    for (let i = 0; i < 35; i++) {
      const tag = String(i).padStart(2, "0")
      fs.writeFileSync(path.join(knowledgeDir, "projects", `filler${tag}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.md`), SHORT.replace(/00X/g, tag))
    }

    const report = await makeMigrator().run()
    // 两级化行为：零拒——新知识不再被预算硬顶三连（spec 故事24 验收面）
    expect(report.failed).toEqual([])
    expect(report.compiled.length).toBe(36)

    const { estimateTokens } = await import("../lint")
    const index = fs.readFileSync(path.join(root, "INDEX.md"), "utf-8")
    expect(index).toContain("## Optional")
    const visible = index.split("## Optional")[0]
    expect(estimateTokens(visible)).toBeLessThanOrEqual(800)
    // 病根锚定（独立算账）：INDEX **全文** token >800——旧口径此态必拒（三连拒现场），
    // 分层后恒见段达标而尾部承载溢出行：分层真实生效=本测试与 D-aa16-2 的因果对质
    expect(estimateTokens(index)).toBeGreaterThan(800)

    // 预警 finding 伴随（恒见段推过 80% 线；kind 单源 patrol.ts PatrolFindingKind；不入队=红线2）
    const warn = db
      .prepare("SELECT COUNT(*) AS n FROM findings WHERE kind = 'index-budget' AND status = 'open'")
      .get() as { n: number }
    expect(warn.n).toBe(1)

    // 失败重跑面 → 幂等重放：已入库全跳过、零失败（旧断言「被拒源仍拒」随两级化退役）
    const run2 = await makeMigrator().run()
    expect(run2.skipped.length).toBe(report.compiled.length)
    expect(run2.failed).toEqual([])
  }, 180_000)

  it("excludes user_preference.md/index.md and skips <!-- retired -->-marked legacy rules without minting anchor numbers for them", async () => {
    fs.writeFileSync(
      path.join(knowledgeDir, "projects", "keep.md"),
      `- 活规则一\n<!-- id:projects/keep-001 | 2026-07-02 | compact -->\n- 已退役规则\n<!-- id:projects/keep-002 | 2026-07-01 | compact -->\n<!-- retired -->\n- 活规则三\n<!-- id:projects/keep-003 | 2026-07-03 | manual -->\n`,
      "utf-8",
    )
    // 不属于迁移范围的历史产物（user_preference 不由程序自动改写）
    fs.writeFileSync(path.join(knowledgeDir, "projects", "user_preference.md"), "- 偏好\n<!-- id:projects/user_preference-001 | 2026-07-01 | compact -->\n", "utf-8")
    fs.writeFileSync(path.join(knowledgeDir, "workflows", "index.md"), "| 统计 |\n", "utf-8")

    const report = await makeMigrator().run()
    expect(report.compiled.map(c => c.source)).toEqual(["projects/keep.md"])
    expect(report.skipped).toEqual([])
    expect(report.failed).toEqual([])

    const written = fs.readFileSync(path.join(root, "projects", "prj-keep.md"), "utf-8")
    expect(written).toContain("- 活规则一 <!--#oct-001-->")
    expect(written).toContain("- 活规则三 <!--#oct-002-->") // 退役规则不占锚点号（流水号无洞）
    expect(written).not.toContain("已退役规则")
    expect(written).not.toContain("archive:compact@2026-07-01") // 退役规则的日期也不收编
    expect(written).toContain("archive:manual@2026-07-03")

    const state = JSON.parse(fs.readFileSync(path.join(root, "_migration", "state.json"), "utf-8"))
    expect(Object.keys(state.sources["projects/keep.md"].anchors)).toEqual(["projects/keep-001", "projects/keep-003"])
    expect(state.counter).toBe(2)
  })

  it("escaped: definitions quoting anchor examples or containing bare pipes migrate intact (real GLOSSARY-MAP hazards)", async () => {
    // 真实陷阱一：「词条 (Entry)」的定义用反引号示范 `<!--#oct-001-->` —— 原样搬进正文
    // 会被格式律当成真锚点 → 全库唯一冲突。
    // 真实陷阱二：「INDEX/LOG 导航层」的定义含裸管道符（ |日期|动作|…| LOG 行格式示例）——
    // 按列硬切会拦腰截断定义、把管道碎片当分组键（冒出 biz-glossary-g 的实测回归）。
    fs.writeFileSync(
      path.join(tmpDir, "GLOSSARY-MAP.md"),
      `# Context Map\n\n## System-wide Glossary\n\n| Term | Definition | Primary Package |\n|---|---|---|\n| **Alpha** | 规则行仅带不可见锚点 \`<!--#oct-001-->\`（全库唯一、永不复用） | engine |\n| **Beta** | 第二个术语 | engine |\n| **LogRow** | LOG.md 行格式（ |日期|动作|词条|摘要| ） | server |\n`,
      "utf-8",
    )

    const report = await makeMigrator().run()
    expect(report.failed).toEqual([]) // 修复前这里会 ANCHOR_CONFLICT: oct-001
    expect(report.compiled).toHaveLength(2)
    const flat = report.compiled.flatMap(c => c.anchors.map(a => `${a.legacy}=${a.anchor}`))
    expect(flat).toContain("glossary:Alpha=oct-001")
    expect(flat).toContain("glossary:Beta=oct-002")

    const written = fs.readFileSync(path.join(root, "business", "biz-glossary-engine.md"), "utf-8")
    // 示例被脱成无害文本（正则不可见形态），锚点数与正文示例互不污染
    expect(written).toContain("<!-- #oct-001-->")
    expect(written).toContain("- **Alpha** — 规则行仅带不可见锚点 `<!-- #oct-001-->`（全库唯一、永不复用） <!--#oct-001-->")
    const { extractRuleAnchors, parseEntryMarkdown } = await import("../format")
    const { body } = parseEntryMarkdown(written)
    expect(extractRuleAnchors(body)).toEqual(["oct-001", "oct-002"])

    // 含管道定义完整保留、分组键是 server（不是管道碎片）
    const server = fs.readFileSync(path.join(root, "business", "biz-glossary-server.md"), "utf-8")
    expect(server).toContain("- **LogRow** — LOG.md 行格式（ |日期|动作|词条|摘要| ） <!--#oct-003-->")
    expect(fs.existsSync(path.join(root, "business", "biz-glossary-g.md"))).toBe(false)
  })
})
