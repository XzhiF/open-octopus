import { describe, it, expect, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../schema"
import { PendingReviewDAO } from "../dao/pending-review-dao"

/**
 * countPendingOpen — pending_review「待结案」计数（pending+deferred）的单一来源
 * （评审去重：同文 SQL 曾散落 compile.ts/split.ts/routes/wiki.ts 三处）。
 */

const baseRow = {
  type: "rule", source: "workspace_archive", source_ref: "exec-1", source_label: "t",
  content: "c", target_file: "projects/a.md", scope: "project", conflicts: null,
  confidence: 0.5, auto_approve: 0, user_notes: null,
}

describe("PendingReviewDAO.countPendingOpen", () => {
  let dao: PendingReviewDAO
  let db: Database.Database

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    dao = new PendingReviewDAO(db)
  })

  it("pending 与 deferred 计入，approved/rejected 不计；空表 = 0", () => {
    expect(dao.countPendingOpen()).toBe(0)
    dao.insert({ ...baseRow, id: "p1", status: "pending" })
    dao.insert({ ...baseRow, id: "d1", status: "deferred" })
    dao.insert({ ...baseRow, id: "a1", status: "approved" })
    dao.insert({ ...baseRow, id: "r1", status: "rejected" })
    expect(dao.countPendingOpen()).toBe(2)
  })

  it("跨类型都计（rule/wiki-split/wiki-edit 不分桶——INDEX 预算与树健康条同口径）", () => {
    dao.insert({ ...baseRow, id: "w1", type: "wiki-split", scope: "wiki", status: "pending" })
    dao.insert({ ...baseRow, id: "w2", type: "wiki-edit", scope: "wiki", status: "deferred" })
    dao.insert({ ...baseRow, id: "r2", status: "pending" })
    expect(dao.countPendingOpen()).toBe(3)
  })
})
