import type Database from "better-sqlite3"
import { BaseDAO } from "./base"
import type { OrgRow } from "../types"

/**
 * OrgDAO — organization management.
 * Covers: orgs table.
 */
export class OrgDAO extends BaseDAO {
  constructor(db: Database.Database) { super(db) }

  findAll(): OrgRow[] {
    return this.stmt("SELECT * FROM orgs ORDER BY name ASC").all() as OrgRow[]
  }

  findById(id: number): OrgRow | null {
    return (this.stmt("SELECT * FROM orgs WHERE id = ?").get(id) as OrgRow) ?? null
  }

  findByName(name: string): OrgRow | null {
    return (this.stmt("SELECT * FROM orgs WHERE name = ?").get(name) as OrgRow) ?? null
  }

  exists(name: string): boolean {
    const row = this.stmt("SELECT 1 FROM orgs WHERE name = ?").get(name)
    return row !== undefined
  }

  insert(row: Omit<OrgRow, "id">): Database.RunResult {
    return this.stmt(
      "INSERT OR IGNORE INTO orgs (name, path, created_at) VALUES (?, ?, ?)"
    ).run(row.name, row.path, row.created_at)
  }

  upsert(row: Omit<OrgRow, "id">): Database.RunResult {
    return this.stmt(
      "INSERT INTO orgs (name, path, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET path = excluded.path"
    ).run(row.name, row.path, row.created_at)
  }
}
