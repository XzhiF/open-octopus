import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../../db/schema"
import { WikiArticleDAO } from "../../db/dao/wiki-article-dao"
import { createWikiRoutes } from "../wiki"

/**
 * S3 缝（routes）：wiki 只读 API 契约测试 — archive-routes.test.ts 先例。
 * 数据由 DAO 直插（路由从 DB 读——DB 是编译服务同步的索引，fs 是真源；
 * 编译链路由 S1 的 wiki-compile.test.ts 覆盖，此处只测 API 契约形状）。
 */

const ORG = "xzf-dev"

function seedRow(dao: WikiArticleDAO, row: { id: string; domain: string; title: string; summary: string; body: string; path: string; topics?: string[]; confidence?: number }) {
  dao.upsert({
    org: ORG,
    id: row.id,
    domain: row.domain,
    title: row.title,
    summary: row.summary,
    topics: JSON.stringify(row.topics ?? []),
    stability: "stable",
    last_compiled: "2026-10-12",
    sources: JSON.stringify(["archive:task-207"]),
    confidence: row.confidence ?? 0.86,
    body: row.body,
    path: row.path,
  })
  const rowid = dao.getRowid(ORG, row.id)!
  dao.insertFts({ rowid, id: row.id, domain: row.domain, title: row.title, summary: row.summary, topics: JSON.stringify(row.topics ?? []), body: row.body })
}

describe("wiki routes (ticket 01: tree + article, read-only)", () => {
  let db: Database.Database
  let dao: WikiArticleDAO

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    dao = new WikiArticleDAO(db)
    seedRow(dao, {
      id: "prj-octopus", domain: "projects", title: "Octopus 平台工程知识",
      summary: "monorepo 构建/测试/端口规则与已知陷阱", topics: ["build", "test"],
      body: "- 修改 shared/ 后必须 pnpm build -w shared 再全量构建 <!--#oct-001-->\n- Promise.allSettled 聚合调用必须设全局超时 <!--#oct-007-->\n",
      path: "projects/prj-octopus.md",
    })
    seedRow(dao, {
      id: "wf-prd-impl", domain: "workflows", title: "prd-impl 工作流经验",
      summary: "P1-P5 分阶段提交", topics: ["sop"],
      body: "- 实现节点按 P1-P5 分阶段提交 <!--#sop-002-->\n",
      path: "workflows/wf-prd-impl.md", confidence: 0.7,
    })
  })

  afterEach(() => {
    db.close()
  })

  describe("GET /tree", () => {
    it("returns the domain tree with entries and counts", async () => {
      const app = createWikiRoutes(dao)
      const res = await app.request(`/tree?org=${ORG}`)
      expect(res.status).toBe(200)
      const data = await res.json()

      expect(data.org).toBe(ORG)
      // 域树：按 WIKI_DOMAINS 顺序只列非空域
      expect(data.domains).toEqual([
        {
          name: "projects", label: "项目知识", count: 1,
          entries: [{
            id: "prj-octopus", path: "projects/prj-octopus.md",
            title: "Octopus 平台工程知识", summary: "monorepo 构建/测试/端口规则与已知陷阱",
            stability: "stable", ruleCount: 2,
          }],
        },
        {
          name: "workflows", label: "工作流知识", count: 1,
          entries: [{
            id: "wf-prd-impl", path: "workflows/wf-prd-impl.md",
            title: "prd-impl 工作流经验", summary: "P1-P5 分阶段提交",
            stability: "stable", ruleCount: 1,
          }],
        },
      ])
      // stats（原型 Tab③ 健康概览的数据面：词条/案例/规则/最近编译/待审核）
      expect(data.stats).toMatchObject({ entries: 2, cases: 0, rules: 3, lastCompiled: "2026-10-12", pendingReview: 0 })
    })

    it("defaults to org 'default' and returns an empty tree for a fresh DB", async () => {
      const app = createWikiRoutes(dao)
      const res = await app.request("/tree")
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.org).toBe("default")
      expect(data.domains).toEqual([])
      expect(data.stats).toMatchObject({ entries: 0, cases: 0, rules: 0 })
    })
  })

  describe("GET /article/:id", () => {
    it("returns body + metadata for an existing entry", async () => {
      const app = createWikiRoutes(dao)
      const res = await app.request(`/article/prj-octopus?org=${ORG}`)
      expect(res.status).toBe(200)
      const data = await res.json()

      expect(data.id).toBe("prj-octopus")
      expect(data.domain).toBe("projects")
      expect(data.title).toBe("Octopus 平台工程知识")
      expect(data.topics).toEqual(["build", "test"])
      expect(data.sources).toEqual(["archive:task-207"])
      expect(data.confidence).toBe(0.86)
      expect(data.stability).toBe("stable")
      expect(data.lastCompiled).toBe("2026-10-12")
      expect(data.path).toBe("projects/prj-octopus.md")
      // 正文含不可见锚点原文 + 解析出的 anchors
      expect(data.body).toContain("<!--#oct-007-->")
      expect(data.anchors).toEqual(["oct-001", "oct-007"])
    })

    it("returns 404 NOT_FOUND for an unknown id", async () => {
      const app = createWikiRoutes(dao)
      const res = await app.request(`/article/prj-nothing?org=${ORG}`)
      expect(res.status).toBe(404)
      const data = await res.json()
      expect(data.error.code).toBe("NOT_FOUND")
    })

    it("rejects malformed ids with 400 INVALID_PARAM (path-traversal safe)", async () => {
      const app = createWikiRoutes(dao)
      // 空段 '/article/' 是路由层 404（缺资源段），非法格式才是 400 —— 三种坏形态都要被闸住
      for (const bad of ["../secrets", "a b", "x%2Fy"]) {
        const res = await app.request(`/article/${encodeURIComponent(bad)}?org=${ORG}`)
        expect(res.status).toBe(400)
        const data = await res.json()
        expect(data.error.code).toBe("INVALID_PARAM")
      }
    })
  })
})
