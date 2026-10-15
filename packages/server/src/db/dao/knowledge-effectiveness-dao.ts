import type Database from "better-sqlite3"
import { BaseDAO } from "./base"

export interface KnowledgeEffectivenessRow {
  rule_id: string
  cited_count: number
  helpful_count: number
  not_helpful_count: number
  last_cited: string | null
  confidence: number
}

/**
 * KnowledgeEffectivenessDAO — effectiveness v2 记账面（P4 票06 起**消费中**，v55 蓝绿
 * 改名：injected_count→cited_count、last_injected→last_cited；与 schema.sql 表边界注同律）。
 *
 * 写侧 importer = services/knowledge/effectiveness-ledger.ts（执行 JSONL/var_pool 离线
 * 解析记账）。纪律两条：
 * - incrementCited 的时刻由调用方传入（= 被消费执行的落库时刻，非挂钟）——离线重放
 *   确定，夜巡反复跑同结果（红线6）。
 * - incrementHelpful/NotHelpful **只落计数不动 confidence**——confidence 滚动更新
 *   （helpful/(helpful+not_helpful)，DB 真源）是票07 的出口（本票已兑现：
 *   recomputeSufficientConfidences，夜巡 sync 通道触发）；旧「helpful/injected」
 *   公式随注入语义一并废弃，勿复活（表边界注/红线3 同款告诫）。
 */
export class KnowledgeEffectivenessDAO extends BaseDAO {
  constructor(db: Database.Database) {
    super(db)
  }

  upsert(ruleId: string, data: Partial<Omit<KnowledgeEffectivenessRow, 'rule_id'>>): void {
    this.stmt(
      `INSERT INTO knowledge_effectiveness (rule_id, cited_count, helpful_count, not_helpful_count, last_cited, confidence)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(rule_id) DO UPDATE SET
         cited_count = COALESCE(?, cited_count),
         helpful_count = COALESCE(?, helpful_count),
         not_helpful_count = COALESCE(?, not_helpful_count),
         last_cited = COALESCE(?, last_cited),
         confidence = COALESCE(?, confidence)`
    ).run(
      ruleId,
      data.cited_count ?? 0, data.helpful_count ?? 0, data.not_helpful_count ?? 0,
      data.last_cited ?? null, data.confidence ?? 0.5,
      data.cited_count ?? null, data.helpful_count ?? null, data.not_helpful_count ?? null,
      data.last_cited ?? null, data.confidence ?? null
    )
  }

  getByRuleId(ruleId: string): KnowledgeEffectivenessRow | undefined {
    return this.stmt(`SELECT * FROM knowledge_effectiveness WHERE rule_id = ?`).get(ruleId) as KnowledgeEffectivenessRow | undefined
  }

  listAll(): KnowledgeEffectivenessRow[] {
    return this.stmt(`SELECT * FROM knowledge_effectiveness ORDER BY last_cited DESC`).all() as KnowledgeEffectivenessRow[]
  }

  /**
   * 低置信候选筛（票08 僵尸/票07 低置信 finding 的现成取数口）。
   * daysSinceLastCited=0 ⇒ 跳过日期检查（测试缝先例）；>0 ⇒ 与 nowIso（缺省挂钟）
   * 推得的截止时刻字符串比较。
   */
  listStale(minCited: number, maxConfidence: number, daysSinceLastCited: number, nowIso?: string): KnowledgeEffectivenessRow[] {
    if (daysSinceLastCited <= 0) {
      return this.stmt(
        `SELECT * FROM knowledge_effectiveness WHERE cited_count >= ? AND confidence < ?`
      ).all(minCited, maxConfidence) as KnowledgeEffectivenessRow[]
    }
    const base = nowIso ? Date.parse(nowIso) : Date.now()
    const cutoff = new Date(base - daysSinceLastCited * 86400_000).toISOString()
    return this.stmt(
      `SELECT * FROM knowledge_effectiveness
       WHERE cited_count >= ? AND confidence < ? AND (last_cited IS NULL OR last_cited < ?)`
    ).all(minCited, maxConfidence, cutoff) as KnowledgeEffectivenessRow[]
  }

  /** 引用记账：首见建行计 1，再见 +1；last_cited=调用方给定的执行时刻（重放确定）。 */
  incrementCited(ruleId: string, citedAt: string): void {
    this.stmt(
      `INSERT INTO knowledge_effectiveness (rule_id, cited_count, last_cited)
       VALUES (?, 1, ?)
       ON CONFLICT(rule_id) DO UPDATE SET
         cited_count = cited_count + 1,
         last_cited = excluded.last_cited`
    ).run(ruleId, citedAt)
  }

  /** blocker 关联判定落账（LLM seam 裁决后调用）；行必已由 incrementCited 落（同事务先引用后判定）。 */
  incrementHelpful(ruleId: string): void {
    this.stmt(`UPDATE knowledge_effectiveness SET helpful_count = helpful_count + 1 WHERE rule_id = ?`).run(ruleId)
  }

  incrementNotHelpful(ruleId: string): void {
    this.stmt(`UPDATE knowledge_effectiveness SET not_helpful_count = not_helpful_count + 1 WHERE rule_id = ?`).run(ruleId)
  }

  /**
   * P4 票07 confidence 滚动更新出口（DAO 头注纪律所指的那一出口，行级面）：
   * 仅样本充足（helpful+not_helpful ≥ minSamples）行刷 `confidence = ROUND(h/(h+n),3)`；
   * 样本不足行**不动**——保持建行初值（「不抖动」与页快照面同一闸值，
   * 单源在 services/knowledge/effectiveness-confidence.ts 的 CONFIDENCE_MIN_SAMPLES）。
   * 幂等：已收敛行被 `confidence <>` 条件滤出，重跑零写。返回实改行数。
   */
  recomputeSufficientConfidences(minSamples: number): number {
    const r = this.stmt(
      `UPDATE knowledge_effectiveness
       SET confidence = ROUND(helpful_count * 1.0 / (helpful_count + not_helpful_count), 3)
       WHERE helpful_count + not_helpful_count >= ?
         AND confidence <> ROUND(helpful_count * 1.0 / (helpful_count + not_helpful_count), 3)`
    ).run(minSamples)
    return r.changes
  }
}
