import type Database from "better-sqlite3"
import { BaseDAO } from "./base"
import type {
  CabinRow, CabinJobRow, CabinJobEventRow, CabinStatus,
} from "../types"

/**
 * CabinDAO — directory-bound long-lived cockpit.
 * Cross-domain links follow S2 (no FK); the four link columns are backfilled on
 * existing DBs here (single place, mirrors archive-draft-dao), fresh DBs get them
 * from schema.sql CREATE bodies.
 */
export class CabinDAO extends BaseDAO {
  constructor(db: Database.Database) {
    super(db)
    try { db.exec("ALTER TABLE workspaces ADD COLUMN cabin_id TEXT") } catch {}
    try { db.exec("ALTER TABLE tasks ADD COLUMN cabin_id TEXT") } catch {}
    try { db.exec("ALTER TABLE sessions ADD COLUMN cabin_id TEXT") } catch {}
    // 软删除列（2026-11-15）。index.ts 里 DAO 先于 applySchema 构造，新库这里会
    // 静默失败（表还没建），由 schema.sql 建 —— 两种情况都要能跑。
    try { db.exec("ALTER TABLE cabins ADD COLUMN deleted_at TEXT") } catch {}
    // 老库的 ux_cabins_path 是全表唯一：软删的行还占着 path，同目录就再也建不了
    // 新舱。换成只约束活行的部分索引（schema.sql 里也是这一版）。
    try {
      db.exec("DROP INDEX IF EXISTS ux_cabins_path")
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_cabins_path ON cabins(path) WHERE deleted_at IS NULL")
    } catch { /* fresh DB: 表还没建，schema.sql 负责 */ }
  }

  insert(row: CabinRow): void {
    this.stmt(`
      INSERT INTO cabins (id, name, path, workspace_id, main_session_id, requirements, status,
        mainline_strategy, org, init_state, cockpit_prefs, focused_job_id, version,
        created_at, updated_at, last_active_at, archived_at, deleted_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      row.id, row.name, row.path, row.workspace_id, row.main_session_id, row.requirements, row.status,
      row.mainline_strategy, row.org, row.init_state, row.cockpit_prefs, row.focused_job_id, row.version,
      row.created_at, row.updated_at, row.last_active_at, row.archived_at, row.deleted_at,
    )
  }

  /** 活着的舱。软删的行对调用方不存在（404 / 可重建同目录新舱）。 */
  findById(id: string): CabinRow | undefined {
    return this.stmt("SELECT * FROM cabins WHERE id = ? AND deleted_at IS NULL").get(id) as CabinRow | undefined
  }

  /** 含软删（attach 从 .cabin/manifest.json 复原身份时要看得到墓碑行）。 */
  findAnyById(id: string): CabinRow | undefined {
    return this.stmt("SELECT * FROM cabins WHERE id = ?").get(id) as CabinRow | undefined
  }

  findByPath(path: string): CabinRow | undefined {
    return this.stmt("SELECT * FROM cabins WHERE path = ? AND deleted_at IS NULL").get(path) as CabinRow | undefined
  }

  list(status?: CabinStatus): CabinRow[] {
    if (status) {
      return this.stmt("SELECT * FROM cabins WHERE status = ? AND deleted_at IS NULL ORDER BY created_at DESC")
        .all(status) as CabinRow[]
    }
    return this.stmt("SELECT * FROM cabins WHERE deleted_at IS NULL ORDER BY created_at DESC").all() as CabinRow[]
  }

  updateStatus(id: string, status: CabinStatus, now: string): void {
    this.stmt("UPDATE cabins SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id)
  }

  bindWorkspace(id: string, workspaceId: string, now: string): void {
    this.stmt("UPDATE cabins SET workspace_id = ?, updated_at = ? WHERE id = ?").run(workspaceId, now, id)
  }

  bindSession(id: string, sessionId: string, now: string): void {
    this.stmt("UPDATE cabins SET main_session_id = ?, updated_at = ? WHERE id = ?").run(sessionId, now, id)
  }

  /** Optimistic-lock field update; returns false on version conflict. */
  updateFields(id: string, expectedVersion: number, fields: Partial<Pick<CabinRow,
    "name" | "requirements" | "mainline_strategy" | "org" | "init_state" | "cockpit_prefs" | "focused_job_id" | "last_active_at" | "archived_at"
  >>, now: string): boolean {
    const sets: string[] = []
    const vals: unknown[] = []
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue
      sets.push(`${k} = ?`)
      vals.push(v)
    }
    if (!sets.length) return true
    sets.push("version = version + 1", "updated_at = ?")
    vals.push(now, id, expectedVersion)
    const res = this.stmt(`UPDATE cabins SET ${sets.join(", ")} WHERE id = ? AND version = ?`).run(...vals)
    return res.changes > 0
  }

  delete(id: string): void {
    this.stmt("DELETE FROM cabins WHERE id = ?").run(id)
  }

  /** 软删除：行留在表里（计费 / Trace / 验收历史不丢），只是不再算「活着的舱」。 */
  softDelete(id: string, now: string): void {
    this.stmt("UPDATE cabins SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?")
      .run(now, now, id)
  }

  /** 从墓碑行复原（attach 读到 .cabin/manifest.json 的 id，但本地已软删过）。 */
  revive(id: string, fields: Partial<Pick<CabinRow,
    "name" | "path" | "status" | "requirements" | "org" | "mainline_strategy"
  >>, now: string): void {
    const sets: string[] = ["deleted_at = NULL", "version = version + 1", "updated_at = ?"]
    const vals: unknown[] = [now]
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue
      sets.push(`${k} = ?`)
      vals.push(v)
    }
    vals.push(id)
    this.stmt(`UPDATE cabins SET ${sets.join(", ")} WHERE id = ?`).run(...vals)
  }

  // ── jobs (dispatch ledger; status derived elsewhere, K3) ──
  insertJob(row: CabinJobRow): void {
    this.stmt(`INSERT INTO cabin_jobs (id, cabin_id, kind, ref_id, session_id, title, mandate, prompt, priority, created_at, ended_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, row.cabin_id, row.kind, row.ref_id, row.session_id, row.title, row.mandate, row.prompt, row.priority, row.created_at, row.ended_at)
  }

  findJob(id: string): CabinJobRow | undefined {
    return this.stmt("SELECT * FROM cabin_jobs WHERE id = ?").get(id) as CabinJobRow | undefined
  }

  findJobByRef(cabinId: string, refId: string): CabinJobRow | undefined {
    return this.stmt("SELECT * FROM cabin_jobs WHERE cabin_id = ? AND ref_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(cabinId, refId) as CabinJobRow | undefined
  }

  listJobs(cabinId: string): CabinJobRow[] {
    return this.stmt("SELECT * FROM cabin_jobs WHERE cabin_id = ? ORDER BY priority DESC, created_at").all(cabinId) as CabinJobRow[]
  }

  updateJobPriority(id: string, priority: number): void {
    this.stmt("UPDATE cabin_jobs SET priority = ? WHERE id = ?").run(priority, id)
  }

  endJob(id: string, now: string): void {
    this.stmt("UPDATE cabin_jobs SET ended_at = ? WHERE id = ?").run(now, id)
  }

  deleteJobsByCabin(cabinId: string): void {
    this.stmt("DELETE FROM cabin_jobs WHERE cabin_id = ?").run(cabinId)
  }

  // ── job events (append-only audit) ──
  appendEvent(row: CabinJobEventRow): void {
    this.stmt(`INSERT INTO cabin_job_events (id, job_id, cabin_id, kind, actor, payload, created_at)
      VALUES (?,?,?,?,?,?,?)`).run(row.id, row.job_id, row.cabin_id, row.kind, row.actor, row.payload, row.created_at)
  }

  listEvents(jobId: string): CabinJobEventRow[] {
    return this.stmt("SELECT * FROM cabin_job_events WHERE job_id = ? ORDER BY created_at").all(jobId) as CabinJobEventRow[]
  }

  listEventsByCabin(cabinId: string): CabinJobEventRow[] {
    return this.stmt("SELECT * FROM cabin_job_events WHERE cabin_id = ? ORDER BY created_at").all(cabinId) as CabinJobEventRow[]
  }

  deleteEventsByCabin(cabinId: string): void {
    // Cascade-only cleanup (S2); the append-only trigger blocks UPDATE, not this path.
    this.stmt("DELETE FROM cabin_job_events WHERE cabin_id = ?").run(cabinId)
  }
}