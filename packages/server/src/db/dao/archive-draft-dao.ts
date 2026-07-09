import type Database from "better-sqlite3"

export interface ArchiveDraftRow {
  workspace_id: string
  org: string
  analysis_report: string
  experiences: string
  skills: string
  stats: string
}

export class ArchiveDraftDAO {
  constructor(private db: Database.Database) {}

  private stmt(sql: string) {
    return this.db.prepare(sql)
  }

  findByWorkspaceId(workspaceId: string): ArchiveDraftRow | undefined {
    return this.stmt(
      "SELECT workspace_id, org, analysis_report, experiences, skills, stats, created_at, updated_at FROM archive_drafts WHERE workspace_id = ?"
    ).get(workspaceId) as ArchiveDraftRow | undefined
  }

  upsert(row: ArchiveDraftRow): void {
    this.stmt(`
      INSERT INTO archive_drafts (workspace_id, org, analysis_report, experiences, skills, stats, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(workspace_id) DO UPDATE SET
        org = excluded.org,
        analysis_report = excluded.analysis_report,
        experiences = excluded.experiences,
        skills = excluded.skills,
        stats = excluded.stats,
        updated_at = datetime('now')
    `).run(
      row.workspace_id, row.org, row.analysis_report,
      row.experiences, row.skills, row.stats,
    )
  }

  delete(workspaceId: string): void {
    this.stmt("DELETE FROM archive_drafts WHERE workspace_id = ?").run(workspaceId)
  }
}
