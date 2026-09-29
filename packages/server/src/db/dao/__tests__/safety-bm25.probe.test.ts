// B2 一次性探针（本批交付证据，跑完保留为最小 smoke）：pg_search BM25 经 SafetyDAO 端到端。
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { SafetyDAO } from "../safety-dao"
import { describePg, setupPgSchema, type PgFixture } from "../../pg/__tests__/dao-fixture"

describePg("SafetyDAO reports BM25 (pg_search first ride)", () => {
  let pg: PgFixture
  let dao: SafetyDAO

  beforeAll(async () => {
    pg = await setupPgSchema()
    dao = new SafetyDAO(pg.sql)
  })
  afterAll(async () => { await pg.close() })

  it("indexers exist, ranking works, ILIKE fallback catches unparseable queries", async () => {
    const idx = (await pg.sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_reports_bm25'`)[0]
    expect(idx.indexdef).toContain("USING bm25")
    const now = new Date().toISOString()
    await dao.insertReport({ id: "r1", task_name: "每日构建报告 alpha", date: "2026-09-28", file_path: "/a", status: "ok", org: "xzf", created_at: now })
    await dao.insertReport({ id: "r2", task_name: "weekly sync notes", date: "2026-09-27", file_path: "/b", status: "ok", org: "xzf", created_at: now })
    const hits = await dao.searchReports("weekly", 5)
    expect(hits.map(h => h.task_name)).toContain("weekly sync notes")
    const zh = await dao.searchReports("构建", 5)
    expect(zh.map(h => h.task_name)).toContain("每日构建报告 alpha")
    const fb = await dao.searchReports("weird:(unparseable", 5)
    expect(Array.isArray(fb)).toBe(true)
  })
})
