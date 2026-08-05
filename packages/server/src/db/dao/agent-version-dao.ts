import type Database from "better-sqlite3"
import { BaseDAO } from "./base"
import type { AgentVersionRow } from "../types"

/**
 * AgentVersionDAO — agent version management.
 * Covers: agent_versions table.
 */
export class AgentVersionDAO extends BaseDAO {
  constructor(db: Database.Database) { super(db) }

  findById(id: string): AgentVersionRow | null {
    return (this.stmt("SELECT * FROM agent_versions WHERE id = ?").get(id) as AgentVersionRow) ?? null
  }

  findByAgentAndVersion(agentName: string, version: string): AgentVersionRow | null {
    return (this.stmt(
      "SELECT * FROM agent_versions WHERE agent_name = ? AND version = ?"
    ).get(agentName, version) as AgentVersionRow) ?? null
  }

  listByAgent(agentName: string, filters?: {
    status?: string
    stage?: string
    limit?: number
  }): AgentVersionRow[] {
    const conditions: string[] = ["agent_name = ?"]
    const params: unknown[] = [agentName]

    if (filters?.status) {
      conditions.push("status = ?")
      params.push(filters.status)
    }
    if (filters?.stage) {
      conditions.push("stage = ?")
      params.push(filters.stage)
    }

    const where = conditions.join(" AND ")
    const limit = filters?.limit ?? 100

    return this.stmt(
      `SELECT * FROM agent_versions WHERE ${where} ORDER BY published_at DESC, created_at DESC LIMIT ?`
    ).all(...params, limit) as AgentVersionRow[]
  }

  findLatestPublished(agentName: string, minStage?: string): AgentVersionRow | null {
    const stageRank: Record<string, number> = { alpha: 0, beta: 1, rc: 2, stable: 3 }
    const minRank = minStage ? (stageRank[minStage] ?? 0) : 3 // default: stable only

    // Get all published versions sorted by version components descending
    const rows = this.stmt(
      `SELECT * FROM agent_versions
       WHERE agent_name = ? AND status = 'published'
       ORDER BY major DESC, minor DESC, patch DESC, published_at DESC`
    ).all(agentName) as AgentVersionRow[]

    for (const row of rows) {
      const rank = stageRank[row.stage] ?? 0
      if (rank >= minRank) return row
    }
    return null
  }

  insert(row: Omit<AgentVersionRow, 'id'> & { id: string }): Database.RunResult {
    return this.stmt(`
      INSERT INTO agent_versions (id, agent_name, version, major, minor, patch, stage, status, snapshot, changelog, published_at, published_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.agent_name, row.version, row.major, row.minor, row.patch,
      row.stage, row.status, row.snapshot, row.changelog,
      row.published_at, row.published_by, row.created_at,
    )
  }

  updateStatus(id: string, status: string): Database.RunResult {
    return this.stmt(
      "UPDATE agent_versions SET status = ? WHERE id = ?"
    ).run(status, id)
  }

  deleteById(id: string): Database.RunResult {
    return this.stmt("DELETE FROM agent_versions WHERE id = ?").run(id)
  }

  /**
   * List all published versions across all agents.
   * Used by EngineFactory to build a VersionResolver for octopus_agent nodes.
   */
  listAllPublished(): AgentVersionRow[] {
    return this.stmt(
      `SELECT * FROM agent_versions WHERE status = 'published' ORDER BY agent_name, major DESC, minor DESC, patch DESC`
    ).all() as AgentVersionRow[]
  }

  updateCloneVersionId(cloneName: string, versionId: string | null): Database.RunResult {
    return this.stmt(
      "UPDATE clones SET current_version_id = ?, updated_at = ? WHERE name = ?"
    ).run(versionId, new Date().toISOString(), cloneName)
  }
}
