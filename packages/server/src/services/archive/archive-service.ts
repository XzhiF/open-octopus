import type Database from "better-sqlite3"
import type { ArchiveDAO } from "../../db/dao/archive-dao"
import type { ExecutionDAO } from "../../db/dao/execution-dao"
import type { WorkspaceDAO } from "../../db/dao/workspace-dao"
import type { DomainEventBus } from "../agent/domain-event-bus"
import type { ExecutionArchiveRow, WorkspaceArchiveRow, ExecutionRow } from "../../db/types"
import { logError, logInfo } from "../../file-logger"

export class ArchivePartialFailure extends Error {
  constructor(public readonly failures: Array<{ execId: string; error: string }>) {
    super(`Archive partial failure: ${failures.length} executions failed`)
    this.name = "ArchivePartialFailure"
  }
}

export class ArchiveService {
  constructor(
    private archiveDAO: ArchiveDAO,
    private executionDAO: ExecutionDAO,
    private db: Database.Database,
    private domainEventBus?: DomainEventBus,
  ) {}

  // ── P1.1: archiveExecution ──────────────────────────────────────────

  private static TERMINAL_STATUSES = new Set(["completed", "completed_with_failures", "failed", "cancelled", "rejected"])

  async archiveExecution(executionId: string): Promise<{ archived: boolean; reason?: string }> {
    const exec = this.executionDAO.findById(executionId)
    if (!exec) return { archived: false, reason: "execution_not_found" }

    if (!ArchiveService.TERMINAL_STATUSES.has(exec.status)) {
      return { archived: false, reason: "execution_not_terminal" }
    }

    const row = this.buildExecutionArchiveRow(executionId, exec)

    try {
      const { inserted } = this.archiveDAO.insertExecutionArchive(row)
      return { archived: inserted, reason: inserted ? undefined : "already_archived" }
    } catch (err) {
      logError("archive execution failed", err, { executionId })
      return { archived: false, reason: "insert_failed" }
    }
  }

  // ── Shared: build ExecutionArchiveRow from source tables ─────────

  private buildExecutionArchiveRow(executionId: string, exec: ExecutionRow): ExecutionArchiveRow {
    const nodeCount = (this.db.prepare(
      "SELECT COUNT(*) as cnt FROM node_executions WHERE execution_id = ?",
    ).get(executionId) as { cnt: number }).cnt

    const successNodes = (this.db.prepare(
      "SELECT COUNT(*) as cnt FROM node_executions WHERE execution_id = ? AND status = 'completed'",
    ).get(executionId) as { cnt: number }).cnt

    const tokenAgg = this.db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0) as input,
        COALESCE(SUM(output_tokens), 0) as output,
        COALESCE(SUM(cache_read_tokens), 0) as cache_read,
        COALESCE(SUM(cache_creation_tokens), 0) as cache_creation
      FROM node_token_usages
      WHERE node_execution_id IN (SELECT id FROM node_executions WHERE execution_id = ?)
    `).get(executionId) as Record<string, number>

    const modelRows = this.db.prepare(`
      SELECT model, COUNT(*) as calls,
             SUM(input_tokens + output_tokens) as tokens,
             COALESCE(SUM(cost_usd), 0) as cost
      FROM llm_calls WHERE execution_id = ?
      GROUP BY model
    `).all(executionId) as Array<{ model: string; calls: number; tokens: number; cost: number }>

    const modelBreakdown: Record<string, { calls: number; tokens: number; cost: number }> = {}
    let totalCost = 0
    for (const row of modelRows) {
      modelBreakdown[row.model ?? "unknown"] = { calls: row.calls, tokens: row.tokens, cost: row.cost }
      totalCost += row.cost
    }

    const nodeSummary = this.db.prepare(`
      SELECT node_id, node_type, status, duration
      FROM node_executions WHERE execution_id = ?
      ORDER BY started_at ASC
    `).all(executionId)

    const children = this.db.prepare(
      "SELECT id FROM executions WHERE parent_id = ?",
    ).all(executionId) as Array<{ id: string }>

    return {
      execution_id: exec.id,
      workspace_id: exec.workspace_id,
      org: exec.org,
      workflow_name: exec.workflow_name,
      total_cost: totalCost,
      total_duration_ms: exec.duration ?? 0,
      node_count: nodeCount,
      success_rate: nodeCount > 0 ? successNodes / nodeCount : 0,
      token_breakdown: JSON.stringify(tokenAgg),
      model_breakdown: JSON.stringify(modelBreakdown),
      node_summary: JSON.stringify(nodeSummary),
      chain_info: JSON.stringify({
        parent_execution_id: exec.parent_id !== "0" ? exec.parent_id : null,
        child_execution_ids: children.map(c => c.id),
      }),
      status: exec.status,
      archived_at: new Date().toISOString(),
      metadata: null,
    }
  }

  // ── P1.2: archiveWorkspace (two-phase) ──────────────────────────────

  async archiveWorkspace(
    workspaceId: string,
    workspaceDAO: WorkspaceDAO,
  ): Promise<{ archived: boolean; execution_count: number }> {
    const ws = workspaceDAO.findById(workspaceId)
    if (!ws) return { archived: false, execution_count: 0 }

    const execRows = this.db.prepare(
      "SELECT id FROM executions WHERE workspace_id = ?",
    ).all(workspaceId) as Array<{ id: string }>

    const failures: Array<{ execId: string; error: string }> = []

    try {
      this.archiveDAO.transaction(() => {
        // Phase 1: mark archiving
        workspaceDAO.setArchiveStatus(workspaceId, "archiving")

        // Phase 2: archive all executions inline (sync, inside transaction)
        for (const { id } of execRows) {
          try {
            const exec = this.executionDAO.findById(id)
            if (!exec) continue
            const row = this.buildExecutionArchiveRow(id, exec)
            this.archiveDAO.insertExecutionArchive(row)
          } catch (e) {
            failures.push({ execId: id, error: e instanceof Error ? e.message : String(e) })
          }
        }

        // CRITICAL: if any failures, throw to rollback transaction
        if (failures.length > 0) {
          throw new ArchivePartialFailure(failures)
        }

        // Phase 3: workspace metadata snapshot
        const wsRow: WorkspaceArchiveRow = {
          workspace_id: ws.id,
          org: ws.org,
          name: ws.name,
          description: ws.description,
          source: ws.source,
          execution_count: execRows.length,
          total_cost: execRows.length > 0 ? (this.db.prepare(
            "SELECT COALESCE(SUM(total_cost), 0) as total FROM execution_archive WHERE workspace_id = ?",
          ).get(workspaceId) as { total: number }).total : 0,
          total_duration_ms: execRows.length > 0 ? (this.db.prepare(
            "SELECT COALESCE(SUM(total_duration_ms), 0) as total FROM execution_archive WHERE workspace_id = ?",
          ).get(workspaceId) as { total: number }).total : 0,
          created_at: ws.created_at,
          archived_at: new Date().toISOString(),
          metadata: null,
        }
        this.archiveDAO.insertWorkspaceArchive(wsRow)

        // Phase 4: mark archived
        workspaceDAO.setArchiveStatus(workspaceId, "archived")
      })

      logInfo("workspace archived", { workspaceId, execution_count: execRows.length })
      return { archived: true, execution_count: execRows.length }
    } catch (err) {
      logError("workspace archive failed", err, { workspaceId })
      // Transaction rolled back — mark as archive_failed for diagnostics
      try {
        workspaceDAO.setArchiveStatus(workspaceId, "archive_failed")
        logInfo("workspace marked as archive_failed", { workspaceId, error: err instanceof Error ? err.message : String(err) })
      } catch (statusErr) {
        // If even status update fails, log it but don't swallow the original error
        logError("failed to set archive_failed status", statusErr, { workspaceId })
      }
      throw err
    }
  }

  // ── P2.2: archiveMemoryBatch ─────────────────────────────────────

  async archiveMemoryBatch(
    org: string,
    config: { session_retention_days: number; long_term_refine_trigger_days: number },
  ): Promise<{ archived_count: number }> {
    let archivedCount = 0

    // 1. Archive daily memory files older than retention days
    try {
      // Dynamic imports to avoid circular deps and heavy transitive loads
      const { getAgentService } = await import('../agent/agent-service')
      const { getDailyMemoryDir } = await import('../agent/paths')
      const fs = await import('fs')

      const agentService = getAgentService()
      const dailyDir = getDailyMemoryDir()

      if (fs.existsSync(dailyDir)) {
        const files = fs.readdirSync(dailyDir).filter((f: string) => f.endsWith('.md'))
        const retentionCutoff = new Date()
        retentionCutoff.setDate(retentionCutoff.getDate() - config.session_retention_days)

        for (const file of files) {
          const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})\.md$/)
          if (!dateMatch) continue
          const fileDate = new Date(dateMatch[1])
          if (fileDate >= retentionCutoff) continue

          try {
            await agentService.archiveMemory(org, dateMatch[1])
            archivedCount++
            this.emitArchived(dateMatch[1], 'daily_memory', new Date().toISOString())
          } catch (err) {
            logError('failed to archive daily memory', err, { org, date: dateMatch[1] })
          }
        }
      }
    } catch (err) {
      logError('archiveMemoryBatch daily scan failed', err, { org })
      throw err
    }

    // 2. Check long-term memory refine trigger
    try {
      const { getMemoryService } = await import('../agent/memory-service')
      const { getLongTermMemoryPath } = await import('../agent/paths')
      const fs = await import('fs')

      const ltPath = getLongTermMemoryPath()
      if (fs.existsSync(ltPath)) {
        const stat = fs.statSync(ltPath)
        const daysSinceModified = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24)
        if (daysSinceModified >= config.long_term_refine_trigger_days) {
          try {
            const memoryService = getMemoryService()
            memoryService.refineLongTerm(org)
          } catch (err) {
            logError('long-term refine failed', err, { org })
          }
        }
      }
    } catch (err) {
      logError('long-term refine check failed', err, { org })
      throw err
    }

    return { archived_count: archivedCount }
  }

  // ── P2.3: emitArchived ───────────────────────────────────────────

  private emitArchived(memoryId: string, memoryType: string, archivedAt: string): void {
    if (!this.domainEventBus) return
    this.domainEventBus.emit('memory.archived', {
      memory_id: memoryId,
      memory_type: memoryType,
      archived_at: archivedAt,
    }, { source: 'archive-service' }).catch(err => {
      logError('emit memory.archived failed', err, { memoryId })
    })
  }
}

// ── Singleton ───────────────────────────────────────────────────────

let _instance: ArchiveService | null = null

export function initArchiveService(
  dao: ArchiveDAO,
  execDAO: ExecutionDAO,
  db: Database.Database,
  bus?: DomainEventBus,
): ArchiveService {
  _instance = new ArchiveService(dao, execDAO, db, bus)
  return _instance
}

export function getArchiveService(): ArchiveService | null {
  return _instance
}
