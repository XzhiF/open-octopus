import type Database from "better-sqlite3"
import { BaseDAO } from "./base"
import type {
  CabinRow, CabinIterationRow, CabinJobRow, CabinJobEventRow, CabinStatus,
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
    try { db.exec("ALTER TABLE tasks ADD COLUMN iteration_id TEXT") } catch {}
  }

  insert(row: CabinRow): void {
    this.stmt(`
      INSERT INTO cabins (id, name, path, workspace_id, main_session_id, requirements, status,
        mainline_strategy, org, init_state, cockpit_prefs, focused_job_id, version,
        created_at, updated_at, last_active_at, archived_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      row.id, row.name, row.path, row.workspace_id, row.main_session_id, row.requirements, row.status,
      row.mainline_strategy, row.org, row.init_state, row.cockpit_prefs, row.focused_job_id, row.version,
      row.created_at, row.updated_at, row.last_active_at, row.archived_at,
    )
  }

  findById(id: string): CabinRow | undefined {
    return this.stmt("SELECT * FROM cabins WHERE id = ?").get(id) as CabinRow | undefined
  }

  findByPath(path: string): CabinRow | undefined {
    return this.stmt("SELECT * FROM cabins WHERE path = ?").get(path) as CabinRow | undefined
  }

  list(status?: CabinStatus): CabinRow[] {
    if (status) return this.stmt("SELECT * FROM cabins WHERE status = ? ORDER BY created_at DESC").all(status) as CabinRow[]
    return this.stmt("SELECT * FROM cabins ORDER BY created_at DESC").all() as CabinRow[]
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

  // ── iterations ──
  insertIteration(row: CabinIterationRow): void {
    this.stmt(`INSERT INTO cabin_iterations (id, cabin_id, code, name, sort_order, status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(row.id, row.cabin_id, row.code, row.name, row.sort_order, row.status, row.created_at, row.updated_at)
  }

  listIterations(cabinId: string): CabinIterationRow[] {
    return this.stmt("SELECT * FROM cabin_iterations WHERE cabin_id = ? ORDER BY sort_order, created_at").all(cabinId) as CabinIterationRow[]
  }

  updateIteration(id: string, fields: Partial<Pick<CabinIterationRow, "name" | "sort_order" | "status">>, now: string): void {
    const sets: string[] = []
    const vals: unknown[] = []
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue
      sets.push(`${k} = ?`); vals.push(v)
    }
    if (!sets.length) return
    sets.push("updated_at = ?"); vals.push(now, id)
    this.stmt(`UPDATE cabin_iterations SET ${sets.join(", ")} WHERE id = ?`).run(...vals)
  }

  deleteIterationsByCabin(cabinId: string): void {
    this.stmt("DELETE FROM cabin_iterations WHERE cabin_id = ?").run(cabinId)
  }

  // ── jobs (dispatch ledger; status derived elsewhere, K3) ──
  insertJob(row: CabinJobRow): void {
    this.stmt(`INSERT INTO cabin_jobs (id, cabin_id, kind, ref_id, session_id, iteration_id, title, mandate, prompt, priority, created_at, ended_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, row.cabin_id, row.kind, row.ref_id, row.session_id, row.iteration_id, row.title, row.mandate, row.prompt, row.priority, row.created_at, row.ended_at)
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