import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { KnowledgeEffectivenessDAO } from "../knowledge-effectiveness-dao"
import { applySchema } from "../../schema"

/**
 * P4 票06：DAO 对齐 effectiveness v2 列面。判据来自票面/spec 口径：
 * - incrementCited 记「引用」——计数 +1 且 last_cited 由调用方给（执行时刻，非挂钟；
 *   离线重放确定性 = 夜巡反复跑同结果的前提）；
 * - incrementHelpful/NotHelpful 只落计数，**不碰 confidence**——滚动更新语义
 *   （confidence = helpful/(helpful+not_helpful)）是票07 的出口，本票抢跑会造
 *   两套真相（旧式 helpful/injected 公式已随注入语义退役，勿复活）；
 * - 历史行宽容读（旧库 RENAME 来的行字段齐全）。
 */
describe("KnowledgeEffectivenessDAO（effectiveness v2 引用记账面）", () => {
  let db: Database.Database
  let dao: KnowledgeEffectivenessDAO

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    dao = new KnowledgeEffectivenessDAO(db)
  })

  afterEach(() => {
    db?.close()
  })

  it("incrementCited：首次建行计 1，再调计 2，last_cited 取调用方时刻", () => {
    dao.incrementCited("oct-001", "2026-10-13T15:46:44.053Z")
    const row = dao.getByRuleId("oct-001")
    expect(row?.cited_count).toBe(1)
    expect(row?.last_cited).toBe("2026-10-13T15:46:44.053Z")

    dao.incrementCited("oct-001", "2026-10-14T08:00:00.000Z")
    const row2 = dao.getByRuleId("oct-001")
    expect(row2?.cited_count).toBe(2)
    expect(row2?.last_cited).toBe("2026-10-14T08:00:00.000Z")
  })

  it("incrementHelpful/NotHelpful：只落计数，confidence 不动（滚动=票07）", () => {
    dao.incrementCited("oct-001", "2026-10-13T15:46:44.053Z")
    dao.incrementCited("oct-001", "2026-10-14T08:00:00.000Z")
    dao.incrementHelpful("oct-001")
    dao.incrementNotHelpful("oct-001")
    dao.incrementNotHelpful("oct-001")

    const row = dao.getByRuleId("oct-001")
    expect(row?.helpful_count).toBe(1)
    expect(row?.not_helpful_count).toBe(2)
    // 独立真相源：confidence 保持建列默认 0.5——本票面绝不重算（旧 helpful/injected
    // 公式已随注入语义废弃；票07 才接管滚动）
    expect(row?.confidence).toBe(0.5)
  })

  it("incrementHelpful 对不存在行 = 零作用（判定只跟随本执行引用先落的行）", () => {
    dao.incrementHelpful("ghost")
    expect(dao.getByRuleId("ghost")).toBeUndefined()
  })

  it("upsert：部分字段 COALESCE 增量语义保留", () => {
    dao.upsert("oct-002", { cited_count: 4, confidence: 0.8 })
    dao.upsert("oct-002", { helpful_count: 2 })
    const row = dao.getByRuleId("oct-002")
    expect(row?.cited_count).toBe(4)
    expect(row?.helpful_count).toBe(2)
    expect(row?.confidence).toBe(0.8)
    expect(row?.last_cited).toBeNull()
  })

  it("listStale 按引用计数/置信/最近引用时间筛（僵尸原料面）", () => {
    // 置信显式造值（本票面 confidence 不自动重算——滚动=票07；筛后语义按列直读）
    dao.incrementCited("zombie", "2026-01-01T00:00:00Z")
    dao.incrementHelpful("zombie")
    dao.incrementNotHelpful("zombie")
    dao.incrementNotHelpful("zombie")
    dao.upsert("zombie", { confidence: 0.3 })
    dao.incrementCited("alive", "2026-10-14T00:00:00Z")
    dao.upsert("alive", { confidence: 0.9 })

    // daysSinceLastCited=0 跳日期检查（测试缝先例保留）
    const stale = dao.listStale(1, 0.6, 0)
    expect(stale.map(r => r.rule_id)).toEqual(["zombie"])

    // 日期闸：以钉死时钟视角，zombie（2026-01-01）距 2026-10-15 超 90 天，alive 未超
    const dated = dao.listStale(1, 0.99, 90, "2026-10-15T00:00:00Z")
    expect(dated.map(r => r.rule_id)).toEqual(["zombie"])
  })

  it("listAll 按 last_cited 倒序", () => {
    dao.incrementCited("old", "2026-09-01T00:00:00Z")
    dao.incrementCited("new", "2026-10-14T00:00:00Z")
    const all = dao.listAll()
    expect(all.map(r => r.rule_id)).toEqual(["new", "old"])
  })
})
