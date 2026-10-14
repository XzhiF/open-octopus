import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { spawnSync } from "child_process"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../../../../db/schema"
import { WikiCompileService, type GitRunner } from "../compile"
import { parseWikiFile } from "../format"
import { ensureWikiSkeleton } from "../paths"

/**
 * 票04 · S1 缝（spec §Testing Decisions S1 行 / 票面 AC7）：v3 五类页形态基座环级测试。
 * 真 fs tmpdir + in-memory DB + 真 git（wiki-compile.test.ts 同款 harness）。
 * Expected 值逐字取自 prototype.html Tab② 样例页
 * （entities/open-octopus、topics/prd-impl-workflow 的 front-matter 与正文形态，
 *  INDEX/LOG 样例行）——独立真相源，禁止 Tautological Test。
 */

// ── prototype Tab② 「页样例 — entities/open-octopus.md」逐字 front-matter + 正文 ──
export const PROTO_ENTITY_PAGE = `---
id: ent-open-octopus
type: entity
entity_kind: project
title: Open Octopus（平台 monorepo）
summary: pnpm monorepo：engine/server/web-app/shared/cli/core-pack 六包
aliases: [octopus, open-octopus]
links: "[[top-prd-impl]] [[con-execution-identity]] [[ent-hermes]]"
sources: [raw/archives/task-207-summary.md, raw/inbox/2026-09-xx-arch-notes.md]
last_compiled: 2026-10-13
confidence: 0.9
---

## 概述
Octopus 是工作流编排 + Agent 分身平台，pnpm monorepo 六包，构建/端口/CI 纪律见 [[top-prd-impl]]。

## 关键属性
- 仓库 github.com/XzhiF/octopus · pnpm 10 · Node 20+ · CI=install→build→lint
- 端口：server 3001 / web 3000（保护端口纪律见 [[top-windows-bash-ops]]）

## 关系
- 通知走 → [[ent-hermes]]　· 主工作流 → [[top-prd-impl]]　· 知识体系 → [[con-compiled-rag]]

## 来源注记
- 六包结构断言 ← raw/archives/task-207-summary.md §2
`

// ── prototype Tab② 「页样例 — topics/prd-impl-workflow.md」逐字（锚点只在「硬约束」小节）──
export const PROTO_TOPIC_PAGE = `---
id: top-prd-impl
type: topic
title: prd-impl 工作流知识
summary: PRD→实现→审查→ship 的 SOP、硬约束与已知陷阱
links: "[[ent-open-octopus]] [[top-windows-bash-ops]]"
sources: [raw/archives/task-183-summary.md, review-history:wf-prd-impl]
last_compiled: 2026-10-13
stability: stable
---

## SOP
refine-plan → implement → review → e2e → ship 各阶段要点（prose，编译自源）。

## 硬约束
- 修改 shared/ 后必须先 pnpm build -w shared 再全量构建 <!--#oct-008-->
- 实现后先 pnpm test 全绿再 pnpm build <!--#oct-014-->

## 已知陷阱
→ 判例：[[case-pnpm-lockfile-mismatch]]
`

/** 无前瞻引用的桩页（编译序：先桩后英雄页，避免单页编译的循环断链）。 */
export function stubPage(id: string, type: string, title: string, summary: string): string {
  return `---
id: ${id}
type: ${type}
title: ${title}
summary: ${summary}
links: []
sources: [fixture:ticket-04]
last_compiled: 2026-10-13
---

## 桩
- 票04 形态基座桩页，无规则锚点。
`
}

/** 判例保留 P0 形态（prototype Tab② taxonomy 表）——经判例管线入库，id 供 topic 页 [[...]] 引用。 */
export const SEED_CASE = `---
id: case-pnpm-lockfile-mismatch
symptom: CI lockfile 事故
tags: [ci, pnpm]
severity: blocker
occurrences: 1
source: commit 82d96372
status: open
---
## 现场  pnpm 9 的 CI 读不进 v10 lockfile，报 LOCKFILE_CONFIG_MISMATCH
## 诊断  lockfile overrides 住在 pnpm-workspace.yaml
## 根因  lockfile 格式版本与 CLI 版本错配
## 修复  CI 升 pnpm 10
## 教训  工具链大版本升级先查配置文件归属变化
`

const realGit = (cwd: string): GitRunner => ({
  run(args: string[]) {
    const r = spawnSync("git", args, { cwd, timeout: 30000, env: { ...process.env, OCTOPUS_WIKI_COMMIT_SOURCE: "curate" } })
    return { status: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
  },
})

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

describe("v3 页格式基座 — 票04 S1（expected 逐字 prototype Tab②）", () => {
  let db: Database.Database
  let tmpDir: string
  let root: string

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-v3-"))
    root = path.join(tmpDir, "wiki")
    ensureWikiSkeleton(root)
  })

  afterEach(() => {
    db?.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function makeService() {
    return new WikiCompileService({ db, org: "testorg", rootDir: root, git: realGit(root) })
  }

  /** 桩库：4 桩页 + 英雄页桩身（同 fileName，供英雄页覆写）+ P0 判例 —— 全部 op=compile 行。 */
  async function seedCorpus(svc: WikiCompileService) {
    await svc.compileEntry({ content: stubPage("ent-hermes", "entity", "hermes 通知服务", "消息推送通道服务") })
    await svc.compileEntry({ content: stubPage("con-execution-identity", "concept", "执行身份", "as 字段到分身快照的执行身份体系") })
    await svc.compileEntry({ content: stubPage("con-compiled-rag", "concept", "编译型 RAG", "检索重活挪到维护期，答案从编译产物合成") })
    await svc.compileEntry({ content: stubPage("top-windows-bash-ops", "topic", "Windows 拆机操作", "拆机三段式与保护端口纪律") })
    // 英雄页桩身（同 fileName）：解 circular links 的编译序死锁；英雄编译落盘即覆写
    await svc.compileEntry({ content: stubPage("top-prd-impl", "topic", "prd-impl 占位桩", "桩身：供英雄主题页覆写"), fileName: "prd-impl-workflow.md" })
    await svc.compileEntry({ content: stubPage("ent-open-octopus", "entity", "Open Octopus（占位桩）", "桩身：供英雄实体页覆写"), fileName: "open-octopus.md" })
    await svc.compileEntry({ content: SEED_CASE, fileName: "2026-10-12-pnpm-lockfile-mismatch.md" })
  }

  const TOPIC_FILE = { content: PROTO_TOPIC_PAGE, fileName: "prd-impl-workflow.md" } as const
  const ENTITY_FILE = { content: PROTO_ENTITY_PAGE, fileName: "open-octopus.md" } as const

  // ── AC1/AC6：v3 编译产物（实体页）——文件、路径面、DB 类型值面 ──
  it("compiles prototype entity page: entities/ path, v3 front-matter round-trip, DB domain=entity, FTS hit", async () => {
    const svc = makeService()
    await seedCorpus(svc)
    const res = await svc.compileEntry({ ...ENTITY_FILE, source: "raw/archives/task-207-summary.md" })

    expect(res.id).toBe("ent-open-octopus")
    expect(res.path).toBe("entities/open-octopus.md")
    expect(res.domain).toBe("entity")
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/)

    const written = fs.readFileSync(path.join(root, "entities", "open-octopus.md"), "utf-8")
    const back = parseWikiFile(written)
    expect(back.kind).toBe("page")
    if (back.kind !== "page") return
    expect(back.meta.type).toBe("entity")
    expect(back.meta.entity_kind).toBe("project")
    expect(back.meta.aliases).toEqual(["octopus", "open-octopus"])
    expect(back.meta.links).toEqual(["top-prd-impl", "con-execution-identity", "ent-hermes"])
    expect(back.meta.sources).toHaveLength(2)
    expect(back.meta.confidence).toBe(0.9)
    expect(back.meta.last_compiled).toBe("2026-10-13")
    expect(back.body).toContain("## 概述")

    // DAO/FTS 类型值面：domain 列存 v3 type 值（列名不动）
    const row = db.prepare("SELECT * FROM wiki_articles WHERE org='testorg' AND id='ent-open-octopus'").get() as Record<string, unknown>
    expect(row.domain).toBe("entity")
    expect(row.title).toBe("Open Octopus（平台 monorepo）")
    expect(row.path).toBe("entities/open-octopus.md")
    const hits = db.prepare("SELECT id FROM wiki_fts WHERE wiki_fts MATCH 'monorepo'").all() as { id: string }[]
    expect(hits.map(h => h.id)).toContain("ent-open-octopus")
  }, 60_000)

  // ── AC3：INDEX v3 分组（必读 + 五类 + 样例行式，expected 逐字 prototype Tab②）──
  it("INDEX rebuilt programmatically: 必读 section + five-class groups + one-line-per-page (prototype format)", async () => {
    const svc = makeService()
    await seedCorpus(svc)
    await svc.compileEntry({ ...ENTITY_FILE })
    await svc.compileEntry({ ...TOPIC_FILE })

    const index = fs.readFileSync(path.join(root, "INDEX.md"), "utf-8")
    // 导航协议行（prototype INDEX 样例逐字）
    expect(index).toContain("> 导航协议：先读本索引 → 选页整读 → 未命中再 search API。禁止全库遍历。")
    // 必读节（user_preference，程序化固定行；D-kc15-2 票07 起为知识根可达路径）
    expect(index).toContain("## 必读")
    expect(index).toContain("- ../user_preference.md — owner 偏好（人工维护；住在知识根 = wiki 根上一级，wiki 子树内无此文件）")
    // 五类分组节头（计数 = fixture 实际：entities 2 / concepts 2 / topics 2 / cases 1 / sources 0）
    expect(index).toContain("## Entities (2)")
    expect(index).toContain("## Concepts (2)")
    expect(index).toContain("## Topics (2)")
    expect(index).toContain("## Cases (1)")
    expect(index).not.toContain("## Sources")
    // 一行一页：路径 — summary（←N 源注记）；topic 行带 硬约束×N 计数
    expect(index).toContain("- entities/open-octopus.md — pnpm monorepo：engine/server/web-app/shared/cli/core-pack 六包 ←2 源")
    expect(index).toContain("- topics/prd-impl-workflow.md — PRD→实现→审查→ship 的 SOP、硬约束与已知陷阱 · 硬约束 ×2")
    // 永不经 LLM/人手写；审批遗产字样不存在
    expect(index).not.toContain("待审核")
  }, 60_000)

  // ── AC4：LOG 行格式（grep 前缀友好），程序化 append；旧表格行共存不动 ──
  it("LOG lines append in v3 format '## [date] compile | title → result'; legacy table rows coexist", async () => {
    // 预置 v2 旧表格 LOG（票07 才机械转换——此处只验共存可读）
    fs.writeFileSync(path.join(root, "LOG.md"), "# Curation Log（append-only）\n\n| 日期 | 动作 | 词条 | 摘要 | 来源 | 审核 |\n|---|---|---|---|---|---|\n| 2026-10-01 | compile | projects/old.md | 旧行 | legacy | human ✓ |\n", "utf-8")

    const svc = makeService()
    await seedCorpus(svc)
    await svc.compileEntry({ ...TOPIC_FILE, source: "raw/archives/task-183-summary.md", reviewer: "curator" })

    const log = fs.readFileSync(path.join(root, "LOG.md"), "utf-8")
    // 新行逐字形状：`## [date] op | title` + `→ 结果` 续行（prototype LOG 样例行式）
    expect(log).toContain(`## [${today()}] compile | topics/prd-impl-workflow.md`)
    expect(log).toMatch(/^## \[\d{4}-\d{2}-\d{2}\] (ingest|compile|query|lint|revert) \| .+$/m)
    // grep 友好：行首前缀可数（seed 7 行 + 英雄页 1 行）
    const newLines = log.split("\n").filter(l => l.startsWith(`## [${today()}] compile | `)).length
    expect(newLines).toBe(8)
    // 旧表格行原样共存（append-only，不重写历史）
    expect(log).toContain("| 2026-10-01 | compile | projects/old.md | 旧行 | legacy | human ✓ |")
  }, 60_000)

  // ── AC2：锚点小节约束（只活 topic 硬约束）+ 全库唯一 + 发号 max+1 ──
  it("anchors only exist in topic 硬约束 section: entity page carrying anchors is rejected", async () => {
    const svc = makeService()
    await seedCorpus(svc)
    // 原型实体页正文塞一条带锚点规则行 → v3 拒写（锚点只在 topic 硬约束小节）
    const tainted = PROTO_ENTITY_PAGE.replace(
      "## 来源注记",
      "## 纪律\n- 提交前必须全量构建 <!--#oct-099-->\n\n## 来源注记",
    )
    await expect(svc.compileEntry({ ...ENTITY_FILE, content: tainted })).rejects.toThrow(/L5_ANCHOR_SCOPE/)
    // 拒写零痕迹：盘上仍是桩身（英雄内容未落）
    expect(fs.readFileSync(path.join(root, "entities", "open-octopus.md"), "utf-8")).toContain("桩身：供英雄实体页覆写")
  }, 60_000)

  it("topic anchors outside 硬约束 section are rejected; inside pass", async () => {
    const svc = makeService()
    await seedCorpus(svc)
    const misplaced = PROTO_TOPIC_PAGE.replace(
      "## SOP\nrefine-plan",
      "## SOP\n- 开工前必读索引 <!--#oct-120-->\nrefine-plan",
    )
    await expect(svc.compileEntry({ ...TOPIC_FILE, content: misplaced })).rejects.toThrow(/L5_ANCHOR_SCOPE/)

    const ok = await svc.compileEntry({ ...TOPIC_FILE })
    expect(ok.anchors).toEqual(["oct-008", "oct-014"])
    expect(ok.path).toBe("topics/prd-impl-workflow.md")
  }, 60_000)

  it("anchor numbers are globally unique — recompiling another page with oct-008 conflicts, and allocation is global max+1", async () => {
    const svc = makeService()
    await seedCorpus(svc)
    await svc.compileEntry({ ...TOPIC_FILE })

    // 另一 topic 页抢 oct-008 → 全库唯一拒写
    const thief = stubPage("top-ci-gates", "topic", "CI 门禁", "门禁纪律")
      .replace("## 桩\n- 票04 形态基座桩页，无规则锚点。\n", "## 硬约束\n- 提交前必须 pnpm test 全绿 <!--#oct-008-->\n")
    await expect(svc.compileEntry({ content: thief })).rejects.toThrow(/ANCHOR_CONFLICT.*oct-008/s)

    // 发号=全库 max+1（盘上锚点 oct-008/014 → 下一号 oct-015）
    const { nextRuleAnchor } = await import("../compile")
    expect(nextRuleAnchor(root)).toBe("oct-015")
  }, 60_000)

  // ── AC1：links 断链校验（编译期，v2 断链纪律保留）──
  it("broken links fail compile: front-matter links and body [[...]] both gate (L5_LINK_BROKEN)", async () => {
    const svc = makeService()
    // 空库直接编英雄实体页：links 指向不存在页 → 断链拒写
    await expect(svc.compileEntry({ ...ENTITY_FILE })).rejects.toThrow(/L5_LINK_BROKEN/s)
    expect(fs.existsSync(path.join(root, "entities", "open-octopus.md"))).toBe(false)

    // 桩库齐备 → 放行（含正文 [[...]] 全命中）
    await seedCorpus(svc)
    const res = await svc.compileEntry({ ...ENTITY_FILE })
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/)
  }, 60_000)

  // ── AC1：正文零日期纪律不变 ──
  it("zero-date discipline unchanged: date in v3 page body rejected", async () => {
    const svc = makeService()
    await seedCorpus(svc)
    const dated = PROTO_ENTITY_PAGE.replace("六包，构建/端口/CI 纪律", "六包（2026-06-23 起）构建/端口/CI 纪律")
    await expect(svc.compileEntry({ ...ENTITY_FILE, content: dated })).rejects.toThrow(/L5_DATES_IN_BODY.*2026-06-23/s)
  }, 60_000)

  // ── AC5：lint L1 容量闸按页；拆分出口=编译失败返回拆分建议，无入队语义 ──
  it("L1 capacity returns a split suggestion on the error — and enqueues nothing", async () => {
    const svc = makeService()
    await seedCorpus(svc)
    const filler = Array.from({ length: 130 }, (_, i) => `- 补充纪律${i + 1}：常青行，无锚点`).join("\n")
    const bloated = PROTO_TOPIC_PAGE
      .replace("oct-008", "oct-030").replace("oct-014", "oct-031")
      .replace("→ 判例：[[case-pnpm-lockfile-mismatch]]", `→ 判例：[[case-pnpm-lockfile-mismatch]]\n${filler}`)
    await expect(svc.compileEntry({ content: bloated, fileName: "prd-impl-workflow.md" })).rejects.toThrow(/L1_CAPACITY.*120/s)

    const { WikiLintError } = await import("../lint")
    try {
      await svc.compileEntry({ content: bloated, fileName: "prd-impl-workflow.md" })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(WikiLintError)
      const suggestion = (err as InstanceType<typeof WikiLintError>).suggestion
      expect(suggestion).toBeDefined()
      expect(suggestion!.entryId).toBe("top-prd-impl")
      expect(suggestion!.children.map(c => c.title)).toEqual(["SOP", "硬约束", "已知陷阱"])
    }

    // 无入队语义：pending_review 零行
    expect((db.prepare("SELECT COUNT(*) AS n FROM pending_review").get() as { n: number }).n).toBe(0)
    // 拒写零痕迹：盘上仍是无锚点桩身
    expect(fs.readFileSync(path.join(root, "topics", "prd-impl-workflow.md"), "utf-8")).not.toContain("oct-030")
  }, 60_000)

  // ── AC2/兼容读面：v2 形态页仍可读（为重蒸馏留路）：scan/INDEX 分组、锚点空间 ──
  it("v2-format pages stay readable: legacy domain page scans into INDEX group and joins anchor space", async () => {
    const svc = makeService()
    await seedCorpus(svc)
    const v2Page = `---
id: prj-legacy
domain: projects
title: 旧域词条
summary: v2 形态兼容读样例
topics: [legacy]
stability: stable
last_compiled: 2026-09-01
sources: [archive:task-1]
confidence: 0.8
---

## 规则
- 旧形态规则行 <!--#oct-021-->
`
    fs.mkdirSync(path.join(root, "projects"), { recursive: true })
    fs.writeFileSync(path.join(root, "projects", "prj-legacy.md"), v2Page, "utf-8")

    await svc.compileEntry({ ...TOPIC_FILE })
    const index = fs.readFileSync(path.join(root, "INDEX.md"), "utf-8")
    // v2 页进映射组（projects→Topics），一行一页
    expect(index).toContain("projects/prj-legacy.md — v2 形态兼容读样例")

    // 锚点空间：新页抢 oct-021 → 冲突拒写（v2 锚点仍在全库唯一空间内）
    const thief = stubPage("top-steal", "topic", "抢锚", "抢 v2 锚点")
      .replace("## 桩\n- 票04 形态基座桩页，无规则锚点。\n", "## 硬约束\n- 抢来的规则 <!--#oct-021-->\n")
    await expect(svc.compileEntry({ content: thief })).rejects.toThrow(/ANCHOR_CONFLICT.*oct-021/s)
  }, 60_000)
})
