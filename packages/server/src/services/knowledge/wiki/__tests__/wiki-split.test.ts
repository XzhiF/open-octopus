import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { execFileSync, spawnSync } from "child_process"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../../../../db/schema"
import { WikiCompileService, type GitRunner } from "../compile"
import { WikiSplitService } from "../split"
import { ensureWikiSkeleton } from "../paths"
import { extractRuleAnchors } from "../format"
import { ReviewService } from "../../review"
import { createReviewRoutes } from "../../../../routes/review"
import { PendingReviewDAO } from "../../../../db/dao/pending-review-dao"
import { WikiArticleDAO } from "../../../../db/dao/wiki-article-dao"

/**
 * S1 缝：L2 拆分执行（票02）——提案采纳后文件长大成目录（hub README + 子词条），
 * 锚点跟随迁移，全库引用改写不断链；git 层 mv + split commit；导航 INDEX→hub→子词条 ≤3 跳。
 * Expected 形态/阈值（README ≤40 行）逐字来自 prototype.md Tab③ L2 演进图（lines 584-593）。
 */

const realGit = (cwd: string): GitRunner => ({
  run(args: string[]) {
    // 票06 起 wiki 仓带 pre-commit 写闸：服务通道同款提交来源标记
    const r = spawnSync("git", args, { cwd, timeout: 30000, env: { ...process.env, OCTOPUS_WIKI_COMMIT_SOURCE: "curate" } })
    return { status: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
  },
})

function fm(id: string, domain = "projects", summary = "构造拆分样例词条"): string {
  return `---
id: ${id}
domain: ${domain}
title: ${id} 词条
summary: ${summary}
topics: [split]
stability: stable
last_compiled: 2026-10-12
sources: [fixture:ticket-02]
confidence: 0.9
---
`
}

function pad(body: string, to: number): string {
  const lines = body.split("\n")
  let i = 0
  while (lines.length < to) lines.push(`- 说明${++i}：常青补充行，不携带规则锚点`)
  return lines.join("\n") + "\n"
}

const V1 = fm("prj-big") + `
## Build
- 修改 shared 后先 pnpm build -w shared <!--#oct-501-->
- 构建产物按包提交 <!--#oct-502-->

## Pitfalls
- Promise.allSettled 必须设全局超时 <!--#oct-511-->

## CI
- CI 固定 pnpm 10 <!--#oct-521-->
`

/** 同一词条 v2（125 行）——触顶 L1 → 拒写 + 提案。v1（在盘）与 v2 小节结构一致。 */
const V2_OVER = fm("prj-big") + pad(`
## Build
- 修改 shared 后先 pnpm build -w shared <!--#oct-501-->
- 构建产物按包提交 <!--#oct-502-->

## Pitfalls
- Promise.allSettled 必须设全局超时 <!--#oct-511-->

## CI
- CI 固定 pnpm 10 <!--#oct-521-->
`, 125)

describe("wiki split — L2 拆分执行（hub 目录形态 + 引用不断链 + 三跳封顶）", () => {
  let db: Database.Database
  let tmpDir: string
  let root: string

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-split-"))
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

  it("采纳提案后：hub README(≤40行)+子词条、锚点跟迁移、INDEX 只列 hub、全库引用改写、git split commit", async () => {
    const svc = makeService()
    await svc.compileEntry({ content: V1 })

    // 另一个词条两种链接式引用 + 一个 cases 判例 rule_ref 指锚点
    await svc.compileEntry({
      content: fm("wf-ref", "workflows", "引用了大词条的工作流知识") + `
## 引用
- 构建约束见 [[projects/prj-big]] 与 [[projects/prj-big.md]] <!--#oct-600-->
`,
    })
    await svc.compileEntry({
      content: fm("case-ref", "cases", "判例：引用已蒸馏规则") + `
## 现场
- 症状命中后已蒸馏为 oct-502 <!--#oct-700-->
`,
    })

    // v2 触顶 → 拒写 + 自动提案
    await expect(svc.compileEntry({ content: V2_OVER })).rejects.toThrow(/L1_CAPACITY/s)
    const pdao = new PendingReviewDAO(db)
    const proposal = pdao.getById("wiki-split-testorg-prj-big")
    expect(proposal?.type).toBe("wiki-split")
    expect(proposal?.status).toBe("pending")

    // ── 采纳：ReviewService.approveItem 按 item.type 分发到拆分执行器 ──
    const rsvc = new ReviewService(pdao, {
      applyWikiSplit: (item) => new WikiSplitService({ db, org: "testorg", rootDir: root, git: realGit(root) }).applyProposal(item),
    })
    const r = await rsvc.approveItem("wiki-split-testorg-prj-big", "testorg")
    expect(r.ok).toBe(true)
    expect(pdao.getById("wiki-split-testorg-prj-big")?.status).toBe("approved")

    // ── 目录形态（prototype L2 演进图：hub README + 子词条，规则 id 永不因拆分改变）
    expect(fs.existsSync(path.join(root, "projects", "prj-big.md"))).toBe(false)
    const hub = fs.readFileSync(path.join(root, "projects", "prj-big", "README.md"), "utf-8")
    const build = fs.readFileSync(path.join(root, "projects", "prj-big", "build.md"), "utf-8")
    const pitfalls = fs.readFileSync(path.join(root, "projects", "prj-big", "pitfalls.md"), "utf-8")
    const ci = fs.readFileSync(path.join(root, "projects", "prj-big", "ci.md"), "utf-8")

    // hub ≤40 行（prototype 阈值），每个子词条一行摘要 + 指针
    expect(hub.split("\n").length).toBeLessThanOrEqual(40)
    expect(hub).toContain("[[projects/prj-big/build]]")
    expect(hub).toContain("[[projects/prj-big/pitfalls]]")
    expect(hub).toContain("[[projects/prj-big/ci]]")
    // 锚点跟随规则迁移：oct-501/502 在 build，511 在 pitfalls，521 在 ci
    expect(extractRuleAnchors(build)).toEqual(["oct-501", "oct-502"])
    expect(extractRuleAnchors(pitfalls)).toEqual(["oct-511"])
    expect(extractRuleAnchors(ci)).toEqual(["oct-521"])
    // hub 自身保留无小节规则（preamble 没有则只有指针行）
    expect(extractRuleAnchors(hub)).toEqual([])

    // ── 全库引用改写不断链：两种 wikilink 形态都指向 hub 新路径 ──
    const wf = fs.readFileSync(path.join(root, "workflows", "wf-ref.md"), "utf-8")
    expect(wf).toContain("[[projects/prj-big/README]]")
    expect(wf).not.toMatch(/\[\[projects\/prj-big(\.md)?\]\]/)

    // ── cases rule_ref：锚点在盘上仍可全局解析（跟随迁移）──
    const dao = new WikiArticleDAO(db)
    const allAnchors = [build, pitfalls, ci].flatMap(b => extractRuleAnchors(b))
    expect(allAnchors).toContain("oct-502")
    const caseRow = dao.get("testorg", "case-ref")
    expect(caseRow?.body).toContain("oct-502")

    // ── 导航深度 INDEX→hub→子词条 ≤3 跳：INDEX 只列 hub，子词条经 hub 指针到达 ──
    const index = fs.readFileSync(path.join(root, "INDEX.md"), "utf-8")
    expect(index).toContain("- projects/prj-big/README.md —")
    expect(index).not.toContain("- projects/prj-big/build.md")
    expect(index).not.toContain("- projects/prj-big/pitfalls.md")

    // ── DB：hub 行改路径 + 3 子词条行（id 派生 parent-slug），FTS 覆盖子词条 ──
    const ids = (db.prepare("SELECT id, path FROM wiki_articles WHERE org='testorg' ORDER BY id").all() as Array<{ id: string; path: string }>)
    expect(ids.find(x => x.id === "prj-big")?.path).toBe("projects/prj-big/README.md")
    expect(ids.map(x => x.id)).toEqual(expect.arrayContaining(["prj-big-build", "prj-big-pitfalls", "prj-big-ci"]))
    const ftsHit = db.prepare("SELECT id FROM wiki_fts WHERE wiki_fts MATCH 'Promise'").all() as { id: string }[]
    expect(ftsHit.map(h => h.id)).toContain("prj-big-pitfalls")

    // ── LOG 有 split 行；git 有 split commit ──
    const log = fs.readFileSync(path.join(root, "LOG.md"), "utf-8")
    expect(log).toContain("| split |")
    const gitLog = execFileSync("git", ["log", "--format=%s"], { cwd: root, encoding: "utf-8" })
    expect(gitLog).toContain("split: projects/prj-big.md")
    const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf-8" })
    expect(tracked).toContain("projects/prj-big/README.md")
    expect(tracked).not.toContain("projects/prj-big.md\n")

    // ── hub 条目仍是可重编译词条（票06 策展通道依赖）：带目录路径 fileName ──
    const res = await svc.compileEntry({
      content: fm("prj-big") + `
## 子词条
- [[projects/prj-big/build]] — Build 词条 摘要一行（2 规则）
- [[projects/prj-big/pitfalls]] — Pitfalls 词条 摘要一行（1 规则）
- [[projects/prj-big/ci]] — CI 词条 摘要一行（1 规则）

## 补充
- 拆分后 hub 可再编译 <!--#oct-530-->
`,
      fileName: "prj-big/README.md",
      note: "hub 修订",
    })
    expect(res.path).toBe("projects/prj-big/README.md")
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/)
  })

  it("拆分幂等安全：README 若无法压进 40 行则拒拆并整体回滚（不留半拆形态）", async () => {
    const svc = makeService()
    // 35 个 H2 小节（前 20 个带 1 条规则）：hub 指针 35 行 + front-matter 12 行 + 结构行 > 40
    const many = fm("prj-many") + Array.from({ length: 35 }, (_, i) =>
      `\n## Sec${i}\n${i < 20 ? `- 规则${i} <!--#oct-9${String(i).padStart(2, "0")}-->` : "- 无规则说明行"}`,
    ).join("\n") + "\n"
    await svc.compileEntry({ content: many })
    const pdao = new PendingReviewDAO(db)
    // 手工构造提案（模拟 L1 触顶产物）
    pdao.insert({
      id: "wiki-split-testorg-prj-many", type: "wiki-split", source: "wiki-lint",
      source_ref: "prj-many", source_label: "词条 prj-many 超容量",
      content: JSON.stringify({ kind: "wiki-split", entryId: "prj-many", domain: "projects", path: "projects/prj-many.md", reason: "manual test", hubPath: "projects/prj-many/README.md", children: [] }),
      target_file: "projects/prj-many.md", scope: "wiki", conflicts: null, confidence: 1, auto_approve: 0, status: "pending", user_notes: null,
    })
    const rsvc = new ReviewService(pdao, {
      applyWikiSplit: (item) => new WikiSplitService({ db, org: "testorg", rootDir: root, git: realGit(root) }).applyProposal(item),
    })
    await expect(rsvc.approveItem("wiki-split-testorg-prj-many", "testorg")).rejects.toThrow(/HUB_MAX_LINES|40/)
    await expect(rsvc.approveItem("wiki-split-testorg-prj-many", "testorg")).rejects.toThrow(/HUB_MAX_LINES|40/)
    // 回滚：原文件仍在、无半拆目录
    expect(fs.existsSync(path.join(root, "projects", "prj-many.md"))).toBe(true)
    expect(fs.existsSync(path.join(root, "projects", "prj-many"))).toBe(false)
  })

  it("wiki-split 提案进 /api/review/summary 的 wiki 桶且计入 total（旧 rule 桶不受影响）", async () => {
    const svc = makeService()
    await svc.compileEntry({ content: V1 })
    await expect(svc.compileEntry({ content: V2_OVER })).rejects.toThrow(/L1_CAPACITY/s)

    const pdao = new PendingReviewDAO(db)
    // 混入一条旧 rule 行，验证分桶
    pdao.insert({
      id: "rule-mix-001", type: "rule", source: "workspace_archive", source_ref: "exec-1",
      source_label: "x", content: "y", target_file: "projects/a.md", scope: "project",
      conflicts: null, confidence: 0.5, auto_approve: 0, status: "pending", user_notes: null,
    })

    const app = createReviewRoutes(new ReviewService(pdao), pdao)
    const res = await app.request("/summary")
    expect(res.status).toBe(200)
    const data = await res.json() as Record<string, number>
    expect(data.rules).toBe(1)
    expect(data.skills).toBe(0)
    expect(data.wiki).toBe(1)
    expect(data.total).toBe(2)
    expect(data.statusCounts.pending).toBe(2)
  })
})
