import type Database from "better-sqlite3"
import { BaseDAO } from "./base"

export interface KnowledgeEffectivenessRow {
  rule_id: string
  injected_count: number
  helpful_count: number
  not_helpful_count: number
  last_injected: string | null
  confidence: number
}

export class KnowledgeEffectivenessDAO extends BaseDAO {
  constructor(db: Database.Database) {
    super(db)
  }

  upsert(ruleId: string, data: Partial<Omit<KnowledgeEffectivenessRow, 'rule_id'>>): void {
    this.stmt(
      `INSERT INTO knowledge_effectiveness (rule_id, injected_count, helpful_count, not_helpful_count, last_injected, confidence)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(rule_id) DO UPDATE SET
         injected_count = COALESCE(?, injected_count),
         helpful_count = COALESCE(?, helpful_count),
         not_helpful_count = COALESCE(?, not_helpful_count),
         last_injected = COALESCE(?, last_injected),
         confidence = COALESCE(?, confidence)`
    ).run(
      ruleId,
      data.injected_count ?? 0, data.helpful_count ?? 0, data.not_helpful_count ?? 0,
      data.last_injected ?? null, data.confidence ?? 0.5,
      data.injected_count ?? null, data.helpful_count ?? null, data.not_helpful_count ?? null,
      data.last_injected ?? null, data.confidence ?? null
    )
  }

  getByRuleId(ruleId: string): KnowledgeEffectivenessRow | undefined {
    return this.stmt(`SELECT * FROM knowledge_effectiveness WHERE rule_id = ?`).get(ruleId) as KnowledgeEffectivenessRow | undefined
  }

  listAll(): KnowledgeEffectivenessRow[] {
    return this.stmt(`SELECT * FROM knowledge_effectiveness ORDER BY last_injected DESC`).all() as KnowledgeEffectivenessRow[]
  }

  listStale(minInjected: number, maxConfidence: number, daysSinceLastInjected: number): KnowledgeEffectivenessRow[] {
    // ponytail: when daysSinceLastInjected=0, skip date check (for testing)
    return this.stmt(
      `SELECT * FROM knowledge_effectiveness
       WHERE injected_count >= ?
         AND confidence < ?
         AND (? <= 0 OR last_injected < datetime('now', '-' || ? || ' days'))`
    ).all(minInjected, maxConfidence, daysSinceLastInjected, daysSinceLastInjected) as KnowledgeEffectivenessRow[]
  }

  incrementInjected(ruleId: string): void {
    this.stmt(
      `INSERT INTO knowledge_effectiveness (rule_id, injected_count, last_injected)
       VALUES (?, 1, datetime('now'))
       ON CONFLICT(rule_id) DO UPDATE SET
         injected_count = injected_count + 1,
         last_injected = datetime('now')`
    ).run(ruleId)
  }

  incrementHelpful(ruleId: string): void {
    this.stmt(
      `UPDATE knowledge_effectiveness SET
         helpful_count = helpful_count + 1,
         confidence = CASE WHEN injected_count > 0 THEN ROUND(CAST(helpful_count + 1 AS REAL) / injected_count, 3) ELSE confidence END
       WHERE rule_id = ?`
    ).run(ruleId)
  }

  incrementNotHelpful(ruleId: string): void {
    this.stmt(
      `UPDATE knowledge_effectiveness SET
         not_helpful_count = not_helpful_count + 1,
         confidence = CASE WHEN injected_count > 0 THEN ROUND(CAST(helpful_count AS REAL) / injected_count, 3) ELSE confidence END
       WHERE rule_id = ?`
    ).run(ruleId)
  }
}
