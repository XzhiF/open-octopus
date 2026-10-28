import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../../db/schema"
import { WikiArticleDAO } from "../../db/dao/wiki-article-dao"
import { createWikiRoutes } from "../wiki"

/**
 * 票03 · S3 缝（routes）：wiki search API 契约测试 — archive-routes.test.ts 先例。
 * FTS5 MATCH 主检索 + LIKE 降级（session_memory_fts 同款），返回命中词条/规则锚点
 * 片段与定位（id/path/anchors）。expected 值逐字取自 fixture（独立真相源）。
 */

const ORG = "xzf-dev" // 票03：参数容错保留；seed 钉 global

function seed(dao: WikiArticleDAO, row: {
  id: string; domain: string; title: string; summary: string; body: string; path: string
}) {
  dao.upsert({
    repo_group: "global",
    id: row.id,
    domain: row.domain,
    title: row.title,
    summary: row.summary,
    topics: JSON.stringify(["build"]),
    stability: "stable",
    last_compiled: "2026-10-12",
    sources: JSON.stringify(["archive:task-207"]),
    confidence: 0.86,
    body: row.body,
    path: row.path,
  })
  const rowid = dao.getRowid("global", row.id)!
  dao.insertFts({ rowid, id: row.id, domain: row.domain, title: row.title, summary: row.summary, topics: JSON.stringify(["build"]), body: row.body })
}

function seedFixtures(dao: WikiArticleDAO) {
  seed(dao, {
    id: "prj-octopus", domain: "projects", title: "Octopus 平台工程知识",
    summary: "monorepo 构建/测试/端口规则与已知陷阱",
    body: "- 修改 shared/ 后必须 pnpm build -w shared 再全量构建 <!--#oct-001-->\n- Promise.allSettled 聚合调用必须设全局超时 <!--#oct-007-->\n- 发布流程遵守 P1-P5 分阶段提交 <!--#oct-003-->\n- CI lockfile 版本错配报 LOCKFILE_CONFIG_MISMATCH <!--#oct-013-->\n",
    path: "projects/prj-octopus.md",
  })
  seed(dao, {
    id: "wf-prd-impl", domain: "workflows", title: "prd-impl 工作流经验",
    summary: "P1-P5 分阶段提交",
    body: "- 实现节点按 P1-P5 分阶段提交 <!--#sop-002-->\n",
    path: "workflows/wf-prd-impl.md",
  })
  seed(dao, {
    id: "case-2026-003", domain: "cases", title: "CI 报 LOCKFILE_CONFIG_MISMATCH",
    summary: "pnpm 9 的 CI 读 v10 lockfile 失败",
    body: "## 根因\nlockfile 格式版本与 CLI 版本错配\n## 修复\nCI 升 pnpm 10\n",
    path: "cases/2026-06-23-pnpm-lockfile-mismatch.md",
  })
}

describe("GET /api/knowledge/wiki/search (ticket 03)", () => {
  let db: Database.Database
  let dao: WikiArticleDAO

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    dao = new WikiArticleDAO(db)
    seedFixtures(dao)
  })

  afterEach(() => {
    db.close()
  })

  it("shape + FTS hit: English token hits via MATCH, carries snippet & anchor location", async () => {
    const app = createWikiRoutes(dao)
    const res = await app.request(`/search?q=Promise&org=${ORG}`)
    expect(res.status).toBe(200)
    const data = await res.json()

    expect(data.query).toBe("Promise")
    expect(data.mode).toBe("fts")
    expect(data.results).toHaveLength(1)

    const hit = data.results[0]
    expect(hit.id).toBe("prj-octopus")
    expect(hit.domain).toBe("projects")
    expect(hit.title).toBe("Octopus 平台工程知识")
    // 定位：path + 命中行上的规则锚点
    expect(hit.path).toBe("projects/prj-octopus.md")
    expect(hit.anchors).toEqual(["oct-007"])
    // 片段：命中行原文（去掉不可见锚点注释）
    expect(hit.snippet).toBe("- Promise.allSettled 聚合调用必须设全局超时")
  })

  it("missing q = 400 INVALID_PARAM", async () => {
    const app = createWikiRoutes(dao)
    const res = await app.request(`/search?org=${ORG}`)
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error.code).toBe("INVALID_PARAM")
  })

  it("LIKE fallback: CJK substring that FTS5 cannot token-match still hits via LIKE, mode=like", async () => {
    // unicode61 把 CJK 连续串当一个 token——'超时' 不是独立 token，MATCH 零命中，
    // 必须走 LIKE 降级（session_memory_fts 同款纪律）。fixture 行尾含 '全局超时'。
    const app = createWikiRoutes(dao)
    const res = await app.request(`/search?q=${encodeURIComponent("超时")}&org=${ORG}`)
    expect(res.status).toBe(200)
    const data = await res.json()

    expect(data.mode).toBe("like")
    expect(data.results).toHaveLength(1)
    expect(data.results[0].id).toBe("prj-octopus")
    expect(data.results[0].snippet).toBe("- Promise.allSettled 聚合调用必须设全局超时")
    expect(data.results[0].anchors).toEqual(["oct-007"])
  })

  it("domain=cases filters hits to the cases domain (both fts and like paths)", async () => {
    const app = createWikiRoutes(dao)
    // 'lockfile' 在 prj-octopus 与 case-2026-003 都存在（FTS 可 token 命中）
    const all = await (await app.request(`/search?q=lockfile&org=${ORG}`)).json()
    expect(all.mode).toBe("fts")
    expect(all.results.map((r: { id: string }) => r.id).sort()).toEqual(["case-2026-003", "prj-octopus"])

    const casesOnly = await (await app.request(`/search?q=lockfile&org=${ORG}&domain=cases`)).json()
    expect(casesOnly.results).toHaveLength(1)
    expect(casesOnly.results[0].id).toBe("case-2026-003")
    expect(casesOnly.results[0].domain).toBe("cases")

    // 降级路径同样受 domain 约束：CJK 子串只在 case 正文出现
    const cjk = await (await app.request(`/search?q=${encodeURIComponent("错配")}&org=${ORG}&domain=workflows`)).json()
    expect(cjk.mode).toBe("like")
    expect(cjk.results).toHaveLength(0)
    const cjkCase = await (await app.request(`/search?q=${encodeURIComponent("错配")}&org=${ORG}&domain=cases`)).json()
    expect(cjkCase.results.map((r: { id: string }) => r.id)).toEqual(["case-2026-003"])
  })

  it("topK caps the result count", async () => {
    const app = createWikiRoutes(dao)
    const data = await (await app.request(`/search?q=lockfile&org=${ORG}&topK=1`)).json()
    expect(data.results).toHaveLength(1)
  })

  it("bad FTS5 syntax degrades to LIKE instead of 500 (session_memory_fts 同款容错)", async () => {
    const app = createWikiRoutes(dao)
    // 孤立双引号会让 FTS5 MATCH 抛语法错——降级 LIKE 后按字面子串处理
    const res = await app.request(`/search?q=${encodeURIComponent('"')}&org=${ORG}`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.mode).toBe("like")
    expect(data.results).toEqual([])
  })
})
