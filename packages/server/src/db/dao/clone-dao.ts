import type { CloneRow } from "../types"
import { BasePgDAO } from "./base-pg"
import { iso, isoOrNull, jsonStr } from "./pg-mappers"

/**
 * CloneDAO — agent clone management. (P1 B1: postgres.js / BasePgDAO)
 * Covers: clones table.
 *
 * 方言差异（DAO 出口归一，见 pg-mappers.ts）：
 *   - skills / workspace_ref: PG jsonb ↔ 旧 JSON 文本
 *   - memory_scope: PG 侧即 text（B0 刻意未转 jsonb，无归一需求）
 *   - last_active_at/created_at/updated_at: timestamptz ↔ ISO 文本
 */

interface ClonePgRow {
  name: string
  org: string
  type: string
  status: string
  persona: string
  skills: unknown
  workspace_ref: unknown
  memory_scope: string
  last_active_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
  current_version_id?: string | null
}

function fromRow(r: ClonePgRow): CloneRow {
  return {
    name: r.name,
    org: r.org,
    type: r.type,
    status: r.status,
    persona: r.persona,
    skills: jsonStr(r.skills) ?? "[]",
    workspace_ref: jsonStr(r.workspace_ref) ?? "{}",
    memory_scope: r.memory_scope,
    last_active_at: isoOrNull(r.last_active_at),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  }
}

/** update() 的动态 SET 白名单 —— 列名不允许从任意对象键流入 SQL。 */
const CLONE_UPDATABLE = new Set<keyof CloneRow>([
  "org", "type", "status", "persona", "skills", "workspace_ref",
  "memory_scope", "last_active_at", "created_at", "updated_at",
])

export class CloneDAO extends BasePgDAO {
  async findByName(name: string): Promise<CloneRow | null> {
    const row = await this.q1<ClonePgRow>("SELECT * FROM clones WHERE name = ?", [name])
    return row ? fromRow(row) : null
  }

  async listByOrg(org: string): Promise<CloneRow[]> {
    const rows = await this.q<ClonePgRow>("SELECT * FROM clones WHERE org = ? ORDER BY name ASC", [org])
    return rows.map(fromRow)
  }

  async listAll(): Promise<CloneRow[]> {
    const rows = await this.q<ClonePgRow>("SELECT * FROM clones ORDER BY name ASC")
    return rows.map(fromRow)
  }

  async insert(row: Omit<CloneRow, "type"> & { type?: string }): Promise<{ changes: number }> {
    return this.exec(`
      INSERT INTO clones (name, org, type, status, persona, skills, workspace_ref, memory_scope, last_active_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      row.name, row.org, row.type ?? 'user', row.status, row.persona,
      row.skills, row.workspace_ref, row.memory_scope,
      row.last_active_at, row.created_at, row.updated_at,
    ])
  }

  async update(name: string, fields: Partial<CloneRow>): Promise<{ changes: number }> {
    const sets: string[] = []
    const vals: unknown[] = []
    for (const [k, v] of Object.entries(fields)) {
      if (k === "name") continue
      if (!CLONE_UPDATABLE.has(k as keyof CloneRow)) continue
      // 同 ChatDAO.updateSession：SQLite 重复 SET 列后者胜，PG 报 multiple assignments
      // —— 跳过调用方 updated_at，保留末尾自动值，语义对齐。
      if (k === "updated_at") continue
      sets.push(`${k} = ?`)
      vals.push(v)
    }
    if (sets.length === 0 && !Object.keys(fields).some((k) => k === "updated_at")) return { changes: 0 }
    sets.push("updated_at = ?")
    vals.push(new Date().toISOString())
    vals.push(name)
    return this.exec(`UPDATE clones SET ${sets.join(", ")} WHERE name = ?`, vals)
  }

  async updateLastActive(name: string): Promise<{ changes: number }> {
    const now = new Date().toISOString()
    return this.exec(
      "UPDATE clones SET last_active_at = ?, updated_at = ? WHERE name = ?",
      [now, now, name],
    )
  }

  async deleteByName(name: string): Promise<{ changes: number }> {
    return this.exec("DELETE FROM clones WHERE name = ?", [name])
  }
}
