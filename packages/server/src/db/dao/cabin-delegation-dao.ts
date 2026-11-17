import type Database from "better-sqlite3"
import { BaseDAO } from "./base"
import type { CabinDelegationRow, CabinDelegationState } from "../types"

/**
 * CabinDelegationDAO — 独立委派（design 25 §4.2）。
 *
 * 与 cabin_jobs 的关系：**账本不合并，视图统一**。cabin_jobs.kind 带 CHECK
 * 约束（task/workflow/subagent），加 'delegate' 需要重建表，与仓库「无迁移路径」
 * 的约定冲突；所以委派有自己的表，读侧归一化成同一种 WorkRow。
 */
export class CabinDelegationDAO extends BaseDAO {
  constructor(db: Database.Database) {
    super(db)
  }

  insert(row: CabinDelegationRow): void {
    this.stmt(`
      INSERT INTO cabin_delegations
        (id, cabin_id, title, intent_text, brief, autonomy, state,
         doer_session_id, result_summary, created_at, updated_at, ended_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      row.id, row.cabin_id, row.title, row.intent_text, row.brief, row.autonomy,
      row.state, row.doer_session_id, row.result_summary,
      row.created_at, row.updated_at, row.ended_at,
    )
  }

  getById(id: string): CabinDelegationRow | undefined {
    return this.stmt("SELECT * FROM cabin_delegations WHERE id = ?")
      .get(id) as CabinDelegationRow | undefined
  }

  listByCabin(cabinId: string): CabinDelegationRow[] {
    return this.stmt(
      "SELECT * FROM cabin_delegations WHERE cabin_id = ? ORDER BY created_at ASC, rowid ASC",
    ).all(cabinId) as CabinDelegationRow[]
  }

  findByDoerSession(sessionId: string): CabinDelegationRow | undefined {
    return this.stmt(
      `SELECT * FROM cabin_delegations WHERE doer_session_id = ?
        ORDER BY created_at DESC LIMIT 1`,
    ).get(sessionId) as CabinDelegationRow | undefined
  }

  updateState(id: string, state: CabinDelegationState, fields: {
    result_summary?: string | null
    ended_at?: string | null
    doer_session_id?: string | null
  } = {}, now = new Date().toISOString()): void {
    const sets = ["state = ?", "updated_at = ?"]
    const params: unknown[] = [state, now]
    if (fields.result_summary !== undefined) { sets.push("result_summary = ?"); params.push(fields.result_summary) }
    if (fields.ended_at !== undefined) { sets.push("ended_at = ?"); params.push(fields.ended_at) }
    if (fields.doer_session_id !== undefined) { sets.push("doer_session_id = ?"); params.push(fields.doer_session_id) }
    params.push(id)
    this.stmt(`UPDATE cabin_delegations SET ${sets.join(", ")} WHERE id = ?`).run(...params)
  }

  setResult(id: string, resultSummary: string | null, now = new Date().toISOString()): void {
    this.stmt(
      "UPDATE cabin_delegations SET result_summary = ?, updated_at = ? WHERE id = ?",
    ).run(resultSummary, now, id)
  }

  /** 舱删除级联（S2 app-level cleanup）。 */
  deleteByCabin(cabinId: string): void {
    this.stmt("DELETE FROM cabin_delegations WHERE cabin_id = ?").run(cabinId)
  }
}
