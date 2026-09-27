import type { OrgRow } from "../types"
import { BasePgDAO } from "./base-pg"
import { iso, num } from "./pg-mappers"

/** PG 行的原始形状（orgs.id 为 int8 → postgres.js 给 string；created_at 为 timestamptz → Date）。 */
interface OrgPgRow {
  id: string | number
  name: string
  path: string
  created_at: Date | string
}

function fromRow(r: OrgPgRow): OrgRow {
  return { id: num(r.id), name: r.name, path: r.path, created_at: iso(r.created_at) }
}

/**
 * OrgDAO — organization management. (P1 B1: postgres.js / BasePgDAO)
 * Covers: orgs table.
 */
export class OrgDAO extends BasePgDAO {
  async findAll(): Promise<OrgRow[]> {
    const rows = await this.q<OrgPgRow>("SELECT * FROM orgs ORDER BY name ASC")
    return rows.map(fromRow)
  }

  async findById(id: number): Promise<OrgRow | null> {
    const row = await this.q1<OrgPgRow>("SELECT * FROM orgs WHERE id = ?", [id])
    return row ? fromRow(row) : null
  }

  async findByName(name: string): Promise<OrgRow | null> {
    const row = await this.q1<OrgPgRow>("SELECT * FROM orgs WHERE name = ?", [name])
    return row ? fromRow(row) : null
  }

  async exists(name: string): Promise<boolean> {
    const row = await this.q1<{ one: number }>("SELECT 1 AS one FROM orgs WHERE name = ?", [name])
    return row !== undefined
  }

  /** S3: INSERT OR IGNORE → ON CONFLICT DO NOTHING（orgs.name 唯一约束）。 */
  async insert(row: Omit<OrgRow, "id">): Promise<{ changes: number }> {
    return this.exec(
      "INSERT INTO orgs (name, path, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      [row.name, row.path, row.created_at],
    )
  }

  /** S13: ON CONFLICT DO UPDATE 是 PG 原生语法，零改写。 */
  async upsert(row: Omit<OrgRow, "id">): Promise<{ changes: number }> {
    return this.exec(
      "INSERT INTO orgs (name, path, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET path = excluded.path",
      [row.name, row.path, row.created_at],
    )
  }
}
