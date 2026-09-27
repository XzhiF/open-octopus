import { BasePgDAO, type PgSql } from "./base-pg"

export interface KnowledgeEffectivenessRow {
  rule_id: string
  injected_count: number
  helpful_count: number
  not_helpful_count: number
  last_injected: string | null
  confidence: number
}

/**
 * P1 B2：better-sqlite3 → postgres.js。
 *   - datetime('now') → now()；last_injected 列 PG timestamptz，读侧 to_char 归
 *     ISO 文本（行契约 string|null 不变）。
 *   - 「N 天前」窗口：SQLite datetime('now','-'||?||' days') → PG
 *     now() - ?::int * interval '1 day'。
 *   - ROUND(CAST(… AS REAL),3)：PG round(double,int) 不存在 → 先 ::numeric 再
 *     round(…,3)，写回 double precision 列；读出仍 number（S12 方言点位）。
 *   - ON CONFLICT DO UPDATE（S13）：PG 原生，零改写；COALESCE(?) 里的 NULL
 *     参数经 postgres.js 原生绑定（非 'null' 文本）。
 */
const TS = (col: string) =>
  `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

const KE_COLS = `rule_id, injected_count, helpful_count, not_helpful_count,
  ${TS("last_injected")} AS last_injected, confidence`

export class KnowledgeEffectivenessDAO extends BasePgDAO {
  constructor(db: PgSql) {
    super(db)
  }

  upsert(ruleId: string, data: Partial<Omit<KnowledgeEffectivenessRow, 'rule_id'>>): Promise<{ changes: number }> {
    return this.exec(
      `INSERT INTO knowledge_effectiveness (rule_id, injected_count, helpful_count, not_helpful_count, last_injected, confidence)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(rule_id) DO UPDATE SET
         -- PG 与 SQLite 的语义分歧点：DO UPDATE 的 SET 表达式里裸列名会同时匹配
         -- excluded./原行 —— PG 直接报 ambiguous，必须显式限定原表名（SQLite 宽容）。
         injected_count = COALESCE(?, knowledge_effectiveness.injected_count),
         helpful_count = COALESCE(?, knowledge_effectiveness.helpful_count),
         not_helpful_count = COALESCE(?, knowledge_effectiveness.not_helpful_count),
         last_injected = COALESCE(?, knowledge_effectiveness.last_injected),
         confidence = COALESCE(?, knowledge_effectiveness.confidence)`,
      [
        ruleId,
        data.injected_count ?? 0, data.helpful_count ?? 0, data.not_helpful_count ?? 0,
        data.last_injected ?? null, data.confidence ?? 0.5,
        data.injected_count ?? null, data.helpful_count ?? null, data.not_helpful_count ?? null,
        data.last_injected ?? null, data.confidence ?? null,
      ],
    )
  }

  getByRuleId(ruleId: string): Promise<KnowledgeEffectivenessRow | undefined> {
    return this.q1<KnowledgeEffectivenessRow>(`SELECT ${KE_COLS} FROM knowledge_effectiveness WHERE rule_id = ?`, [ruleId])
  }

  listAll(): Promise<KnowledgeEffectivenessRow[]> {
    // SQLite DESC 把 NULL 排最后，PG DESC 默认把 NULL 排最前 —— NULLS LAST 对齐旧序。
    return this.q<KnowledgeEffectivenessRow>(`SELECT ${KE_COLS} FROM knowledge_effectiveness ORDER BY last_injected DESC NULLS LAST`)
  }

  listStale(minInjected: number, maxConfidence: number, daysSinceLastInjected: number): Promise<KnowledgeEffectivenessRow[]> {
    // ponytail: when daysSinceLastInjected=0, skip date check (for testing)
    return this.q<KnowledgeEffectivenessRow>(
      `SELECT ${KE_COLS} FROM knowledge_effectiveness
       WHERE injected_count >= ?
         AND confidence < ?
         AND (? <= 0 OR last_injected < now() - ?::int * interval '1 day')`,
      [minInjected, maxConfidence, daysSinceLastInjected, daysSinceLastInjected],
    )
  }

  incrementInjected(ruleId: string): Promise<{ changes: number }> {
    return this.exec(
      `INSERT INTO knowledge_effectiveness (rule_id, injected_count, last_injected)
       VALUES (?, 1, now())
       ON CONFLICT(rule_id) DO UPDATE SET
         injected_count = knowledge_effectiveness.injected_count + 1,
         last_injected = now()`,
      [ruleId],
    )
  }

  incrementHelpful(ruleId: string): Promise<{ changes: number }> {
    return this.exec(
      `UPDATE knowledge_effectiveness SET
         helpful_count = helpful_count + 1,
         confidence = CASE WHEN injected_count > 0 THEN round((helpful_count + 1)::numeric / injected_count, 3)::double precision ELSE confidence END
       WHERE rule_id = ?`,
      [ruleId],
    )
  }

  incrementNotHelpful(ruleId: string): Promise<{ changes: number }> {
    return this.exec(
      `UPDATE knowledge_effectiveness SET
         not_helpful_count = not_helpful_count + 1,
         confidence = CASE WHEN injected_count > 0 THEN round(helpful_count::numeric / injected_count, 3)::double precision ELSE confidence END
       WHERE rule_id = ?`,
      [ruleId],
    )
  }
}
