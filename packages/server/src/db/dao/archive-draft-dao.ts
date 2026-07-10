import type Database from "better-sqlite3"

export interface ArchiveDraftRow {
  workspace_id: string
  org: string
  analysis_report: string
  experiences: string
  skills: string
  stats: string
  workflows: string
  token_stats: string
  agents: string
}

export class ArchiveDraftDAO {
  constructor(private db: Database.Database) {
    // Ensure columns exist (migration for existing tables)
    try { db.exec("ALTER TABLE archive_drafts ADD COLUMN workflows TEXT NOT NULL DEFAULT '[]'") } catch {}
    try { db.exec("ALTER TABLE archive_drafts ADD COLUMN token_stats TEXT NOT NULL DEFAULT '{}'") } catch {}
    try { db.exec("ALTER TABLE archive_drafts ADD COLUMN agents TEXT NOT NULL DEFAULT '[]'") } catch {}
  }

  private stmt(sql: string) {
    return this.db.prepare(sql)
  }

  findByWorkspaceId(workspaceId: string): ArchiveDraftRow | undefined {
    return this.stmt(
      "SELECT workspace_id, org, analysis_report, experiences, skills, stats, workflows, token_stats, agents, created_at, updated_at FROM archive_drafts WHERE workspace_id = ?"
    ).get(workspaceId) as ArchiveDraftRow | undefined
  }

  upsert(row: ArchiveDraftRow): void {
    this.stmt(`
      INSERT INTO archive_drafts (workspace_id, org, analysis_report, experiences, skills, stats, workflows, token_stats, agents, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(workspace_id) DO UPDATE SET
        org = excluded.org,
        analysis_report = excluded.analysis_report,
        experiences = excluded.experiences,
        skills = excluded.skills,
        stats = excluded.stats,
        workflows = excluded.workflows,
        token_stats = excluded.token_stats,
        agents = excluded.agents,
        updated_at = datetime('now')
    `).run(
      row.workspace_id, row.org, row.analysis_report,
      row.experiences, row.skills, row.stats,
      row.workflows ?? '[]', row.token_stats ?? '{}', row.agents ?? '[]',
    )
  }

  delete(workspaceId: string): void {
    this.stmt("DELETE FROM archive_drafts WHERE workspace_id = ?").run(workspaceId)
  }
}
