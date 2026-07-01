import type Database from "better-sqlite3"
import { BaseDAO } from "./base"

export interface KnowledgeRuleRow {
  rule_id: string
  file_name: string
  text: string
  scope: string
  source: string
  created_at: string
  status: string
}

export class KnowledgeRuleDAO extends BaseDAO {
  constructor(db: Database.Database) {
    super(db)
  }

  insert(rule: Omit<KnowledgeRuleRow, 'created_at'>): void {
    this.stmt(
      `INSERT OR REPLACE INTO knowledge_rules (rule_id, file_name, text, scope, source, status)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(rule.rule_id, rule.file_name, rule.text, rule.scope, rule.source, rule.status ?? 'active')
  }

  getById(ruleId: string): KnowledgeRuleRow | undefined {
    return this.stmt(`SELECT * FROM knowledge_rules WHERE rule_id = ?`).get(ruleId) as KnowledgeRuleRow | undefined
  }

  listByScope(scope: string): KnowledgeRuleRow[] {
    return this.stmt(`SELECT * FROM knowledge_rules WHERE scope = ? AND status = 'active'`).all(scope) as KnowledgeRuleRow[]
  }

  listByFile(fileName: string): KnowledgeRuleRow[] {
    return this.stmt(`SELECT * FROM knowledge_rules WHERE file_name = ? ORDER BY created_at DESC`).all(fileName) as KnowledgeRuleRow[]
  }

  updateStatus(ruleId: string, status: string): void {
    this.stmt(`UPDATE knowledge_rules SET status = ? WHERE rule_id = ?`).run(status, ruleId)
  }

  listActive(): KnowledgeRuleRow[] {
    return this.stmt(`SELECT * FROM knowledge_rules WHERE status = 'active' ORDER BY created_at DESC`).all() as KnowledgeRuleRow[]
  }

  searchByText(query: string): KnowledgeRuleRow[] {
    return this.stmt(`SELECT * FROM knowledge_rules WHERE text LIKE ? AND status = 'active'`).all(`%${query}%`) as KnowledgeRuleRow[]
  }

  listActiveByFilePrefix(prefix: string): KnowledgeRuleRow[] {
    return this.stmt(
      `SELECT * FROM knowledge_rules WHERE status = 'active' AND file_name LIKE ? ORDER BY created_at DESC`
    ).all(`${prefix}%`) as KnowledgeRuleRow[]
  }
}
