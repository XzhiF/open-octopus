import type Database from "better-sqlite3"
import { BaseDAO } from "./base"
import type { NodeTokenUsageRow, LlmCallRow } from "../types"

export class TokenUsageDAO extends BaseDAO {
  constructor(db: Database.Database) { super(db) }

  // ── node_token_usages ───────────────────────────────────────────

  findByNodeExecution(nodeExecutionId: string): NodeTokenUsageRow[] {
    return this.stmt(
      "SELECT * FROM node_token_usages WHERE node_execution_id = ?"
    ).all(nodeExecutionId) as NodeTokenUsageRow[]
  }

  findByExecution(executionId: string): NodeTokenUsageRow[] {
    return this.stmt(`
      SELECT ntu.* FROM node_token_usages ntu
      JOIN node_executions ne ON ntu.node_execution_id = ne.id
      WHERE ne.execution_id = ?
    `).all(executionId) as NodeTokenUsageRow[]
  }

  findByExecutionPerStep(executionId: string): Array<NodeTokenUsageRow & { node_id: string }> {
    return this.stmt(`
      SELECT ne.node_id, ntu.* FROM node_token_usages ntu
      JOIN node_executions ne ON ntu.node_execution_id = ne.id
      WHERE ne.execution_id = ?
    `).all(executionId) as Array<NodeTokenUsageRow & { node_id: string }>
  }

  insert(row: NodeTokenUsageRow): Database.RunResult {
    return this.stmt(`
      INSERT INTO node_token_usages (id, node_execution_id, model, input_tokens, output_tokens, cost_usd, cache_read_tokens, cache_creation_tokens, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.node_execution_id, row.model, row.input_tokens, row.output_tokens,
      row.cost_usd, row.cache_read_tokens, row.cache_creation_tokens, row.created_at,
    )
  }

  deleteByNodeExecution(nodeExecutionId: string): Database.RunResult {
    return this.stmt("DELETE FROM node_token_usages WHERE node_execution_id = ?").run(nodeExecutionId)
  }

  deleteByExecution(executionId: string): Database.RunResult {
    return this.stmt(`
      DELETE FROM node_token_usages WHERE node_execution_id IN (
        SELECT id FROM node_executions WHERE execution_id = ?
      )
    `).run(executionId)
  }

  totalCost(): number {
    const row = this.stmt(
      "SELECT SUM(cost_usd) as total FROM node_token_usages WHERE cost_usd IS NOT NULL"
    ).get() as { total: number | null }
    return row?.total ?? 0
  }

  // ── llm_calls ───────────────────────────────────────────────────

  findLlmCallsByExecution(executionId: string): LlmCallRow[] {
    return this.stmt("SELECT * FROM llm_calls WHERE execution_id = ?").all(executionId) as LlmCallRow[]
  }

  findLlmCallsByNodeExecution(nodeExecutionId: string): LlmCallRow[] {
    return this.stmt("SELECT * FROM llm_calls WHERE node_execution_id = ?").all(nodeExecutionId) as LlmCallRow[]
  }

  findLlmCallsByWorkspace(workspaceId: string, sinceTimestamp?: number): LlmCallRow[] {
    if (sinceTimestamp) {
      return this.stmt(
        "SELECT * FROM llm_calls WHERE workspace_id = ? AND timestamp >= ?"
      ).all(workspaceId, sinceTimestamp) as LlmCallRow[]
    }
    return this.stmt(
      "SELECT * FROM llm_calls WHERE workspace_id = ?"
    ).all(workspaceId) as LlmCallRow[]
  }

  insertLlmCall(row: LlmCallRow): Database.RunResult {
    return this.stmt(`
      INSERT OR IGNORE INTO llm_calls (
        id, node_execution_id, execution_id, turn_index, call_index, message_id,
        model, stop_reason, timestamp, duration_ms, ttft_ms,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        cost_usd, org, workspace_id, workflow_ref, node_id, session_id, instance_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.node_execution_id, row.execution_id, row.turn_index, row.call_index,
      row.message_id, row.model, row.stop_reason, row.timestamp, row.duration_ms,
      row.ttft_ms, row.input_tokens, row.output_tokens, row.cache_read_tokens,
      row.cache_creation_tokens, row.cost_usd, row.org, row.workspace_id,
      row.workflow_ref, row.node_id, row.session_id, row.instance_id,
    )
  }

  deleteLlmCallsByExecution(executionId: string): Database.RunResult {
    return this.stmt(`
      DELETE FROM llm_calls WHERE node_execution_id IN (
        SELECT id FROM node_executions WHERE execution_id = ?
      )
    `).run(executionId)
  }

  cleanupOlderThan(timestamp: number): Database.RunResult {
    return this.stmt("DELETE FROM llm_calls WHERE timestamp < ?").run(timestamp)
  }

  // ── Batch inserts ────────────────────────────────────────────────────

  insertLlmCallBatch(rows: LlmCallRow[]): void {
    if (rows.length === 0) return
    const insertStmt = this.stmt(`
      INSERT OR IGNORE INTO llm_calls (
        id, node_execution_id, execution_id, turn_index, call_index, message_id,
        model, stop_reason, timestamp, duration_ms, ttft_ms,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        cost_usd, org, workspace_id, workflow_ref, node_id, session_id, instance_id
      ) VALUES (
        @id, @node_execution_id, @execution_id, @turn_index, @call_index,
        @message_id, @model, @stop_reason, @timestamp, @duration_ms, @ttft_ms,
        @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens,
        @cost_usd, @org, @workspace_id, @workflow_ref, @node_id, @session_id, @instance_id
      )
    `)
    this.transaction(() => {
      for (const row of rows) insertStmt.run(row)
    })
  }

  // ── Leaderboard queries ──────────────────────────────────────────────

  getWorkspaceRanking(limit: number): Array<{
    workspace_id: string; workspace_name: string; total_tokens: number;
    total_cost_usd: number | null; cost_complete: number;
    model: string; input_tokens: number; output_tokens: number;
    cache_read_tokens: number; cache_creation_tokens: number; model_cost_usd: number | null
  }> {
    return this.stmt(`
      WITH workspace_totals AS (
        SELECT
          w.id AS workspace_id, w.name AS workspace_name,
          SUM(ntu.input_tokens + ntu.output_tokens + ntu.cache_read_tokens + ntu.cache_creation_tokens) AS total_tokens,
          CASE WHEN COUNT(*) = COUNT(ntu.cost_usd) THEN SUM(ntu.cost_usd) ELSE NULL END AS total_cost_usd,
          COUNT(*) = COUNT(ntu.cost_usd) AS cost_complete
        FROM node_token_usages ntu
        JOIN node_executions ne ON ntu.node_execution_id = ne.id
        JOIN executions e ON ne.execution_id = e.id
        JOIN workspaces w ON e.workspace_id = w.id
        GROUP BY w.id, w.name
        ORDER BY total_tokens DESC LIMIT ?
      )
      SELECT
        wt.workspace_id, wt.workspace_name, wt.total_tokens, wt.total_cost_usd, wt.cost_complete,
        ntu.model,
        SUM(ntu.input_tokens) AS input_tokens,
        SUM(ntu.output_tokens) AS output_tokens,
        SUM(ntu.cache_read_tokens) AS cache_read_tokens,
        SUM(ntu.cache_creation_tokens) AS cache_creation_tokens,
        CASE WHEN COUNT(*) = COUNT(ntu.cost_usd) THEN SUM(ntu.cost_usd) ELSE NULL END AS model_cost_usd
      FROM workspace_totals wt
      JOIN executions e ON e.workspace_id = wt.workspace_id
      JOIN node_executions ne ON ne.execution_id = e.id
      JOIN node_token_usages ntu ON ntu.node_execution_id = ne.id
      GROUP BY wt.workspace_id, wt.workspace_name, wt.total_tokens, wt.total_cost_usd, wt.cost_complete, ntu.model
      ORDER BY wt.total_tokens DESC, ntu.model
    `).all(limit) as Array<{
      workspace_id: string; workspace_name: string; total_tokens: number;
      total_cost_usd: number | null; cost_complete: number;
      model: string; input_tokens: number; output_tokens: number;
      cache_read_tokens: number; cache_creation_tokens: number; model_cost_usd: number | null
    }>
  }

  getExecutionRanking(limit: number): Array<{
    execution_id: string; workflow_ref: string; workflow_name: string | null;
    workspace_id: string; workspace_name: string; total_tokens: number;
    input_tokens: number; output_tokens: number; cache_read_tokens: number;
    cache_creation_tokens: number; total_cost_usd: number | null; cost_complete: number
  }> {
    return this.stmt(`
      SELECT
        e.id AS execution_id, e.workflow_ref AS workflow_ref, e.workflow_name AS workflow_name,
        w.id AS workspace_id, w.name AS workspace_name,
        SUM(ntu.input_tokens + ntu.output_tokens + ntu.cache_read_tokens + ntu.cache_creation_tokens) AS total_tokens,
        SUM(ntu.input_tokens) AS input_tokens, SUM(ntu.output_tokens) AS output_tokens,
        SUM(ntu.cache_read_tokens) AS cache_read_tokens,
        SUM(ntu.cache_creation_tokens) AS cache_creation_tokens,
        CASE WHEN COUNT(ntu.node_execution_id) = COUNT(ntu.cost_usd) THEN SUM(ntu.cost_usd) ELSE NULL END AS total_cost_usd,
        COUNT(ntu.node_execution_id) = COUNT(ntu.cost_usd) AS cost_complete
      FROM executions e
      JOIN workspaces w ON e.workspace_id = w.id
      JOIN node_executions ne ON ne.execution_id = e.id
      JOIN node_token_usages ntu ON ntu.node_execution_id = ne.id
      GROUP BY e.id, e.workflow_ref, e.workflow_name, w.id, w.name
      ORDER BY total_tokens DESC LIMIT ?
    `).all(limit) as Array<{
      execution_id: string; workflow_ref: string; workflow_name: string | null;
      workspace_id: string; workspace_name: string; total_tokens: number;
      input_tokens: number; output_tokens: number; cache_read_tokens: number;
      cache_creation_tokens: number; total_cost_usd: number | null; cost_complete: number
    }>
  }

  getExecutionModelBreakdown(executionId: string): Array<{
    model: string; input_tokens: number; output_tokens: number;
    cache_read_tokens: number; cache_creation_tokens: number;
    model_cost_usd: number | null; cost_complete: number
  }> {
    return this.stmt(`
      SELECT ntu.model,
        SUM(ntu.input_tokens) AS input_tokens, SUM(ntu.output_tokens) AS output_tokens,
        SUM(ntu.cache_read_tokens) AS cache_read_tokens,
        SUM(ntu.cache_creation_tokens) AS cache_creation_tokens,
        CASE WHEN COUNT(*) = COUNT(ntu.cost_usd) THEN SUM(ntu.cost_usd) ELSE NULL END AS model_cost_usd,
        COUNT(*) = COUNT(ntu.cost_usd) AS cost_complete
      FROM node_token_usages ntu
      JOIN node_executions ne ON ntu.node_execution_id = ne.id
      WHERE ne.execution_id = ?
      GROUP BY ntu.model
      ORDER BY input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens DESC
    `).all(executionId) as Array<{
      model: string; input_tokens: number; output_tokens: number;
      cache_read_tokens: number; cache_creation_tokens: number;
      model_cost_usd: number | null; cost_complete: number
    }>
  }

  getModelRanking(limit: number): Array<{
    model: string; input_tokens: number; output_tokens: number;
    cache_read_tokens: number; cache_creation_tokens: number;
    total_tokens: number; cost_usd: number | null; cost_complete: number
  }> {
    return this.stmt(`
      SELECT ntu.model,
        SUM(ntu.input_tokens) AS input_tokens, SUM(ntu.output_tokens) AS output_tokens,
        SUM(ntu.cache_read_tokens) AS cache_read_tokens,
        SUM(ntu.cache_creation_tokens) AS cache_creation_tokens,
        SUM(ntu.input_tokens + ntu.output_tokens + ntu.cache_read_tokens + ntu.cache_creation_tokens) AS total_tokens,
        CASE WHEN COUNT(*) = COUNT(ntu.cost_usd) THEN SUM(ntu.cost_usd) ELSE NULL END AS cost_usd,
        COUNT(*) = COUNT(ntu.cost_usd) AS cost_complete
      FROM node_token_usages ntu
      GROUP BY ntu.model
      ORDER BY total_tokens DESC LIMIT ?
    `).all(limit) as Array<{
      model: string; input_tokens: number; output_tokens: number;
      cache_read_tokens: number; cache_creation_tokens: number;
      total_tokens: number; cost_usd: number | null; cost_complete: number
    }>
  }

  // ── Health & monitoring queries ──────────────────────────────────────

  getHealthStats(workspaceId: string, days: number): { total: number; success_count: number; failure_count: number; avg_duration: number | null; total_cost: number } {
    const statsRow = this.stmt(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as success_count,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failure_count,
        AVG(CASE WHEN duration IS NOT NULL THEN duration END) as avg_duration
      FROM executions
      WHERE workspace_id = ? AND parent_id = '0'
        AND created_at >= datetime('now', '-' || ? || ' days')
    `).get(workspaceId, days) as { total: number; success_count: number; failure_count: number; avg_duration: number | null }

    const costRow = this.stmt(`
      SELECT COALESCE(SUM(ntu.cost_usd), 0) as total_cost
      FROM node_token_usages ntu
      JOIN node_executions ne ON ntu.node_execution_id = ne.id
      JOIN executions e ON ne.execution_id = e.id
      WHERE e.workspace_id = ? AND e.created_at >= datetime('now', '-' || ? || ' days')
    `).get(workspaceId, days) as { total_cost: number }

    return { ...statsRow, total_cost: costRow.total_cost }
  }

  getDailyTrend(workspaceId: string, days: number): Array<{ date: string; success_count: number; failed_count: number }> {
    return this.stmt(`
      SELECT DATE(created_at) as date,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as success_count,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count
      FROM executions
      WHERE workspace_id = ? AND parent_id = '0'
        AND created_at >= datetime('now', '-' || ? || ' days')
      GROUP BY DATE(created_at) ORDER BY date ASC
    `).all(workspaceId, days) as Array<{ date: string; success_count: number; failed_count: number }>
  }

  getActiveAlertCount(workspaceId: string, days: number): number {
    const row = this.stmt(`
      SELECT COUNT(*) as count FROM (
        SELECT 1 FROM executions
        WHERE workspace_id = ? AND parent_id = '0' AND status = 'failed'
          AND created_at >= datetime('now', '-' || ? || ' days')
        GROUP BY workflow_ref
        HAVING COUNT(*) >= 3
      )
    `).get(workspaceId, days) as { count: number }
    return row.count
  }

  getConsecutiveFailureAlerts(workspaceId: string, days: number): Array<{
    workflow_ref: string; streak_length: number; streak_start: string; streak_end: string
  }> {
    return this.stmt(`
      WITH run_sequences AS (
        SELECT workflow_ref, id, status, created_at,
          ROW_NUMBER() OVER (PARTITION BY workflow_ref ORDER BY created_at)
          - ROW_NUMBER() OVER (PARTITION BY workflow_ref, status ORDER BY created_at) as streak_group
        FROM executions
        WHERE parent_id = '0' AND workspace_id = ?
          AND created_at >= datetime('now', '-' || ? || ' days')
      ),
      streak_counts AS (
        SELECT workflow_ref, status, streak_group,
          COUNT(*) as streak_length, MIN(created_at) as streak_start, MAX(created_at) as streak_end
        FROM run_sequences GROUP BY workflow_ref, status, streak_group
      )
      SELECT * FROM streak_counts WHERE status = 'failed' AND streak_length >= 3 ORDER BY streak_length DESC
    `).all(workspaceId, days) as Array<{
      workflow_ref: string; streak_length: number; streak_start: string; streak_end: string
    }>
  }

  getHighFailureRateAlerts(workspaceId: string, days: number): Array<{
    node_id: string; node_type: string; workflow_ref: string;
    total_runs: number; failures: number; failure_pct: number; last_failure: string
  }> {
    return this.stmt(`
      WITH node_health AS (
        SELECT ne.node_id, ne.node_type, e.workflow_ref,
          COUNT(*) as total_runs,
          SUM(CASE WHEN ne.status = 'failed' THEN 1 ELSE 0 END) as failures,
          MAX(ne.completed_at) as last_failure
        FROM node_executions ne JOIN executions e ON ne.execution_id = e.id
        WHERE e.workspace_id = ? AND e.created_at >= datetime('now', '-' || ? || ' days')
        GROUP BY ne.node_id, e.workflow_ref HAVING total_runs >= 3
      )
      SELECT *, ROUND(CAST(failures AS REAL) / total_runs * 100, 1) as failure_pct
      FROM node_health WHERE failures > 0 AND CAST(failures AS REAL) / total_runs > 0.5
      ORDER BY failure_pct DESC LIMIT 10
    `).all(workspaceId, days) as Array<{
      node_id: string; node_type: string; workflow_ref: string;
      total_runs: number; failures: number; failure_pct: number; last_failure: string
    }>
  }

  getCostSpikeAlerts(workspaceId: string, days: number): Array<{
    id: string; workflow_ref: string; exec_cost: number; created_at: string;
    avg_cost: number; cost_ratio: number
  }> {
    return this.stmt(`
      WITH exec_costs AS (
        SELECT e.id, e.workflow_ref, e.created_at, SUM(ntu.cost_usd) as exec_cost
        FROM executions e
        JOIN node_executions ne ON ne.execution_id = e.id
        JOIN node_token_usages ntu ON ntu.node_execution_id = ne.id
        WHERE e.workspace_id = ? AND e.created_at >= datetime('now', '-' || ? || ' days')
        GROUP BY e.id
      ),
      wf_avg AS (
        SELECT workflow_ref, AVG(exec_cost) as avg_cost FROM exec_costs GROUP BY workflow_ref
      )
      SELECT ec.id, ec.workflow_ref, ec.exec_cost, ec.created_at, wa.avg_cost,
        ROUND(ec.exec_cost / wa.avg_cost, 1) as cost_ratio
      FROM exec_costs ec JOIN wf_avg wa ON ec.workflow_ref = wa.workflow_ref
      WHERE ec.exec_cost > wa.avg_cost * 3 ORDER BY cost_ratio DESC LIMIT 10
    `).all(workspaceId, days) as Array<{
      id: string; workflow_ref: string; exec_cost: number; created_at: string;
      avg_cost: number; cost_ratio: number
    }>
  }

  getErrorCategories(workspaceId: string, days: number): Array<{
    error_category: string; count: number; last_seen: string | null; sample_errors: string | null
  }> {
    return this.stmt(`
      SELECT
        CASE
          WHEN exit_code = 124 OR exit_code = 137 THEN 'timeout'
          WHEN exit_code = 130 THEN 'aborted'
          WHEN exit_code = 1 THEN 'script_error'
          WHEN exit_code IS NOT NULL AND exit_code != 0 THEN 'script_error'
          WHEN error LIKE '%timeout%' OR error LIKE '%timed out%' THEN 'timeout'
          WHEN error LIKE '%abort%' OR error LIKE '%signal%' THEN 'aborted'
          WHEN error LIKE '%API%' OR error LIKE '%rate limit%' THEN 'api_error'
          WHEN error LIKE '%permission%' OR error LIKE '%auth%' THEN 'auth_error'
          WHEN error IS NOT NULL THEN 'unknown'
          ELSE 'no_error_info'
        END as error_category,
        COUNT(*) as count, MAX(completed_at) as last_seen,
        GROUP_CONCAT(SUBSTR(COALESCE(error, ''), 1, 200), '|||') as sample_errors
      FROM node_executions
      WHERE status = 'failed'
        AND started_at >= datetime('now', '-' || ? || ' days')
        AND execution_id IN (SELECT id FROM executions WHERE workspace_id = ?)
      GROUP BY error_category ORDER BY count DESC
    `).all(days, workspaceId) as Array<{
      error_category: string; count: number; last_seen: string | null; sample_errors: string | null
    }>
  }

  getFragilityRanking(workspaceId: string, days: number): Array<{
    node_id: string; node_type: string; workflow_ref: string;
    total_runs: number; failures: number; avg_duration: number | null;
    last_failure: string | null; fragility_score: number
  }> {
    return this.stmt(`
      WITH node_health AS (
        SELECT ne.node_id, ne.node_type, e.workflow_ref,
          COUNT(*) as total_runs,
          SUM(CASE WHEN ne.status = 'failed' THEN 1 ELSE 0 END) as failures,
          AVG(ne.duration) as avg_duration, MAX(ne.completed_at) as last_failure
        FROM node_executions ne JOIN executions e ON ne.execution_id = e.id
        WHERE e.created_at >= datetime('now', '-' || ? || ' days') AND e.workspace_id = ?
        GROUP BY ne.node_id, e.workflow_ref
      )
      SELECT *, ROUND(
        (CAST(failures AS REAL) / total_runs) * 100
        * CASE WHEN total_runs > 10 THEN 1.0 ELSE 0.5 END, 1
      ) as fragility_score
      FROM node_health WHERE failures > 0
      ORDER BY fragility_score DESC LIMIT 20
    `).all(days, workspaceId) as Array<{
      node_id: string; node_type: string; workflow_ref: string;
      total_runs: number; failures: number; avg_duration: number | null;
      last_failure: string | null; fragility_score: number
    }>
  }

  getFailureChains(workspaceId: string, days: number): Array<{
    failed_node: string; downstream_node: string; downstream_status: string; occurrences: number
  }> {
    return this.stmt(`
      WITH failure_chains AS (
        SELECT ne1.node_id as failed_node, ne2.node_id as downstream_node,
          ne2.status as downstream_status, COUNT(*) as occurrences
        FROM node_executions ne1
        JOIN node_executions ne2 ON ne1.execution_id = ne2.execution_id AND ne2.started_at > ne1.completed_at
        JOIN executions e ON ne1.execution_id = e.id
        WHERE ne1.status = 'failed' AND e.workspace_id = ?
          AND e.created_at >= datetime('now', '-' || ? || ' days')
        GROUP BY ne1.node_id, ne2.node_id, ne2.status
      )
      SELECT * FROM failure_chains ORDER BY failed_node, occurrences DESC LIMIT 100
    `).all(workspaceId, days) as Array<{
      failed_node: string; downstream_node: string; downstream_status: string; occurrences: number
    }>
  }

  getDurationAnomalies(workspaceId: string, days: number): Array<{
    execution_id: string; node_id: string; current_duration: number;
    mean_duration: number; stddev_duration: number; z_score: number; severity: string
  }> {
    return this.stmt(`
      WITH node_stats AS (
        SELECT node_id, AVG(duration) as mean_duration,
          SQRT((AVG(duration * duration) - AVG(duration) * AVG(duration)) * CAST(COUNT(*) AS REAL) / (COUNT(*) - 1)) as stddev_duration,
          COUNT(*) as sample_count
        FROM node_executions
        WHERE status = 'completed' AND duration IS NOT NULL
          AND started_at >= datetime('now', '-' || ? || ' days')
          AND execution_id IN (SELECT id FROM executions WHERE workspace_id = ?)
        GROUP BY node_id HAVING sample_count >= 10
      )
      SELECT ne.execution_id, ne.node_id, ne.duration as current_duration,
        ns.mean_duration, ns.stddev_duration,
        ROUND((ne.duration - ns.mean_duration) / ns.stddev_duration, 1) as z_score,
        CASE WHEN (ne.duration - ns.mean_duration) / ns.stddev_duration > 3 THEN 'critical' ELSE 'warning' END as severity
      FROM node_executions ne
      JOIN node_stats ns ON ne.node_id = ns.node_id
      WHERE ne.status = 'completed' AND ns.stddev_duration > 0
        AND (ne.duration - ns.mean_duration) / ns.stddev_duration > 2
        AND ne.started_at >= datetime('now', '-' || ? || ' days')
        AND ne.execution_id IN (SELECT id FROM executions WHERE workspace_id = ?)
      ORDER BY z_score DESC LIMIT 50
    `).all(days, workspaceId, days, workspaceId) as Array<{
      execution_id: string; node_id: string; current_duration: number;
      mean_duration: number; stddev_duration: number; z_score: number; severity: string
    }>
  }

  getCostAnomalies(workspaceId: string, days: number): Array<{
    id: string; workflow_ref: string; exec_cost: number; avg_cost: number;
    cost_ratio: number; severity: string
  }> {
    return this.stmt(`
      WITH exec_costs AS (
        SELECT e.id, e.workflow_ref, e.created_at, SUM(ntu.cost_usd) as exec_cost
        FROM executions e JOIN node_executions ne ON ne.execution_id = e.id
        JOIN node_token_usages ntu ON ntu.node_execution_id = ne.id
        WHERE e.workspace_id = ? AND e.created_at >= datetime('now', '-' || ? || ' days')
        GROUP BY e.id
      ),
      wf_avg AS (
        SELECT workflow_ref, AVG(exec_cost) as avg_cost, MAX(exec_cost) as max_cost
        FROM exec_costs GROUP BY workflow_ref HAVING COUNT(*) >= 5
      )
      SELECT ec.id, ec.workflow_ref, ec.exec_cost, ec.created_at, wa.avg_cost,
        ROUND(ec.exec_cost / wa.avg_cost, 1) as cost_ratio,
        CASE WHEN ec.exec_cost > wa.avg_cost * 5 THEN 'critical' WHEN ec.exec_cost > wa.avg_cost * 3 THEN 'warning' ELSE 'normal' END as severity
      FROM exec_costs ec JOIN wf_avg wa ON ec.workflow_ref = wa.workflow_ref
      WHERE ec.exec_cost > wa.avg_cost * 2 ORDER BY cost_ratio DESC LIMIT 20
    `).all(workspaceId, days) as Array<{
      id: string; workflow_ref: string; exec_cost: number; avg_cost: number;
      cost_ratio: number; severity: string
    }>
  }

  getCostTrend(workspaceId: string, days: number): Array<{ date: string; total_cost: number; exec_count: number }> {
    return this.stmt(`
      SELECT DATE(e.created_at) as date,
        COALESCE(SUM(ntu.cost_usd), 0) as total_cost,
        COUNT(DISTINCT e.id) as exec_count
      FROM executions e
      LEFT JOIN node_executions ne ON ne.execution_id = e.id
      LEFT JOIN node_token_usages ntu ON ntu.node_execution_id = ne.id
      WHERE e.workspace_id = ? AND e.parent_id = '0'
        AND e.created_at >= datetime('now', '-' || ? || ' days')
      GROUP BY DATE(e.created_at) ORDER BY date ASC
    `).all(workspaceId, days) as Array<{ date: string; total_cost: number; exec_count: number }>
  }

  getTokenDistribution(workspaceId: string, days: number): Array<{
    model: string; total_input: number; total_output: number;
    total_cost: number; cache_hit_rate: number
  }> {
    return this.stmt(`
      SELECT ntu.model,
        SUM(ntu.input_tokens) as total_input, SUM(ntu.output_tokens) as total_output,
        COALESCE(SUM(ntu.cost_usd), 0) as total_cost,
        CASE WHEN SUM(ntu.input_tokens + ntu.cache_read_tokens) > 0
          THEN ROUND(CAST(SUM(ntu.cache_read_tokens) AS REAL) / SUM(ntu.input_tokens + ntu.cache_read_tokens) * 100, 1)
          ELSE 0 END as cache_hit_rate
      FROM node_token_usages ntu
      JOIN node_executions ne ON ntu.node_execution_id = ne.id
      JOIN executions e ON ne.execution_id = e.id
      WHERE e.workspace_id = ? AND e.created_at >= datetime('now', '-' || ? || ' days')
      GROUP BY ntu.model ORDER BY total_cost DESC
    `).all(workspaceId, days) as Array<{
      model: string; total_input: number; total_output: number;
      total_cost: number; cache_hit_rate: number
    }>
  }

  getCostByWorkflow(workspaceId: string, days: number): Array<{
    workflow_ref: string; total_cost: number; exec_count: number; avg_cost: number
  }> {
    return this.stmt(`
      SELECT e.workflow_ref,
        COALESCE(SUM(ntu.cost_usd), 0) as total_cost,
        COUNT(DISTINCT e.id) as exec_count,
        COALESCE(SUM(ntu.cost_usd), 0) / COUNT(DISTINCT e.id) as avg_cost
      FROM executions e
      LEFT JOIN node_executions ne ON ne.execution_id = e.id
      LEFT JOIN node_token_usages ntu ON ntu.node_execution_id = ne.id
      WHERE e.workspace_id = ? AND e.parent_id = '0'
        AND e.created_at >= datetime('now', '-' || ? || ' days')
      GROUP BY e.workflow_ref ORDER BY total_cost DESC
    `).all(workspaceId, days) as Array<{
      workflow_ref: string; total_cost: number; exec_count: number; avg_cost: number
    }>
  }

  // ── Workspace Token Stats (for archive preview) ──────────────────────

  getWorkspaceTokenStats(workspaceId: string): {
    total: { inputTokens: number; outputTokens: number; cost: number }
    byModel: Array<{ model: string; inputTokens: number; outputTokens: number; cost: number }>
    byWorkflow: Array<{
      workflowRef: string; inputTokens: number; outputTokens: number; cost: number
      byModel: Array<{ model: string; inputTokens: number; outputTokens: number; cost: number }>
    }>
  } {
    // Workspace total + model breakdown
    const modelRows = this.stmt(`
      SELECT ntu.model,
        SUM(ntu.input_tokens) as input_tokens, SUM(ntu.output_tokens) as output_tokens,
        COALESCE(SUM(ntu.cost_usd), 0) as cost
      FROM node_token_usages ntu
      JOIN node_executions ne ON ntu.node_execution_id = ne.id
      JOIN executions e ON ne.execution_id = e.id
      WHERE e.workspace_id = ?
      GROUP BY ntu.model ORDER BY cost DESC
    `).all(workspaceId) as Array<{ model: string; input_tokens: number; output_tokens: number; cost: number }>

    const total = modelRows.reduce((acc, r) => ({
      inputTokens: acc.inputTokens + r.input_tokens,
      outputTokens: acc.outputTokens + r.output_tokens,
      cost: acc.cost + r.cost,
    }), { inputTokens: 0, outputTokens: 0, cost: 0 })

    // Per-workflow with model breakdown
    const wfRows = this.stmt(`
      SELECT e.workflow_ref, ntu.model,
        SUM(ntu.input_tokens) as input_tokens, SUM(ntu.output_tokens) as output_tokens,
        COALESCE(SUM(ntu.cost_usd), 0) as cost
      FROM node_token_usages ntu
      JOIN node_executions ne ON ntu.node_execution_id = ne.id
      JOIN executions e ON ne.execution_id = e.id
      WHERE e.workspace_id = ?
      GROUP BY e.workflow_ref, ntu.model ORDER BY e.workflow_ref, cost DESC
    `).all(workspaceId) as Array<{ workflow_ref: string; model: string; input_tokens: number; output_tokens: number; cost: number }>

    const wfMap = new Map<string, { inputTokens: number; outputTokens: number; cost: number; byModel: Array<{ model: string; inputTokens: number; outputTokens: number; cost: number }> }>()
    for (const r of wfRows) {
      let wf = wfMap.get(r.workflow_ref)
      if (!wf) { wf = { inputTokens: 0, outputTokens: 0, cost: 0, byModel: [] }; wfMap.set(r.workflow_ref, wf) }
      wf.inputTokens += r.input_tokens
      wf.outputTokens += r.output_tokens
      wf.cost += r.cost
      wf.byModel.push({ model: r.model, inputTokens: r.input_tokens, outputTokens: r.output_tokens, cost: r.cost })
    }
    const byWorkflow = Array.from(wfMap.entries()).map(([workflowRef, stats]) => ({ workflowRef, ...stats }))

    return {
      total,
      byModel: modelRows.map(r => ({ model: r.model, inputTokens: r.input_tokens, outputTokens: r.output_tokens, cost: r.cost })),
      byWorkflow,
    }
  }

  getNodeTokenStats(workspaceId: string): Array<{
    workflowRef: string; nodeId: string; nodeName: string; nodeType: string
    inputTokens: number; outputTokens: number; cost: number
    byModel: Array<{ model: string; inputTokens: number; outputTokens: number; cost: number }>
  }> {
    const rows = this.stmt(`
      SELECT e.workflow_ref, ne.node_id,
        ne.node_type,
        ntu.model,
        SUM(ntu.input_tokens) as input_tokens, SUM(ntu.output_tokens) as output_tokens,
        COALESCE(SUM(ntu.cost_usd), 0) as cost
      FROM node_token_usages ntu
      JOIN node_executions ne ON ntu.node_execution_id = ne.id
      JOIN executions e ON ne.execution_id = e.id
      WHERE e.workspace_id = ?
      GROUP BY e.workflow_ref, ne.node_id, ntu.model
      ORDER BY e.workflow_ref, cost DESC
    `).all(workspaceId) as Array<{
      workflow_ref: string; node_id: string; node_type: string
      model: string; input_tokens: number; output_tokens: number; cost: number
    }>

    const nodeMap = new Map<string, {
      workflowRef: string; nodeId: string; nodeName: string; nodeType: string
      inputTokens: number; outputTokens: number; cost: number
      byModel: Array<{ model: string; inputTokens: number; outputTokens: number; cost: number }>
    }>()

    for (const r of rows) {
      const key = `${r.workflow_ref}:${r.node_id}`
      let node = nodeMap.get(key)
      if (!node) {
        node = { workflowRef: r.workflow_ref, nodeId: r.node_id, nodeName: r.node_id, nodeType: r.node_type, inputTokens: 0, outputTokens: 0, cost: 0, byModel: [] }
        nodeMap.set(key, node)
      }
      node.inputTokens += r.input_tokens
      node.outputTokens += r.output_tokens
      node.cost += r.cost
      node.byModel.push({ model: r.model, inputTokens: r.input_tokens, outputTokens: r.output_tokens, cost: r.cost })
    }

    return Array.from(nodeMap.values())
  }

  // ── LLM call analysis (for suggestion-engine) ────────────────────────

  findLlmCallStatsByNode(workspaceId: string, workflowRef: string): Array<{
    node_id: string; avg_out: number; calls: number; tool_ratio: number
  }> {
    return this.stmt(`
      SELECT node_id, AVG(output_tokens) as avg_out,
             COUNT(*) as calls,
             CAST(SUM(CASE WHEN stop_reason = 'tool_use' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as tool_ratio
      FROM llm_calls WHERE workspace_id = ? AND workflow_ref = ?
      GROUP BY node_id
    `).all(workspaceId, workflowRef) as Array<{ node_id: string; avg_out: number; calls: number; tool_ratio: number }>
  }

  findThinkingOutputRatio(workspaceId: string, workflowRef: string): Array<{
    node_id: string; thinking_total: number; output_total: number
  }> {
    return this.stmt(`
      SELECT node_id,
             SUM(cache_read_tokens + cache_creation_tokens) as thinking_total,
             SUM(output_tokens) as output_total
      FROM llm_calls WHERE workspace_id = ? AND workflow_ref = ?
      GROUP BY node_id HAVING output_total > 0
    `).all(workspaceId, workflowRef) as Array<{ node_id: string; thinking_total: number; output_total: number }>
  }

  findOutputOverproduction(workspaceId: string, workflowRef: string): Array<{
    node_id: string; avg_out: number; calls: number
  }> {
    return this.stmt(`
      SELECT node_id, AVG(output_tokens) as avg_out, COUNT(*) as calls
      FROM llm_calls WHERE workspace_id = ? AND workflow_ref = ?
      GROUP BY node_id
    `).all(workspaceId, workflowRef) as Array<{ node_id: string; avg_out: number; calls: number }>
  }

  // ── Analytics cost queries ─────────────────────────────────────────

  totalCostByWorkspaceSince(workspaceId: string, tsCutoff: number): number {
    const row = this.stmt(
      "SELECT COALESCE(SUM(cost_usd), 0) as total FROM llm_calls WHERE workspace_id = ? AND timestamp >= ?"
    ).get(workspaceId, tsCutoff) as { total: number }
    return row.total
  }

  costByModelSince(workspaceId: string, tsCutoff: number): Array<Record<string, unknown>> {
    return this.stmt(`
      SELECT model, COUNT(*) as calls, SUM(cost_usd) as total_cost,
             SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens,
             SUM(cache_read_tokens) as cache_read, SUM(cache_creation_tokens) as cache_create
      FROM llm_calls WHERE workspace_id = ? AND timestamp >= ?
      GROUP BY model ORDER BY total_cost DESC
    `).all(workspaceId, tsCutoff) as Array<Record<string, unknown>>
  }

  costByWorkflowSince(workspaceId: string, tsCutoff: number): Array<Record<string, unknown>> {
    return this.stmt(`
      SELECT workflow_ref, COUNT(DISTINCT execution_id) as executions,
             SUM(cost_usd) as total_cost
      FROM llm_calls WHERE workspace_id = ? AND timestamp >= ?
      GROUP BY workflow_ref ORDER BY total_cost DESC
    `).all(workspaceId, tsCutoff) as Array<Record<string, unknown>>
  }

  dailyCostSince(workspaceId: string, tsCutoff: number): Array<Record<string, unknown>> {
    return this.stmt(`
      SELECT DATE(timestamp / 1000, 'unixepoch') as date,
             SUM(cost_usd) as total_cost, COUNT(*) as calls
      FROM llm_calls WHERE workspace_id = ? AND timestamp >= ?
      GROUP BY date ORDER BY date ASC
    `).all(workspaceId, tsCutoff) as Array<Record<string, unknown>>
  }

  findLlmCallsByExecution(executionId: string, nodeId?: string): Array<Record<string, unknown>> {
    let query = `SELECT * FROM llm_calls WHERE execution_id = ?`
    const params: unknown[] = [executionId]
    if (nodeId) { query += ` AND node_id = ?`; params.push(nodeId) }
    query += ` ORDER BY turn_index, call_index`
    return this.stmt(query).all(...params) as Array<Record<string, unknown>>
  }

  findLlmCallsByWorkflowSince(workspaceId: string, workflowRef: string, tsCutoff: number): Array<Record<string, unknown>> {
    return this.stmt(
      "SELECT * FROM llm_calls WHERE workspace_id = ? AND workflow_ref = ? AND timestamp >= ?"
    ).all(workspaceId, workflowRef, tsCutoff) as Array<Record<string, unknown>>
  }
}
