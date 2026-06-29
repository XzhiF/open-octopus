import type Database from "better-sqlite3"
import { BaseDAO } from "./base"
import type {
  ExecutionRow, NodeExecutionRow, NodeEdgeRow, BranchExecutionRow,
  AgentEventRow, ExecutionSummaryRow, PipelineStateRow, PaginatedResult,
} from "../types"

export class ExecutionDAO extends BaseDAO {
  constructor(db: Database.Database) { super(db) }

  // ── executions ──────────────────────────────────────────────────

  findById(id: string): ExecutionRow | null {
    return (this.stmt("SELECT * FROM executions WHERE id = ?").get(id) as ExecutionRow) ?? null
  }

  // ponytail: walks parent_id chain; O(depth) queries, fine since depth ≤ 5
  computeChainDepth(executionId: string): number {
    let depth = 0
    let currentId: string | null = executionId
    const seen = new Set<string>()
    while (currentId) {
      if (seen.has(currentId)) break // cycle guard
      seen.add(currentId)
      const row = this.stmt("SELECT parent_id FROM executions WHERE id = ?").get(currentId) as { parent_id: string } | undefined
      if (!row || !row.parent_id || row.parent_id === "0") break
      depth++
      currentId = row.parent_id
    }
    return depth
  }

  listByWorkspace(workspaceId: string): ExecutionRow[] {
    return this.stmt("SELECT * FROM executions WHERE workspace_id = ? ORDER BY created_at DESC").all(workspaceId) as ExecutionRow[]
  }

  findChildren(parentId: string): ExecutionRow[] {
    return this.stmt("SELECT * FROM executions WHERE parent_id = ? ORDER BY child_index").all(parentId) as ExecutionRow[]
  }

  findRunningLeaves(workspaceId: string): ExecutionRow[] {
    return this.stmt(`
      SELECT e.* FROM executions e
      WHERE e.workspace_id = ? AND e.status = 'running'
        AND NOT EXISTS (SELECT 1 FROM executions c WHERE c.parent_id = e.id)
    `).all(workspaceId) as ExecutionRow[]
  }

  findRootExecution(workspaceId: string): ExecutionRow | null {
    return (this.stmt(
      "SELECT * FROM executions WHERE workspace_id = ? AND (parent_id = '0' OR parent_id IS NULL) LIMIT 1"
    ).get(workspaceId) as ExecutionRow) ?? null
  }

  insertExecution(row: Partial<ExecutionRow> & { id: string; workspace_id: string; org: string }): Database.RunResult {
    const now = new Date().toISOString()
    return this.stmt(`
      INSERT INTO executions (
        id, workspace_id, parent_id, child_index, workflow_ref, workflow_name,
        status, gate_status, rollback, rollback_on_error, input_values, var_pool,
        progress, triggered_by, started_at, completed_at, duration, org,
        created_at, updated_at, node_type, branch, start_commit_id, end_commit_id,
        name, global_session_id, approval_metadata, chain_retry_count, preset_inputs
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.workspace_id, row.parent_id ?? "0", row.child_index ?? 0,
      row.workflow_ref ?? "", row.workflow_name ?? "",
      row.status ?? "pending", row.gate_status ?? "closed",
      row.rollback ?? "none", row.rollback_on_error ?? 0,
      row.input_values ?? "{}", row.var_pool ?? "{}",
      row.progress ?? 0, row.triggered_by ?? "manual",
      row.started_at ?? null, row.completed_at ?? null, row.duration ?? null,
      row.org, row.created_at ?? now, row.updated_at ?? now,
      row.node_type ?? "normal", row.branch ?? null,
      row.start_commit_id ?? null, row.end_commit_id ?? null,
      row.name ?? null, row.global_session_id ?? null,
      row.approval_metadata ?? null, row.chain_retry_count ?? 0,
      row.preset_inputs ?? null,
    )
  }

  updateExecution(id: string, fields: Partial<ExecutionRow>): Database.RunResult {
    const allowed = new Set([
      "status", "gate_status", "var_pool", "progress", "started_at", "completed_at",
      "duration", "global_session_id", "approval_metadata", "chain_retry_count",
      "preset_inputs", "name", "branch", "start_commit_id", "end_commit_id",
      "pipeline_config", "retry_count", "pending_hooks", "resume_attempts",
      "instance_id", "input_values",
    ])
    const sets: string[] = []
    const vals: unknown[] = []
    for (const [k, v] of Object.entries(fields)) {
      if (k === "id") continue
      if (!allowed.has(k)) throw new Error(`Disallowed column: ${k}`)
      sets.push(`${k} = ?`)
      vals.push(v)
    }
    if (sets.length === 0) return { changes: 0, lastInsertRowid: 0 }
    sets.push("updated_at = ?")
    vals.push(new Date().toISOString())
    vals.push(id)
    return this.stmt(`UPDATE executions SET ${sets.join(", ")} WHERE id = ?`).run(...vals)
  }

  deleteById(id: string): Database.RunResult {
    return this.stmt("DELETE FROM executions WHERE id = ?").run(id)
  }

  countByWorkspaceAndStatus(workspaceId: string, status: string): number {
    return (this.stmt(
      "SELECT COUNT(*) as cnt FROM executions WHERE workspace_id = ? AND status = ?"
    ).get(workspaceId, status) as { cnt: number }).cnt
  }

  // ── node_executions ─────────────────────────────────────────────

  findNodeExecutions(executionId: string): NodeExecutionRow[] {
    return this.stmt("SELECT * FROM node_executions WHERE execution_id = ? ORDER BY id").all(executionId) as NodeExecutionRow[]
  }

  findNodeOutputs(executionId: string, nodeId: string): Record<string, unknown> | null {
    const row = this.stmt(
      "SELECT outputs FROM node_executions WHERE execution_id = ? AND node_id = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 1"
    ).get(executionId, nodeId) as { outputs: string | null } | undefined
    if (!row?.outputs) return null
    try { return JSON.parse(row.outputs) } catch { return null }
  }

  insertNodeExecution(row: Partial<NodeExecutionRow> & { id: string; execution_id: string; node_id: string }): Database.RunResult {
    return this.stmt(`
      INSERT INTO node_executions (
        id, execution_id, node_id, node_type, status,
        started_at, completed_at, duration, exit_code, error,
        vars_snapshot, outputs, session_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.execution_id, row.node_id,
      row.node_type ?? "unknown", row.status ?? "pending",
      row.started_at ?? null, row.completed_at ?? null,
      row.duration ?? null, row.exit_code ?? null, row.error ?? null,
      row.vars_snapshot ?? null, row.outputs ?? null, row.session_id ?? null,
    )
  }

  updateNodeExecution(id: string, fields: Partial<NodeExecutionRow>): Database.RunResult {
    const allowed = new Set([
      "status", "started_at", "completed_at", "duration", "exit_code", "error",
      "vars_snapshot", "outputs", "session_id", "retry_count", "last_retry_at",
    ])
    const sets: string[] = []
    const vals: unknown[] = []
    for (const [k, v] of Object.entries(fields)) {
      if (k === "id") continue
      if (!allowed.has(k)) throw new Error(`Disallowed node_execution column: ${k}`)
      sets.push(`${k} = ?`)
      vals.push(v)
    }
    if (sets.length === 0) return { changes: 0, lastInsertRowid: 0 }
    vals.push(id)
    return this.stmt(`UPDATE node_executions SET ${sets.join(", ")} WHERE id = ?`).run(...vals)
  }

  deleteNodeExecutionsByExecution(executionId: string): Database.RunResult {
    return this.stmt("DELETE FROM node_executions WHERE execution_id = ?").run(executionId)
  }

  // ── node_edges ──────────────────────────────────────────────────

  findNodeEdges(executionId: string): NodeEdgeRow[] {
    return this.stmt("SELECT * FROM node_edges WHERE execution_id = ?").all(executionId) as NodeEdgeRow[]
  }

  insertNodeEdge(row: Omit<NodeEdgeRow, "label"> & { label?: string | null }): Database.RunResult {
    return this.stmt(
      "INSERT INTO node_edges (id, execution_id, from_node_id, to_node_id, edge_type, label) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(row.id, row.execution_id, row.from_node_id, row.to_node_id, row.edge_type, row.label ?? null)
  }

  deleteNodeEdgesByExecution(executionId: string): Database.RunResult {
    return this.stmt("DELETE FROM node_edges WHERE execution_id = ?").run(executionId)
  }

  // ── branch_executions ───────────────────────────────────────────

  findBranchExecutions(executionId: string): BranchExecutionRow[] {
    return this.stmt(`
      SELECT b.* FROM branch_executions b
      JOIN node_executions n ON b.node_execution_id = n.id
      WHERE n.execution_id = ? ORDER BY b.iteration
    `).all(executionId) as BranchExecutionRow[]
  }

  insertBranchExecution(row: Omit<BranchExecutionRow, "output"> & { output?: string | null }): Database.RunResult {
    return this.stmt(`
      INSERT INTO branch_executions (id, node_execution_id, iteration, branch_label, status, started_at, completed_at, duration, output)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.id, row.node_execution_id, row.iteration, row.branch_label, row.status, row.started_at, row.completed_at, row.duration, row.output ?? null)
  }

  deleteBranchExecutionsByExecution(executionId: string): Database.RunResult {
    return this.stmt(`
      DELETE FROM branch_executions WHERE node_execution_id IN (
        SELECT id FROM node_executions WHERE execution_id = ?
      )
    `).run(executionId)
  }

  // ── agent_events ────────────────────────────────────────────────

  findAgentEvents(nodeExecutionId: string): AgentEventRow[] {
    return this.stmt(
      "SELECT * FROM agent_events WHERE node_execution_id = ? ORDER BY event_order"
    ).all(nodeExecutionId) as AgentEventRow[]
  }

  insertAgentEvent(row: AgentEventRow): Database.RunResult {
    return this.stmt(`
      INSERT INTO agent_events (
        node_execution_id, event_order, turn_index, event_type, timestamp,
        content, content_length, tool_call_id, tool_name, tool_input,
        tool_result, tool_is_error, tool_duration_ms, status_value, error_code, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.node_execution_id, row.event_order, row.turn_index, row.event_type,
      row.timestamp, row.content, row.content_length, row.tool_call_id,
      row.tool_name, row.tool_input, row.tool_result, row.tool_is_error,
      row.tool_duration_ms, row.status_value, row.error_code, row.error_message,
    )
  }

  deleteAgentEventsByExecution(executionId: string): Database.RunResult {
    return this.stmt(`
      DELETE FROM agent_events WHERE node_execution_id IN (
        SELECT id FROM node_executions WHERE execution_id = ?
      )
    `).run(executionId)
  }

  deleteAgentEventsByNode(nodeExecutionId: string): Database.RunResult {
    return this.stmt("DELETE FROM agent_events WHERE node_execution_id = ?").run(nodeExecutionId)
  }

  // ── execution_summaries ─────────────────────────────────────────

  findSummariesByExecution(executionId: string): ExecutionSummaryRow[] {
    return this.stmt(
      "SELECT * FROM execution_summaries WHERE execution_id = ?"
    ).all(executionId) as ExecutionSummaryRow[]
  }

  findRecentSummaries(workspaceId: string, limit: number): ExecutionSummaryRow[] {
    return this.stmt(
      "SELECT * FROM execution_summaries WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?"
    ).all(workspaceId, limit) as ExecutionSummaryRow[]
  }

  insertSummary(row: Omit<ExecutionSummaryRow, "created_at"> & { created_at?: string }): Database.RunResult {
    return this.stmt(`
      INSERT INTO execution_summaries (id, execution_id, workflow_ref, workspace_id, summary, status, duration_ms, failed_nodes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.execution_id, row.workflow_ref, row.workspace_id,
      row.summary, row.status, row.duration_ms, row.failed_nodes,
      row.created_at ?? new Date().toISOString(),
    )
  }

  deleteSummariesByExecution(executionId: string): Database.RunResult {
    return this.stmt("DELETE FROM execution_summaries WHERE execution_id = ?").run(executionId)
  }

  // ── pipeline_state ──────────────────────────────────────────────

  findPipelineState(workspaceId: string): PipelineStateRow | null {
    return (this.stmt("SELECT * FROM pipeline_state WHERE workspace_id = ?").get(workspaceId) as PipelineStateRow) ?? null
  }

  findRunningPipelines(): PipelineStateRow[] {
    return this.stmt("SELECT * FROM pipeline_state WHERE chain_status = 'running'").all() as PipelineStateRow[]
  }

  upsertPipelineState(row: PipelineStateRow): Database.RunResult {
    return this.stmt(`
      INSERT INTO pipeline_state (workspace_id, chain_status, config_hash, config_change_strategy, last_execution_id, started_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        chain_status = excluded.chain_status,
        config_hash = excluded.config_hash,
        config_change_strategy = excluded.config_change_strategy,
        last_execution_id = excluded.last_execution_id,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at
    `).run(row.workspace_id, row.chain_status, row.config_hash, row.config_change_strategy, row.last_execution_id, row.started_at, row.updated_at)
  }

  updatePipelineState(workspaceId: string, fields: Partial<PipelineStateRow>): Database.RunResult {
    const sets: string[] = []
    const vals: unknown[] = []
    for (const [k, v] of Object.entries(fields)) {
      if (k === "id" || k === "workspace_id") continue
      sets.push(`${k} = ?`)
      vals.push(v)
    }
    if (sets.length === 0) return { changes: 0, lastInsertRowid: 0 }
    sets.push("updated_at = ?")
    vals.push(new Date().toISOString())
    vals.push(workspaceId)
    return this.stmt(`UPDATE pipeline_state SET ${sets.join(", ")} WHERE workspace_id = ?`).run(...vals)
  }

  deletePipelineState(workspaceId: string): Database.RunResult {
    return this.stmt("DELETE FROM pipeline_state WHERE workspace_id = ?").run(workspaceId)
  }

  // ── Cascade delete ──────────────────────────────────────────────

  cascadeDeleteByWorkspace(workspaceId: string): void {
    this.transaction(() => {
      const execIds = this.findExecutionIdsForCascade(workspaceId)
      if (execIds.length > 0) {
        const placeholders = execIds.map(() => "?").join(",")
        const vals = execIds

        this.stmt(`DELETE FROM agent_events WHERE node_execution_id IN (SELECT ne.id FROM node_executions ne WHERE ne.execution_id IN (${placeholders}))`).run(...vals)
        this.stmt(`DELETE FROM llm_calls WHERE node_execution_id IN (SELECT ne.id FROM node_executions ne WHERE ne.execution_id IN (${placeholders}))`).run(...vals)
        this.stmt(`DELETE FROM node_token_usages WHERE node_execution_id IN (SELECT ne.id FROM node_executions ne WHERE ne.execution_id IN (${placeholders}))`).run(...vals)
        this.stmt(`DELETE FROM branch_executions WHERE node_execution_id IN (SELECT ne.id FROM node_executions ne WHERE ne.execution_id IN (${placeholders}))`).run(...vals)
        this.stmt(`DELETE FROM node_edges WHERE execution_id IN (${placeholders})`).run(...vals)
        this.stmt(`DELETE FROM node_executions WHERE execution_id IN (${placeholders})`).run(...vals)
        this.stmt(`DELETE FROM execution_summaries WHERE execution_id IN (${placeholders})`).run(...vals)
        this.stmt(`DELETE FROM schedule_executions WHERE execution_id IN (${placeholders})`).run(...vals)
      }
      this.stmt("DELETE FROM executions WHERE workspace_id = ?").run(workspaceId)
    })
  }

  private findExecutionIdsForCascade(workspaceId: string): string[] {
    const rows = this.stmt("SELECT id FROM executions WHERE workspace_id = ?").all(workspaceId) as { id: string }[]
    return rows.map(r => r.id)
  }

  // ── Additional methods for ExecutionLifecycle ─────────────────────

  countRunning(workspaceId: string): number {
    const row = this.stmt(
      "SELECT COUNT(*) as count FROM executions WHERE workspace_id = ? AND status = 'running'"
    ).get(workspaceId) as { count: number }
    return row.count
  }

  findNodeExecutionById(id: string): NodeExecutionRow | null {
    return (this.stmt("SELECT * FROM node_executions WHERE id = ?").get(id) as NodeExecutionRow) ?? null
  }

  findRunningNodeExecutionsByStatus(executionId: string, statuses: string[]): NodeExecutionRow[] {
    if (statuses.length === 0) return []
    const placeholders = statuses.map(() => "?").join(",")
    return this.stmt(
      `SELECT * FROM node_executions WHERE execution_id = ? AND status IN (${placeholders})`
    ).all(executionId, ...statuses) as NodeExecutionRow[]
  }

  updateNodeExecutionsByStatus(executionId: string, newStatus: string, currentStatuses: string[], extra?: Record<string, unknown>): Database.RunResult {
    if (currentStatuses.length === 0) return { changes: 0, lastInsertRowid: 0 }
    const placeholders = currentStatuses.map(() => "?").join(",")
    const sets = ["status = ?"]
    const vals: unknown[] = [newStatus]
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        sets.push(`${k} = ?`)
        vals.push(v)
      }
    }
    vals.push(executionId)
    return this.stmt(
      `UPDATE node_executions SET ${sets.join(", ")} WHERE execution_id = ? AND status IN (${placeholders})`
    ).run(...vals, ...currentStatuses)
  }

  findFirstNodeByStatus(executionId: string, status: string, orderBy = "started_at DESC"): { node_id: string } | null {
    return (this.stmt(
      `SELECT node_id FROM node_executions WHERE execution_id = ? AND status = ? ORDER BY ${orderBy} LIMIT 1`
    ).get(executionId, status) as { node_id: string }) ?? null
  }

  findFirstNodeErrorByStatus(executionId: string, status: string): { error: string | null } | null {
    return (this.stmt(
      "SELECT error FROM node_executions WHERE execution_id = ? AND status = ? ORDER BY started_at DESC LIMIT 1"
    ).get(executionId, status) as { error: string | null }) ?? null
  }

  findNodeStatsForExecution(executionId: string): { total: number; completed: number; running_or_pending: number } {
    return this.stmt(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status IN ('running', 'pending') THEN 1 ELSE 0 END) as running_or_pending
      FROM node_executions
      WHERE execution_id = ?
    `).get(executionId) as { total: number; completed: number; running_or_pending: number }
  }

  deleteTokenUsagesByExecution(executionId: string): Database.RunResult {
    return this.stmt(
      "DELETE FROM node_token_usages WHERE node_execution_id IN (SELECT id FROM node_executions WHERE execution_id = ?)"
    ).run(executionId)
  }

  cascadeDeleteExecution(executionId: string): void {
    this.transaction(() => {
      // Leaf tables (FK → node_executions)
      this.deleteAgentEventsByExecution(executionId)
      this.stmt(`DELETE FROM llm_calls WHERE node_execution_id IN (SELECT id FROM node_executions WHERE execution_id = ?)`).run(executionId)
      this.deleteTokenUsagesByExecution(executionId)
      this.deleteBranchExecutionsByExecution(executionId)
      // Tables with direct FK → executions
      this.deleteNodeEdgesByExecution(executionId)
      this.deleteSummariesByExecution(executionId)
      this.stmt("DELETE FROM schedule_executions WHERE execution_id = ?").run(executionId)
      this.stmt("UPDATE schedule_workspaces SET execution_id = NULL WHERE execution_id = ?").run(executionId)
      // Core tables
      this.deleteNodeExecutionsByExecution(executionId)
      this.deleteById(executionId)
    })
  }

  findCompletedNodeExecutions(executionId: string): Array<{ node_id: string; status: string; duration: number | null; error: string | null; outputs: string | null; session_id: string | null }> {
    return this.stmt(
      "SELECT node_id, status, duration, error, outputs, session_id FROM node_executions WHERE execution_id = ? AND status IN ('completed', 'skipped', 'rejected', 'paused', 'cancelled')"
    ).all(executionId) as Array<{ node_id: string; status: string; duration: number | null; error: string | null; outputs: string | null; session_id: string | null }>
  }

  findSessionNodes(executionId: string): Array<{ node_id: string; session_id: string }> {
    return this.stmt(
      "SELECT node_id, session_id FROM node_executions WHERE execution_id = ? AND status = 'completed' AND session_id IS NOT NULL ORDER BY completed_at DESC"
    ).all(executionId) as Array<{ node_id: string; session_id: string }>
  }

  findPendingHooksExecutions(): Array<{ id: string; pending_hooks: string; workspace_path: string }> {
    return this.stmt(
      `SELECT e.id, e.pending_hooks, ws.path as workspace_path
       FROM executions e
       JOIN workspaces ws ON e.workspace_id = ws.id
       WHERE e.pending_hooks IS NOT NULL AND e.pending_hooks != '[]'`
    ).all() as Array<{ id: string; pending_hooks: string; workspace_path: string }>
  }

  findStaleRunningExecutions(staleCutoff: string): Array<{ id: string; updated_at: string; pipeline_config: string }> {
    return this.stmt(
      "SELECT id, updated_at, pipeline_config FROM executions WHERE status = 'running' AND updated_at < ?"
    ).all(staleCutoff) as Array<{ id: string; updated_at: string; pipeline_config: string }>
  }

  findRecentRunningExecutions(staleCutoff: string): Array<{ id: string; updated_at: string; pipeline_config: string }> {
    return this.stmt(
      "SELECT id, updated_at, pipeline_config FROM executions WHERE status = 'running' AND updated_at >= ?"
    ).all(staleCutoff) as Array<{ id: string; updated_at: string; pipeline_config: string }>
  }

  fixOrphanedNodes(): number {
    const result = this.stmt(
      `UPDATE node_executions SET status = 'failed', error = ?
       WHERE status IN ('running', 'pending')
         AND execution_id IN (SELECT id FROM executions WHERE status IN ('failed', 'cancelled'))`
    ).run("服务重启中断（孤立节点）")
    return result.changes ?? 0
  }

  findPendingResumeExecutions(): Array<{ id: string; pipeline_config: string; resume_attempts: number; workspace_id: string; updated_at: string }> {
    return this.stmt(`
      SELECT id, pipeline_config, resume_attempts, workspace_id, updated_at FROM executions
      WHERE status = 'pending_resume'
    `).all() as Array<{ id: string; pipeline_config: string; resume_attempts: number; workspace_id: string; updated_at: string }>
  }

  findRunningExecutionIds(): Array<{ id: string; workspace_id: string; workflow_ref: string }> {
    return this.stmt(
      "SELECT id, workspace_id, workflow_ref FROM executions WHERE status = 'running'"
    ).all() as Array<{ id: string; workspace_id: string; workflow_ref: string }>
  }

  findWorkspacePath(workspaceId: string): string | null {
    const row = this.stmt("SELECT path FROM workspaces WHERE id = ?").get(workspaceId) as { path: string } | undefined
    return row?.path ?? null
  }

  findWorkspacePathByExecution(executionId: string, workspaceId: string): string | null {
    const row = this.stmt(`
      SELECT w.path as workspace_path
      FROM executions e JOIN workspaces w ON e.workspace_id = w.id
      WHERE e.id = ? AND e.workspace_id = ?
    `).get(executionId, workspaceId) as { workspace_path: string } | undefined
    return row?.workspace_path ?? null
  }

  findNodeErrorAndExitCode(executionId: string, nodeId: string): { error: string | null; exit_code: number | null } | null {
    return (this.stmt("SELECT error, exit_code FROM node_executions WHERE execution_id = ? AND node_id = ?")
      .get(executionId, nodeId) as { error: string | null; exit_code: number | null }) ?? null
  }

  findNodeTokenUsages(executionId: string): Array<{ node_id: string; model: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number }> {
    return this.stmt(
      `SELECT ne.node_id, ntu.model, ntu.input_tokens, ntu.output_tokens,
              ntu.cache_read_tokens, ntu.cache_creation_tokens
       FROM node_token_usages ntu
       JOIN node_executions ne ON ntu.node_execution_id = ne.id
       WHERE ne.execution_id = ?`
    ).all(executionId) as Array<{ node_id: string; model: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number }>
  }

  findLatestNodeOutput(executionId: string, nodeId: string): Record<string, unknown> | null {
    const row = this.stmt(
      "SELECT outputs FROM node_executions WHERE execution_id = ? AND node_id = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 1"
    ).get(executionId, nodeId) as { outputs: string | null } | undefined
    if (!row?.outputs) return null
    try { return JSON.parse(row.outputs) } catch { return null }
  }

  findRunningPipelineWorkspaces(): Array<{ workspace_id: string }> {
    return this.stmt("SELECT workspace_id FROM pipeline_state WHERE chain_status = 'running'").all() as Array<{ workspace_id: string }>
  }

  updatePipelineStatus(workspaceId: string, status: string): Database.RunResult {
    return this.stmt(
      "UPDATE pipeline_state SET chain_status = ?, updated_at = ? WHERE workspace_id = ?"
    ).run(status, new Date().toISOString(), workspaceId)
  }

  findLatestExecutionByWorkspace(workspaceId: string): ExecutionRow | null {
    return (this.stmt(
      "SELECT * FROM executions WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1"
    ).get(workspaceId) as ExecutionRow) ?? null
  }

  findExecutionForLookup(id: string): { parent_id: string | null; var_pool: string | null; input_values: string | null } | null {
    return (this.stmt(
      "SELECT parent_id, var_pool, input_values FROM executions WHERE id = ?"
    ).get(id) as { parent_id: string | null; var_pool: string | null; input_values: string | null }) ?? null
  }

  findCrossExecOutputs(workflowRef: string, nodeId: string, workspaceId: string): { outputs: string | null } | null {
    return (this.stmt(`
      SELECT ne.outputs
      FROM node_executions ne
      JOIN executions e ON ne.execution_id = e.id
      WHERE e.workflow_ref = ?
        AND ne.node_id = ?
        AND ne.status = 'completed'
        AND e.workspace_id = ?
      ORDER BY ne.completed_at DESC
      LIMIT 1
    `).get(workflowRef, nodeId, workspaceId) as { outputs: string | null }) ?? null
  }

  findPendingHooksForWorkspace(workspaceDbId: string): Array<{ id: string; workflow_ref: string; pending_hooks: string }> {
    return this.stmt(
      "SELECT id, workflow_ref, pending_hooks FROM executions WHERE pending_hooks IS NOT NULL AND pending_hooks != '[]' AND workspace_id = ?"
    ).all(workspaceDbId) as Array<{ id: string; workflow_ref: string; pending_hooks: string }>
  }

  findExecutionsForStateSync(workspaceDbId: string): Array<ExecutionRow> {
    return this.stmt(
      "SELECT id, parent_id, node_type, branch, workflow_ref, workflow_name, status, input_values, start_commit_id, end_commit_id, started_at, completed_at FROM executions WHERE workspace_id = ? ORDER BY created_at ASC"
    ).all(workspaceDbId) as ExecutionRow[]
  }

  findRootExecutionId(workspaceId: string): { id: string } | null {
    return (this.stmt(
      "SELECT id FROM executions WHERE workspace_id = ? AND (parent_id = '0' OR parent_id IS NULL) LIMIT 1"
    ).get(workspaceId) as { id: string }) ?? null
  }

  findParentEndCommit(parentId: string): { end_commit_id: string } | null {
    return (this.stmt("SELECT end_commit_id FROM executions WHERE id = ?").get(parentId) as { end_commit_id: string }) ?? null
  }

  findRecentSummariesForInjection(workflowRef: string, workspaceId: string, limit = 3): Array<{ summary: string; status: string; duration_ms: number; created_at: string }> {
    return this.stmt(`
      SELECT summary, status, duration_ms, created_at
      FROM execution_summaries
      WHERE workflow_ref = ? AND workspace_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(workflowRef, workspaceId, limit) as Array<{ summary: string; status: string; duration_ms: number; created_at: string }>
  }

  insertNodeTokenUsage(id: string, nodeExecutionId: string, model: string, inputTokens: number, outputTokens: number, costUsd: number | null, cacheReadTokens: number, cacheCreationTokens: number, createdAt: string): Database.RunResult {
    return this.stmt(
      `INSERT INTO node_token_usages (id, node_execution_id, model, input_tokens, output_tokens, cost_usd, cache_read_tokens, cache_creation_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens,
         cost_usd = COALESCE(cost_usd, 0) + COALESCE(excluded.cost_usd, 0),
         cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
         cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
         created_at = excluded.created_at`
    ).run(id, nodeExecutionId, model, inputTokens, outputTokens, costUsd, cacheReadTokens, cacheCreationTokens, createdAt)
  }

  updateNodeExecutionsGlobalSession(executionId: string, globalSessionId: string): Database.RunResult {
    return this.stmt("UPDATE executions SET global_session_id = ? WHERE id = ?").run(globalSessionId, executionId)
  }

  updateExecutionProgress(executionId: string, progress: number): Database.RunResult {
    return this.stmt("UPDATE executions SET progress = ? WHERE id = ?").run(progress, executionId)
  }

  updateNodeRetryInfo(executionId: string, nodeId: string, retryCount: number, retryAt: string): Database.RunResult {
    return this.stmt(
      "UPDATE node_executions SET retry_count = ?, last_retry_at = ? WHERE execution_id = ? AND node_id = ?"
    ).run(retryCount, retryAt, executionId, nodeId)
  }

  incrementRetryCount(executionId: string): Database.RunResult {
    return this.stmt("UPDATE executions SET retry_count = retry_count + 1 WHERE id = ?").run(executionId)
  }

  getRetryCount(executionId: string): number {
    const row = this.stmt("SELECT retry_count FROM executions WHERE id = ?").get(executionId) as { retry_count: number } | undefined
    return row?.retry_count ?? 0
  }

  findFirstRunningLeaf(workspaceId: string): { id: string } | null {
    return (this.stmt(`
      SELECT e.id FROM executions e
      WHERE e.workspace_id = ? AND e.status = 'running'
        AND NOT EXISTS (SELECT 1 FROM executions child WHERE child.parent_id = e.id)
    `).get(workspaceId) as { id: string }) ?? null
  }

  findFirstRunningNode(executionId: string): NodeExecutionRow | null {
    return (this.stmt(
      "SELECT * FROM node_executions WHERE execution_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1"
    ).get(executionId) as NodeExecutionRow) ?? null
  }

  findExecutionStatus(id: string): { status: string } | null {
    return (this.stmt("SELECT status FROM executions WHERE id = ?").get(id) as { status: string }) ?? null
  }

  insertNodeExecutionOrIgnore(row: Partial<NodeExecutionRow> & { id: string; execution_id: string; node_id: string }): Database.RunResult {
    return this.stmt(`
      INSERT OR IGNORE INTO node_executions (
        id, execution_id, node_id, node_type, status,
        started_at, completed_at, duration, exit_code, error,
        vars_snapshot, outputs, session_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.execution_id, row.node_id,
      row.node_type ?? "unknown", row.status ?? "pending",
      row.started_at ?? null, row.completed_at ?? null,
      row.duration ?? null, row.exit_code ?? null, row.error ?? null,
      row.vars_snapshot ?? null, row.outputs ?? null, row.session_id ?? null,
    )
  }

  insertNodeEdgeOrIgnore(row: { id: string; execution_id: string; from_node_id: string; to_node_id: string; edge_type: string; label?: string | null }): Database.RunResult {
    return this.stmt(
      "INSERT OR IGNORE INTO node_edges (id, execution_id, from_node_id, to_node_id, edge_type, label) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(row.id, row.execution_id, row.from_node_id, row.to_node_id, row.edge_type, row.label ?? null)
  }

  incrementResumeAttempts(executionId: string): Database.RunResult {
    return this.stmt("UPDATE executions SET resume_attempts = resume_attempts + 1 WHERE id = ?").run(executionId)
  }

  // ── Dashboard queries ────────────────────────────────────────────

  getDashboardStats(): {
    total_executions: number; completed_executions: number; failed_executions: number;
    running_executions: number; pending_executions: number; cancelled_executions: number;
    avg_duration_ms: number | null
  } {
    return this.stmt(`
      WITH root_executions AS (
        SELECT id, status as root_status, duration, completed_at, started_at
        FROM executions WHERE parent_id IS NULL OR parent_id = '0'
      ),
      latest_children AS (
        SELECT parent_id, status as child_status,
          ROW_NUMBER() OVER (PARTITION BY parent_id ORDER BY started_at DESC) as rn
        FROM executions WHERE parent_id IS NOT NULL AND parent_id != '0'
      ),
      effective_status AS (
        SELECT r.id, COALESCE(lc.child_status, r.root_status) as status,
          r.duration, r.completed_at, r.started_at
        FROM root_executions r
        LEFT JOIN latest_children lc ON r.id = lc.parent_id AND lc.rn = 1
      )
      SELECT
        COUNT(*) as total_executions,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_executions,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_executions,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running_executions,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_executions,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_executions,
        AVG(COALESCE(duration,
          CASE WHEN completed_at IS NOT NULL AND started_at IS NOT NULL
            THEN (julianday(completed_at) - julianday(started_at)) * 86400000
            ELSE NULL END)) as avg_duration_ms
      FROM effective_status
    `).get() as {
      total_executions: number; completed_executions: number; failed_executions: number;
      running_executions: number; pending_executions: number; cancelled_executions: number;
      avg_duration_ms: number | null
    }
  }

  getQueueItems(): Array<Record<string, unknown>> {
    return this.stmt(`
      SELECT e.*, w.name as workspace_name,
        (SELECT node_id FROM node_executions
         WHERE execution_id = e.id AND status = 'running'
         ORDER BY started_at DESC LIMIT 1) as current_step
      FROM executions e
      LEFT JOIN workspaces w ON e.workspace_id = w.id
      WHERE e.status IN ('running', 'pending')
      ORDER BY CASE e.status WHEN 'running' THEN 0 ELSE 1 END, e.created_at DESC
    `).all() as Array<Record<string, unknown>>
  }

  getRecentCompleted(limit: number = 10): Array<Record<string, unknown>> {
    return this.stmt(`
      SELECT e.*, w.name as workspace_name,
        (SELECT node_id FROM node_executions
         WHERE execution_id = e.id AND status = 'running'
         ORDER BY started_at DESC LIMIT 1) as current_step
      FROM executions e
      LEFT JOIN workspaces w ON e.workspace_id = w.id
      WHERE e.status IN ('completed', 'failed', 'cancelled', 'rejected')
      ORDER BY e.completed_at DESC LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>
  }

  getWorkflowHealth(limit: number = 10): Array<{
    workflow_ref: string; executions: number; success_rate: number | null; avg_duration_ms: number | null
  }> {
    return this.stmt(`
      WITH root_executions AS (
        SELECT id, workflow_ref, status as root_status, duration, completed_at, started_at
        FROM executions WHERE parent_id IS NULL OR parent_id = '0'
      ),
      latest_children AS (
        SELECT parent_id, status as child_status,
          ROW_NUMBER() OVER (PARTITION BY parent_id ORDER BY started_at DESC) as rn
        FROM executions WHERE parent_id IS NOT NULL AND parent_id != '0'
      ),
      effective_status AS (
        SELECT r.id, r.workflow_ref, COALESCE(lc.child_status, r.root_status) as status,
          r.duration, r.completed_at, r.started_at
        FROM root_executions r
        LEFT JOIN latest_children lc ON r.id = lc.parent_id AND lc.rn = 1
      )
      SELECT workflow_ref, COUNT(*) as executions,
        CAST(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as success_rate,
        AVG(duration) as avg_duration_ms
      FROM effective_status GROUP BY workflow_ref HAVING executions >= 1
      ORDER BY executions DESC LIMIT ?
    `).all(limit) as Array<{
      workflow_ref: string; executions: number; success_rate: number | null; avg_duration_ms: number | null
    }>
  }

  findAgentEventsWithNode(executionId: string, nodeId?: string): Array<Record<string, unknown>> {
    let query = `
      SELECT ae.*, ne.node_id
      FROM agent_events ae
      JOIN node_executions ne ON ae.node_execution_id = ne.id
      WHERE ne.execution_id = ?
    `
    const params: unknown[] = [executionId]
    if (nodeId) { query += ` AND ne.node_id = ?`; params.push(nodeId) }
    query += ` ORDER BY ae.timestamp ASC`
    return this.stmt(query).all(...params) as Array<Record<string, unknown>>
  }

  exists(id: string): boolean {
    const row = this.stmt("SELECT 1 FROM executions WHERE id = ?").get(id)
    return row !== undefined
  }

  findByOrgWithWorkspace(org: string, limit: number = 50): Array<{
    id: string; workspace_id: string; workflow_name: string; status: string;
    started_at: string | null; completed_at: string | null; workspace_name?: string
  }> {
    try {
      return this.stmt(`
        SELECT e.id, e.workspace_id, e.workflow_name, e.status,
               e.started_at, e.completed_at, w.name as workspace_name
        FROM executions e
        LEFT JOIN workspaces w ON e.workspace_id = w.id
        WHERE e.org = ?
        ORDER BY e.created_at DESC LIMIT ?
      `).all(org, limit) as Array<{
        id: string; workspace_id: string; workflow_name: string; status: string;
        started_at: string | null; completed_at: string | null; workspace_name?: string
      }>
    } catch {
      return []
    }
  }

  findActiveExecutionsByOrg(org: string): Array<{
    id: string; workspace_id: string; workflow_name: string; status: string;
    started_at: string | null; current_node: string | null; progress: number | null;
    workspace_name?: string
  }> {
    try {
      return this.stmt(`
        SELECT e.id, e.workspace_id, e.workflow_name, e.status,
               e.started_at, e.current_node, e.progress, w.name as workspace_name
        FROM executions e
        LEFT JOIN workspaces w ON e.workspace_id = w.id
        WHERE e.org = ? AND e.status IN ('running', 'active', 'pending')
        ORDER BY e.started_at DESC
      `).all(org) as Array<{
        id: string; workspace_id: string; workflow_name: string; status: string;
        started_at: string | null; current_node: string | null; progress: number | null;
        workspace_name?: string
      }>
    } catch {
      return []
    }
  }

  findAllActiveExecutions(): Array<{
    id: string; workspace_id: string; workflow_name: string; workflow_ref: string;
    status: string; started_at: string | null; current_node: string | null;
    progress: number | null; triggered_by: string; workspace_name?: string;
    updated_at: string | null
  }> {
    try {
      return this.stmt(`
        SELECT e.id, e.workspace_id, e.workflow_name, e.workflow_ref, e.status,
               e.started_at, e.current_node, e.progress, e.triggered_by, e.updated_at,
               w.name as workspace_name
        FROM executions e
        LEFT JOIN workspaces w ON e.workspace_id = w.id
        WHERE e.status IN ('running', 'active', 'pending')
        ORDER BY e.started_at DESC
      `).all() as Array<{
        id: string; workspace_id: string; workflow_name: string; workflow_ref: string;
        status: string; started_at: string | null; current_node: string | null;
        progress: number | null; triggered_by: string; workspace_name?: string;
        updated_at: string | null
      }>
    } catch {
      return []
    }
  }

  findNodeStatsForExecutionSplit(executionId: string): { total: number; completed: number; running: number; pending: number } {
    return this.stmt(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending
      FROM node_executions
      WHERE execution_id = ?
    `).get(executionId) as { total: number; completed: number; running: number; pending: number }
  }

  findByIdAndOrg(id: string, org: string): { id: string; workspace_id: string; status: string; workflow_name: string } | null {
    try {
      return (this.stmt(
        "SELECT id, workspace_id, status, workflow_name FROM executions WHERE id = ? AND org = ?"
      ).get(id, org) as { id: string; workspace_id: string; status: string; workflow_name: string }) ?? null
    } catch {
      return null
    }
  }

  getOverallStats(): Record<string, unknown> {
    return this.stmt(`
      SELECT
        COUNT(*) as total_executions,
        COUNT(CASE WHEN status = 'running' THEN 1 END) as running,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed,
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
        COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled,
        AVG(duration) as avg_duration_ms
      FROM executions
    `).get() as Record<string, unknown>
  }

  deleteOldNodeTokenUsages(cutoffTimestamp: number): Database.RunResult {
    return this.stmt("DELETE FROM node_token_usages WHERE created_at < ?").run(cutoffTimestamp)
  }

  // ── Analytics route queries ────────────────────────────────────────

  countByWorkspaceSince(workspaceId: string, cutoff: string): number {
    const row = this.stmt(
      "SELECT COUNT(*) as count FROM executions WHERE workspace_id = ? AND created_at >= ?"
    ).get(workspaceId, cutoff) as { count: number }
    return row.count
  }

  successRateByWorkspaceSince(workspaceId: string, cutoff: string): number | null {
    const row = this.stmt(
      "SELECT CAST(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS REAL) / NULLIF(COUNT(*), 0) as rate FROM executions WHERE workspace_id = ? AND created_at >= ? AND status IN ('completed', 'failed')"
    ).get(workspaceId, cutoff) as { rate: number | null }
    return row.rate
  }

  avgDurationByWorkspaceSince(workspaceId: string, cutoff: string): number | null {
    const row = this.stmt(
      "SELECT AVG(duration) as avg_ms FROM executions WHERE workspace_id = ? AND created_at >= ? AND duration IS NOT NULL"
    ).get(workspaceId, cutoff) as { avg_ms: number | null }
    return row.avg_ms
  }

  workflowStatsByWorkspace(workspaceId: string, cutoff: string): Array<Record<string, unknown>> {
    return this.stmt(`
      SELECT workflow_ref,
             COUNT(*) as executions,
             CAST(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS REAL) / NULLIF(COUNT(*), 0) as success_rate,
             AVG(duration) as avg_duration_ms
      FROM executions
      WHERE workspace_id = ? AND created_at >= ?
      GROUP BY workflow_ref ORDER BY executions DESC
    `).all(workspaceId, cutoff) as Array<Record<string, unknown>>
  }

  dailyTrendByWorkspace(workspaceId: string, cutoff: string): Array<Record<string, unknown>> {
    return this.stmt(`
      SELECT DATE(created_at) as date,
             COUNT(*) as executions,
             CAST(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS REAL) / NULLIF(COUNT(*), 0) as success_rate
      FROM executions WHERE workspace_id = ? AND created_at >= ?
      GROUP BY DATE(created_at) ORDER BY date ASC
    `).all(workspaceId, cutoff) as Array<Record<string, unknown>>
  }

  findExecutionsByWorkflow(workspaceId: string, workflowRef: string, cutoff: string, limit: number = 100): Array<Record<string, unknown>> {
    return this.stmt(
      "SELECT * FROM executions WHERE workspace_id = ? AND workflow_ref = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?"
    ).all(workspaceId, workflowRef, cutoff, limit) as Array<Record<string, unknown>>
  }

  // ── Batch inserts (for observability) ─────────────────────────────

  insertAgentEventBatch(rows: AgentEventRow[]): void {
    if (rows.length === 0) return
    const insertStmt = this.stmt(`
      INSERT OR IGNORE INTO agent_events (
        node_execution_id, event_order, turn_index, event_type, timestamp,
        content, content_length, tool_call_id, tool_name, tool_input,
        tool_result, tool_is_error, tool_duration_ms, status_value, error_code, error_message
      ) VALUES (
        @node_execution_id, @event_order, @turn_index, @event_type, @timestamp,
        @content, @content_length, @tool_call_id, @tool_name, @tool_input,
        @tool_result, @tool_is_error, @tool_duration_ms, @status_value, @error_code, @error_message
      )
    `)
    this.transaction(() => {
      for (const row of rows) insertStmt.run(row)
    })
  }

  // ── Analytical queries (for log-analysis, suggestion-engine) ────────

  findNodeExecStatsByWorkflow(workspaceId: string, days: number): Array<{
    node_id: string; status: string; node_type: string; workflow_ref: string; count: number
  }> {
    return this.stmt(`
      SELECT ne.node_id, ne.status, ne.node_type, e.workflow_ref, COUNT(*) as count
      FROM node_executions ne JOIN executions e ON ne.execution_id = e.id
      WHERE e.workspace_id = ? AND e.workflow_ref IS NOT NULL
        AND e.created_at >= datetime('now', '-' || ? || ' days')
        AND ne.node_type = 'condition'
      GROUP BY ne.node_id, ne.status, ne.node_type, e.workflow_ref
    `).all(workspaceId, days) as Array<{ node_id: string; status: string; node_type: string; workflow_ref: string; count: number }>
  }

  findFlakyNodeStats(workspaceId: string, days: number): Array<{
    node_id: string; failures: number; total: number
  }> {
    return this.stmt(`
      SELECT ne.node_id,
             SUM(CASE WHEN ne.status = 'failed' THEN 1 ELSE 0 END) as failures,
             COUNT(*) as total
      FROM node_executions ne JOIN executions e ON ne.execution_id = e.id
      WHERE e.workspace_id = ? AND e.created_at >= datetime('now', '-' || ? || ' days')
      GROUP BY ne.node_id HAVING failures > 0
    `).all(workspaceId, days) as Array<{ node_id: string; failures: number; total: number }>
  }

  // ── Additional methods for service migrations ─────────────────────

  findVarPool(executionId: string): string | null {
    const row = this.stmt("SELECT var_pool FROM executions WHERE id = ?").get(executionId) as { var_pool: string | null } | undefined
    return row?.var_pool ?? null
  }

  findExecutionStatusSimple(executionId: string): string | null {
    const row = this.stmt("SELECT status FROM executions WHERE id = ?").get(executionId) as { status: string } | undefined
    return row?.status ?? null
  }

  findFirstNodeError(executionId: string): string | null {
    const row = this.stmt(
      "SELECT error FROM node_executions WHERE execution_id = ? AND status = 'failed' LIMIT 1"
    ).get(executionId) as { error: string | null } | undefined
    return row?.error ?? null
  }

  findLastChildExecution(executionId: string): { id: string } | null {
    return (this.stmt(`
      SELECT id FROM executions
      WHERE workspace_id = (SELECT workspace_id FROM executions WHERE id = ?)
      ORDER BY child_index DESC
      LIMIT 1
    `).get(executionId) as { id: string }) ?? null
  }

  findChainNodeErrors(executionId: string): { error: string | null } | null {
    return (this.stmt(`
      SELECT error FROM node_executions
      WHERE execution_id IN (SELECT id FROM executions WHERE workspace_id = (SELECT workspace_id FROM executions WHERE id = ?))
      AND status = 'failed' LIMIT 1
    `).get(executionId) as { error: string | null }) ?? null
  }

  insertContainerExecution(id: string, workspaceId: string, workflowRef: string, org: string, now: string): Database.RunResult {
    return this.stmt(`
      INSERT INTO executions (
        id, workspace_id, parent_id, workflow_ref, workflow_name,
        status, node_type, triggered_by, org, created_at, updated_at,
        var_pool, input_values
      ) VALUES (?, ?, '0', ?, ?, 'completed', 'scheduler-root', 'scheduler', ?, ?, ?, '{}', '{}')
    `).run(id, workspaceId, workflowRef, workflowRef, org, now, now)
  }

  markInterruptedExecutions(org: string, completedAt: string): number {
    const result = this.stmt(
      "UPDATE executions SET status = 'interrupted', completed_at = ? WHERE org = ? AND status = 'running'"
    ).run(completedAt, org)
    return result.changes ?? 0
  }

  // ── Data retention methods ────────────────────────────────────────

  truncateOldAgentEventContent(cutoffTimestamp: number): Database.RunResult {
    return this.stmt(`
      UPDATE agent_events SET content = SUBSTR(content, 1, 50), content_length = 50
      WHERE timestamp < ? AND content IS NOT NULL AND LENGTH(content) > 50
    `).run(cutoffTimestamp)
  }

  deleteOldAgentEvents(cutoffTimestamp: number): Database.RunResult {
    return this.stmt("DELETE FROM agent_events WHERE timestamp < ?").run(cutoffTimestamp)
  }

  deleteOldLlmCalls(cutoffTimestamp: number): Database.RunResult {
    return this.stmt("DELETE FROM llm_calls WHERE timestamp < ?").run(cutoffTimestamp)
  }
}
