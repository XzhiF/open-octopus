// packages/server/src/services/archive-service.ts
import type { ArchiveDAO } from "../db/dao/archive-dao"
import type { ExecutionDAO } from "../db/dao/execution-dao"
import type { TokenUsageDAO } from "../db/dao/token-usage-dao"

/**
 * ArchiveService — Layer 1+2 synchronous extraction.
 *
 * Layer 1: programmatic extraction (node_summary, token aggregation)
 * Layer 2: rule-based filtering (failed nodes, vars_snapshot filtering)
 *
 * All methods are synchronous (better-sqlite3 is sync) and wrapped in try-catch.
 * On error, log warning and return null (never throw to caller).
 */
export class ArchiveService {
  constructor(
    private archiveDAO: ArchiveDAO,
    private executionDAO: ExecutionDAO,
    private tokenUsageDAO: TokenUsageDAO,
  ) {}

  /**
   * Archive a single execution. Returns the archive row id, or null on failure.
   */
  archiveExecution(executionId: string, wsArchiveId?: string): number | null {
    try {
      const execution = this.executionDAO.findById(executionId)
      if (!execution) return null

      const nodeExecutions = this.executionDAO.findNodeExecutions(executionId)

      // ── Layer 1: Build node_summary JSON ──────────────────────
      const nodeSummary = nodeExecutions.map(ne => ({
        node_id: ne.node_id,
        type: ne.node_type,
        status: ne.status,
        duration_ms: ne.duration ?? null,
        exit_code: ne.exit_code ?? null,
      }))

      // ── Layer 1: Aggregate token data ─────────────────────────
      // Use TokenUsageDAO to get cost data (includes cost_usd)
      const tokenRows = this.tokenUsageDAO.findByExecution(executionId)

      let totalInputTokens = 0
      let totalOutputTokens = 0
      let totalCostUsd = 0
      const modelBreakdown: Record<string, { input_tokens: number; output_tokens: number; cost_usd: number }> = {}

      for (const usage of tokenRows) {
        totalInputTokens += usage.input_tokens
        totalOutputTokens += usage.output_tokens
        const cost = usage.cost_usd ?? 0
        totalCostUsd += cost

        const model = usage.model || "unknown"
        if (!modelBreakdown[model]) {
          modelBreakdown[model] = { input_tokens: 0, output_tokens: 0, cost_usd: 0 }
        }
        modelBreakdown[model].input_tokens += usage.input_tokens
        modelBreakdown[model].output_tokens += usage.output_tokens
        modelBreakdown[model].cost_usd += cost
      }

      // Round total cost to avoid floating-point drift
      totalCostUsd = Math.round(totalCostUsd * 1e8) / 1e8

      // ── Layer 2: Extract failed nodes ─────────────────────────
      const failedNodes = nodeExecutions
        .filter(ne => ne.status === "failed")
        .map(ne => ne.node_id)
      const errorMessage = failedNodes.length > 0
        ? nodeExecutions.find(ne => ne.status === "failed")?.error ?? null
        : null

      // ── Layer 2: Filter vars_snapshot ─────────────────────────
      let varsSnapshot: Record<string, unknown> = {}
      try {
        const raw = execution.var_pool ? JSON.parse(execution.var_pool) : {}
        // Exclude large text values (> 1000 chars)
        for (const [k, v] of Object.entries(raw)) {
          if (typeof v === "string" && v.length > 1000) continue
          varsSnapshot[k] = v
        }
      } catch {
        // ignore parse errors
      }

      // ── Parent / chain metadata ──────────────────────────────
      const parentExecutionId = execution.parent_id !== "0" && execution.parent_id
        ? execution.parent_id
        : null
      const chainPosition = execution.child_index ?? null

      // ── Write to execution_archive ────────────────────────────
      const archiveId = this.archiveDAO.insertArchive({
        execution_id: executionId,
        workflow_ref: execution.workflow_ref,
        workflow_name: execution.workflow_name,
        status: execution.status,
        started_at: execution.started_at,
        completed_at: execution.completed_at,
        duration_ms: execution.duration,
        total_input_tokens: totalInputTokens,
        total_output_tokens: totalOutputTokens,
        total_cost_usd: totalCostUsd,
        node_summary: JSON.stringify(nodeSummary),
        failed_nodes: failedNodes.length > 0 ? JSON.stringify(failedNodes) : null,
        error_message: errorMessage,
        model_breakdown: Object.keys(modelBreakdown).length > 0 ? JSON.stringify(modelBreakdown) : null,
        vars_snapshot: JSON.stringify(varsSnapshot),
        workspace_id: execution.workspace_id,
        parent_execution_id: parentExecutionId,
        chain_position: chainPosition,
        workspace_archive_id: wsArchiveId ?? null,
      })
      return archiveId
    } catch (err) {
      console.warn(`[archive] archiveExecution failed for ${executionId}:`, err)
      return null
    }
  }

  /**
   * Archive all executions in a workspace and create a workspace_archive entry.
   * Returns the workspace_archive row id, or null on failure.
   */
  archiveWorkspace(workspaceId: string): number | null {
    try {
      const executions = this.executionDAO.listByWorkspace(workspaceId)
      if (executions.length === 0) return null

      // Look up workspace metadata for the archive record
      // We need name and org — get from the first execution's workspace
      // The workspace row should still exist at this point (we archive before delete)
      let workspaceName = workspaceId
      let workspaceOrg = "unknown"
      try {
        // Access workspace info via a direct query through the archive DAO's db
        // We don't have WorkspaceDAO here, so we get it from execution data
        if (executions.length > 0) {
          workspaceOrg = executions[0].org || "unknown"
        }
      } catch {
        // fallback to defaults
      }

      // Archive each execution (skip already-archived ones)
      const archivedIds: number[] = []
      for (const exec of executions) {
        const existing = this.archiveDAO.getArchive(exec.id)
        if (existing) continue
        const id = this.archiveExecution(exec.id)
        if (id !== null) archivedIds.push(id)
      }

      // Build execution_chains: detect parent-child relationships
      const chainMap = new Map<string, string[]>()
      const rootExecs = executions.filter(e => !e.parent_id || e.parent_id === "0")
      for (const root of rootExecs) {
        const chain: string[] = [root.id]
        const children = executions.filter(e => e.parent_id === root.id)
        for (const child of children) {
          chain.push(child.id)
        }
        chainMap.set(root.id, chain)
      }
      const executionChains = Array.from(chainMap.entries()).map(([rootId, children]) => ({
        root: rootId,
        children,
      }))

      // Build workflow_manifest: list of unique workflow refs
      const workflowSet = new Set<string>()
      for (const exec of executions) {
        if (exec.workflow_ref) workflowSet.add(exec.workflow_ref)
      }
      const workflowManifest = Array.from(workflowSet)

      // Aggregate totals
      let totalCost = 0
      for (const exec of executions) {
        const archive = this.archiveDAO.getArchive(exec.id)
        if (archive) totalCost += archive.total_cost_usd
      }

      // Try to get workspace name from workspace row
      // Since we don't have direct access to WorkspaceDAO, we'll use a placeholder
      // The caller (WorkspaceService) could pass the name, but for now use workspaceId
      // We'll try to extract from the workspace path or use the ID
      try {
        // Access the underlying db through the archiveDAO (BaseDAO exposes db)
        const db = (this.archiveDAO as any).db
        if (db) {
          const wsRow = db.prepare("SELECT name FROM workspaces WHERE id = ?").get(workspaceId) as { name: string } | undefined
          if (wsRow) workspaceName = wsRow.name
        }
      } catch {
        // fallback
      }

      // Create workspace_archive
      const wsArchiveId = this.archiveDAO.insertWorkspaceArchive({
        workspace_id: workspaceId,
        workspace_name: workspaceName,
        org: workspaceOrg,
        execution_chains: JSON.stringify(executionChains),
        workflow_manifest: JSON.stringify(workflowManifest),
        total_executions: executions.length,
        total_cost_usd: Math.round(totalCost * 1e8) / 1e8,
      })

      // Back-fill workspace_archive_id on execution_archive rows
      const wsArchiveIdStr = String(wsArchiveId)
      for (const exec of executions) {
        try {
          const existing = this.archiveDAO.getArchive(exec.id)
          if (existing && !existing.workspace_archive_id) {
            // Update workspace_archive_id — use direct update
            const db = (this.archiveDAO as any).db
            if (db) {
              db.prepare("UPDATE execution_archive SET workspace_archive_id = ? WHERE execution_id = ?")
                .run(wsArchiveIdStr, exec.id)
            }
          }
        } catch {
          // non-fatal
        }
      }

      return wsArchiveId
    } catch (err) {
      console.warn(`[archive] archiveWorkspace failed for ${workspaceId}:`, err)
      return null
    }
  }

  /**
   * For the detail API — returns archive data for a single execution.
   * Returns the archive row or null if not archived.
   */
  archiveExecutionForDetail(executionId: string): object | null {
    try {
      const archive = this.archiveDAO.getArchive(executionId)
      if (!archive) return null
      return {
        ...archive,
        node_summary: safeJsonParse(archive.node_summary, []),
        failed_nodes: safeJsonParse(archive.failed_nodes, null),
        model_breakdown: safeJsonParse(archive.model_breakdown, null),
        vars_snapshot: safeJsonParse(archive.vars_snapshot, {}),
        experiences: [], // Populated in P2
      }
    } catch (err) {
      console.warn(`[archive] archiveExecutionForDetail failed for ${executionId}:`, err)
      return null
    }
  }
}

function safeJsonParse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}
