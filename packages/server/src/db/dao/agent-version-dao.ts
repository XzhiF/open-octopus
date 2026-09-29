import type { AgentVersionRow } from "../types"
import { BasePgDAO } from "./base-pg"
import { iso, isoOrNull, jsonStr } from "./pg-mappers"

/**
 * AgentVersionDAO — agent version management. (P1 B1: postgres.js / BasePgDAO)
 * Covers: agent_versions table（updateCloneVersionId 跨写 clones.current_version_id）。
 *
 * 方言差异（DAO 出口归一，见 pg-mappers.ts）：
 *   - snapshot: PG jsonb ↔ 旧 JSON 文本
 *   - published_at/created_at: timestamptz ↔ ISO 文本
 */

interface AgentVersionPgRow {
  id: string
  agent_name: string
  version: string
  major: number
  minor: number
  patch: number
  stage: string
  status: string
  snapshot: unknown
  changelog: string | null
  published_at: Date | string | null
  published_by: string | null
  created_at: Date | string
}

function fromRow(r: AgentVersionPgRow): AgentVersionRow {
  return {
    id: r.id,
    agent_name: r.agent_name,
    version: r.version,
    major: r.major,
    minor: r.minor,
    patch: r.patch,
    stage: r.stage,
    status: r.status,
    snapshot: jsonStr(r.snapshot) ?? "{}",
    changelog: r.changelog,
    published_at: isoOrNull(r.published_at),
    published_by: r.published_by,
    created_at: iso(r.created_at),
  }
}

export class AgentVersionDAO extends BasePgDAO {
  async findById(id: string): Promise<AgentVersionRow | null> {
    const row = await this.q1<AgentVersionPgRow>("SELECT * FROM agent_versions WHERE id = ?", [id])
    return row ? fromRow(row) : null
  }

  async findByAgentAndVersion(agentName: string, version: string): Promise<AgentVersionRow | null> {
    const row = await this.q1<AgentVersionPgRow>(
      "SELECT * FROM agent_versions WHERE agent_name = ? AND version = ?",
      [agentName, version],
    )
    return row ? fromRow(row) : null
  }

  async listByAgent(agentName: string, filters?: {
    status?: string
    stage?: string
    limit?: number
  }): Promise<AgentVersionRow[]> {
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

    const rows = await this.q<AgentVersionPgRow>(
      `SELECT * FROM agent_versions WHERE ${where} ORDER BY published_at DESC, created_at DESC LIMIT ?`,
      [...params, limit],
    )
    return rows.map(fromRow)
  }

  async findLatestPublished(agentName: string, minStage?: string): Promise<AgentVersionRow | null> {
    const stageRank: Record<string, number> = { alpha: 0, beta: 1, rc: 2, stable: 3 }
    const minRank = minStage ? (stageRank[minStage] ?? 0) : 3 // default: stable only

    // Get all published versions sorted by version components descending
    const rows = await this.listByAgentPublished(agentName)

    for (const row of rows) {
      const rank = stageRank[row.stage] ?? 0
      if (rank >= minRank) return row
    }
    return null
  }

  private listByAgentPublished(agentName: string): Promise<AgentVersionRow[]> {
    return this.q<AgentVersionPgRow>(
      `SELECT * FROM agent_versions
       WHERE agent_name = ? AND status = 'published'
       ORDER BY major DESC, minor DESC, patch DESC, published_at DESC`,
      [agentName],
    ).then((rs) => rs.map(fromRow))
  }

  async insert(row: Omit<AgentVersionRow, 'id'> & { id: string }): Promise<{ changes: number }> {
    return this.exec(`
      INSERT INTO agent_versions (id, agent_name, version, major, minor, patch, stage, status, snapshot, changelog, published_at, published_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      row.id, row.agent_name, row.version, row.major, row.minor, row.patch,
      row.stage, row.status, row.snapshot, row.changelog,
      row.published_at, row.published_by, row.created_at,
    ])
  }

  async updateStatus(id: string, status: string): Promise<{ changes: number }> {
    return this.exec("UPDATE agent_versions SET status = ? WHERE id = ?", [status, id])
  }

  async deleteById(id: string): Promise<{ changes: number }> {
    return this.exec("DELETE FROM agent_versions WHERE id = ?", [id])
  }

  /**
   * List all published versions across all agents.
   * Used by EngineFactory to build a VersionResolver for octopus_agent nodes.
   */
  async listAllPublished(): Promise<AgentVersionRow[]> {
    const rows = await this.q<AgentVersionPgRow>(
      `SELECT * FROM agent_versions WHERE status = 'published' ORDER BY agent_name, major DESC, minor DESC, patch DESC`,
    )
    return rows.map(fromRow)
  }

  /** clones.current_version_id — PG schema.sql 已随 B1 补列（SQLite 侧 schema.ts:537 ensureColumn 平移遗漏）。 */
  async updateCloneVersionId(cloneName: string, versionId: string | null): Promise<{ changes: number }> {
    return this.exec(
      "UPDATE clones SET current_version_id = ?, updated_at = ? WHERE name = ?",
      [versionId, new Date().toISOString(), cloneName],
    )
  }
}
