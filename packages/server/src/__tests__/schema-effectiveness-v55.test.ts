import { describe, it, expect, afterEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"

/**
 * P4 票06 · AC1 表迁移（蓝绿）——knowledge_effectiveness 列义对齐 v2。
 *
 * 判据真相源 = 票面/spec 口径，非实现自述：
 * - injected_count → cited_count（引用计数）、last_injected → last_cited（最近被引用时间）；
 * - 历史行零丢失（蓝绿：RENAME 保数据，不做 DROP+CREATE）；
 * - 游标持久面 = 新表 effectiveness_cursors（记至 execution，重跑幂等的根基）；
 * - 新库/旧库经同一 applySchema 收敛到同形（幂等重跑不变）。
 */

function freshDb(): Database.Database {
  const db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  return db
}

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name)
}

describe("knowledge_effectiveness v2 列面（票06 蓝绿迁移）", () => {
  let db: Database.Database

  afterEach(() => {
    db?.close()
  })

  it("fresh DB：CREATE 直接带 v2 列名（cited_count/last_cited，无旧名）", () => {
    db = freshDb()
    applySchema(db)
    const cols = columns(db, "knowledge_effectiveness")
    expect(cols).toEqual(
      expect.arrayContaining(["rule_id", "cited_count", "helpful_count", "not_helpful_count", "last_cited", "confidence"]),
    )
    expect(cols).not.toContain("injected_count")
    expect(cols).not.toContain("last_injected")
  })

  it("fresh DB：游标表 effectiveness_cursors 存在且记至 execution（PK=execution_id）", () => {
    db = freshDb()
    applySchema(db)
    const cols = columns(db, "effectiveness_cursors")
    expect(cols).toEqual(expect.arrayContaining(["execution_id", "parsed_at"]))
    const pk = (db.prepare("PRAGMA table_info(effectiveness_cursors)").all() as { name: string; pk: number }[]).filter(c => c.pk === 1)
    expect(pk.map(c => c.name)).toEqual(["execution_id"])
    // execution_id 唯一 ⇒ 同执行绝不双记账（幂等根基在表面上先成立）
    db.prepare("INSERT INTO effectiveness_cursors (execution_id, parsed_at) VALUES (?, ?)").run("exec-1", "2026-10-15T00:00:00Z")
    expect(() =>
      db.prepare("INSERT INTO effectiveness_cursors (execution_id, parsed_at) VALUES (?, ?)").run("exec-1", "2026-10-15T00:00:01Z"),
    ).toThrow()
  })

  it("旧库蓝绿：老列名表 + 存量行经 applySchema 改名保数据、重跑幂等", () => {
    db = freshDb()
    // 精确复刻 v54 的旧 DDL（schema.sql:1039-1048 原文，含旧索引）
    db.exec(`CREATE TABLE knowledge_effectiveness (
      rule_id TEXT PRIMARY KEY,
      injected_count INTEGER NOT NULL DEFAULT 0,
      helpful_count INTEGER NOT NULL DEFAULT 0,
      not_helpful_count INTEGER NOT NULL DEFAULT 0,
      last_injected TEXT DEFAULT NULL,
      confidence REAL NOT NULL DEFAULT 0.5
    )`)
    db.exec("CREATE INDEX idx_effectiveness_stale ON knowledge_effectiveness(injected_count, confidence, last_injected)")
    db.prepare(
      "INSERT INTO knowledge_effectiveness (rule_id, injected_count, helpful_count, not_helpful_count, last_injected, confidence) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("oct-001", 3, 1, 1, "2026-10-01 08:00:00", 0.5)

    applySchema(db)

    const cols = columns(db, "knowledge_effectiveness")
    expect(cols).toEqual(
      expect.arrayContaining(["rule_id", "cited_count", "helpful_count", "not_helpful_count", "last_cited", "confidence"]),
    )
    expect(cols).not.toContain("injected_count")
    expect(cols).not.toContain("last_injected")
    // 蓝绿核心：存量行逐字段零丢失（旧注入计数语义行保留为引用计数历史，不伪造清零）
    const row = db.prepare("SELECT * FROM knowledge_effectiveness WHERE rule_id = ?").get("oct-001") as Record<string, unknown>
    expect(row.cited_count).toBe(3)
    expect(row.helpful_count).toBe(1)
    expect(row.not_helpful_count).toBe(1)
    expect(row.last_cited).toBe("2026-10-01 08:00:00")
    expect(row.confidence).toBe(0.5)

    // 旧索引经 RENAME COLUMN 自动改挂新列（可继续查询），且重跑 applySchema 不变形
    const staleRows = db
      .prepare("SELECT rule_id FROM knowledge_effectiveness WHERE cited_count >= 3 AND confidence < 0.9")
      .all() as { rule_id: string }[]
    expect(staleRows.map(r => r.rule_id)).toEqual(["oct-001"])

    applySchema(db)
    expect(columns(db, "knowledge_effectiveness")).toContain("cited_count")
    const row2 = db.prepare("SELECT cited_count FROM knowledge_effectiveness WHERE rule_id = ?").get("oct-001") as { cited_count: number }
    expect(row2.cited_count).toBe(3)
  })

  it("旧库无行：空表迁移同样收敛新列名", () => {
    db = freshDb()
    db.exec(`CREATE TABLE knowledge_effectiveness (
      rule_id TEXT PRIMARY KEY,
      injected_count INTEGER NOT NULL DEFAULT 0,
      helpful_count INTEGER NOT NULL DEFAULT 0,
      not_helpful_count INTEGER NOT NULL DEFAULT 0,
      last_injected TEXT DEFAULT NULL,
      confidence REAL NOT NULL DEFAULT 0.5
    )`)
    applySchema(db)
    const cols = columns(db, "knowledge_effectiveness")
    expect(cols).toContain("cited_count")
    expect(cols).not.toContain("injected_count")
  })

  it("裸库（无 effectiveness 表）：applySchema 直接建新形，迁移函数不炸", () => {
    db = freshDb()
    applySchema(db)
    expect(columns(db, "knowledge_effectiveness")).toContain("cited_count")
    expect(columns(db, "effectiveness_cursors")).toContain("execution_id")
  })
})
