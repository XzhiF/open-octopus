import type Database from "better-sqlite3"
import { BaseDAO } from "./base"
import type { CloneRow } from "../types"

/**
 * CloneDAO — agent clone management.
 * Covers: clones table.
 */
export class CloneDAO extends BaseDAO {
  constructor(db: Database.Database) { super(db) }

  findByName(name: string): CloneRow | null {
    return (this.stmt("SELECT * FROM clones WHERE name = ?").get(name) as CloneRow) ?? null
  }

  listByOrg(org: string): CloneRow[] {
    return this.stmt("SELECT * FROM clones WHERE org = ? ORDER BY name ASC").all(org) as CloneRow[]
  }

  listAll(): CloneRow[] {
    return this.stmt("SELECT * FROM clones ORDER BY name ASC").all() as CloneRow[]
  }

  insert(row: CloneRow): Database.RunResult {
    return this.stmt(`
      INSERT INTO clones (name, org, status, persona, skills, workspace_ref, memory_scope, last_active_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.name, row.org, row.status, row.persona,
      row.skills, row.workspace_ref, row.memory_scope,
      row.last_active_at, row.created_at, row.updated_at,
    )
  }

  update(name: string, fields: Partial<CloneRow>): Database.RunResult {
    const sets: string[] = []
    const vals: unknown[] = []
    for (const [k, v] of Object.entries(fields)) {
      if (k === "name") continue
      sets.push(`${k} = ?`)
      vals.push(v)
    }
    if (sets.length === 0) return { changes: 0, lastInsertRowid: 0 }
    sets.push("updated_at = ?")
    vals.push(new Date().toISOString())
    vals.push(name)
    return this.stmt(`UPDATE clones SET ${sets.join(", ")} WHERE name = ?`).run(...vals)
  }

  updateLastActive(name: string): Database.RunResult {
    const now = new Date().toISOString()
    return this.stmt(
      "UPDATE clones SET last_active_at = ?, updated_at = ? WHERE name = ?"
    ).run(now, now, name)
  }

  deleteByName(name: string): Database.RunResult {
    return this.stmt("DELETE FROM clones WHERE name = ?").run(name)
  }
}
