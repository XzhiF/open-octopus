import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../../schema"
import { FindingsDAO, type FindingUpsert } from "../findings-dao"

/**
 * 票05 · findings 持久最小面（v53 纯增量新表）DAO 测试。
 * 契约（票面 AC3 + spec §审批废除「findings 报对话裁决」）：本票只产不裁——
 * 写入/查询/状态迁移三缝；status 三态 open/resolved/ignored（裁决消费属票13）。
 * 先例：wiki-schema.test.ts（v52 纯增量：applySchema 幂等、重跑不丢行）。
 */

const CONTRADICTION: FindingUpsert = {
  id: "fnd-20261013-aaaaaaaaaaaa",
  kind: "contradiction",
  title: "topics/old 断言 vs 新源断言冲突",
  detail: JSON.stringify({ old_claim: "规则由引擎预计算注入", new_claim: "应编译成 wiki 按需查阅" }),
  pages: JSON.stringify(["topics/knowledge-injection.md", "concepts/compiled-rag.md"]),
  raw_ref: "raw/inbox/2026-10-13-karpathy-llm-wiki.md",
  source: "compile",
}

describe("FindingsDAO — 票05 finding 最小面（v53）", () => {
  let db: Database.Database
  let dao: FindingsDAO

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    dao = new FindingsDAO(db)
  })

  afterEach(() => {
    db?.close()
  })

  it("inserts a contradiction finding and reads it back with open status", () => {
    dao.upsert(CONTRADICTION)
    const row = dao.getById(CONTRADICTION.id)
    expect(row?.kind).toBe("contradiction")
    expect(row?.status).toBe("open")
    expect(row?.raw_ref).toBe("raw/inbox/2026-10-13-karpathy-llm-wiki.md")
    expect(JSON.parse(row!.pages)).toEqual(["topics/knowledge-injection.md", "concepts/compiled-rag.md"])
    expect(dao.countOpen()).toBe(1)
  })

  it("upsert is idempotent (no duplicate rows) and preserves a human-adjudicated status", () => {
    dao.upsert(CONTRADICTION)
    dao.updateStatus(CONTRADICTION.id, "ignored")
    dao.upsert(CONTRADICTION) // 重编译再现同一矛盾：不重复建行、不回滚人的裁决
    expect(dao.list("open")).toHaveLength(0)
    expect(dao.list("ignored")).toHaveLength(1)
    expect(dao.getById(CONTRADICTION.id)?.status).toBe("ignored")
  })

  it("applies schema idempotently — re-run keeps findings rows (v53 additive, 不丢行)", () => {
    dao.upsert(CONTRADICTION)
    applySchema(db)
    expect(dao.getById(CONTRADICTION.id)).toBeDefined()
  })

  it("rejects an unknown status via CHECK constraint（三态预留）", () => {
    dao.upsert(CONTRADICTION)
    expect(() => dao.updateStatus(CONTRADICTION.id, "approved" as never)).toThrow(/CHECK constraint/i)
  })
})
