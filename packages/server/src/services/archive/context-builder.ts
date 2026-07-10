import type Database from "better-sqlite3"
import type { WorkspaceDAO } from "../../db/dao/workspace-dao"
import type { ExecutionDAO } from "../../db/dao/execution-dao"
import type { ExecutionRow } from "../../db/types"
import { logError, logInfo } from "../../file-logger"

// ── Constants ────────────────────────────────────────────────────────

export const MAX_EXECUTIONS = 50
export const MAX_ERRORS = 20
export const MAX_ERROR_SNIPPET = 500
export const MAX_KNOWLEDGE = 50
export const MAX_KNOWLEDGE_TEXT = 100

// ── Types ────────────────────────────────────────────────────────────

export interface ArchiveContext {
  workspace: {
    id: string
    name: string
    org: string
    description: string | null
    created_at: string
    updated_at: string
    lifespan_days: number
  }
  executions: ExecutionSummary[]
  workflows: WorkflowProfile[]
  errorCatalog: ErrorEntry[]
  costProfile: CostProfile
  nodePatterns: NodePattern[]
  existingKnowledge: ExistingRule[]
  totalExecutionCount: number
  totalSuccessCount: number
}

export interface ExecutionSummary {
  index: number
  workflow_name: string
  status: string
  duration_s: number
  cost: number
  started_at: string
  failedNodes: FailedNode[]
}

export interface FailedNode {
  node_id: string
  node_type: string
  errorSnippet: string
}

export interface WorkflowProfile {
  name: string
  count: number
  successCount: number
  failCount: number
  successRate: number
  avgCost: number
  avgDuration_s: number
  nodeTypes: string[]
  costTrend: string
  costTrendDirection: "increasing" | "decreasing" | "stable"
}

export interface ErrorEntry {
  node_id: string
  workflow_name: string
  frequency: number
  errorSnippet: string
  lastOccurred: string
  workflowCount: number
}

export interface CostProfile {
  total_cost: number
  daily_avg: number
  trend_direction: "increasing" | "decreasing" | "stable"
  trend_pct: number
  modelBreakdown: ModelBreakdown[]
}

export interface ModelBreakdown {
  model: string
  calls: number
  tokens: number
  cost: number
}

export interface NodePattern {
  node_type: string
  node_id: string
  frequency: number
  successRate: number
  avgDuration_s: number
  workflowNames: string[]
}

export interface ExistingRule {
  id: string
  text: string
  scope: string
}

// ── Main ─────────────────────────────────────────────────────────────

export async function buildArchiveContext(
  workspaceId: string,
  workspaceDAO: WorkspaceDAO,
  executionDAO: ExecutionDAO,
  db: Database.Database,
  org: string,
): Promise<ArchiveContext | null> {
  const workspace = workspaceDAO.findById(workspaceId)
  if (!workspace) return null

  const executions = executionDAO.listByWorkspace(workspaceId)
  const sampled = sampleExecutions(executions, db)

  const [executionSummaries, workflowProfiles, errorCatalog, costProfile, nodePatterns, existingKnowledge, totalCounts] =
    await Promise.all([
      buildExecutionSummaries(sampled, executionDAO, db),
      buildWorkflowProfiles(executions, db),
      buildErrorCatalog(workspaceId, db),
      buildCostProfile(workspaceId, db),
      buildNodePatterns(workspaceId, db),
      loadExistingKnowledge(org),
      fetchTotalCounts(workspaceId, db),
    ])

  const createdDate = new Date(workspace.created_at)
  const updatedDate = new Date(workspace.updated_at)
  const lifespan_days = Math.max(
    1,
    Math.round((updatedDate.getTime() - createdDate.getTime()) / (1000 * 60 * 60 * 24)),
  )

  return {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      org: workspace.org,
      description: workspace.description,
      created_at: workspace.created_at,
      updated_at: workspace.updated_at,
      lifespan_days,
    },
    executions: executionSummaries,
    workflows: workflowProfiles,
    errorCatalog,
    costProfile,
    nodePatterns,
    existingKnowledge,
    totalExecutionCount: totalCounts.total,
    totalSuccessCount: totalCounts.success,
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function fetchTotalCounts(
  workspaceId: string,
  db: Database.Database,
): Promise<{ total: number; success: number }> {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as success
       FROM executions
       WHERE workspace_id = ?`,
    )
    .get(workspaceId) as { total: number; success: number }
  return Promise.resolve({
    total: row?.total ?? 0,
    success: row?.success ?? 0,
  })
}

function buildFailedNodes(executionId: string, db: Database.Database): FailedNode[] {
  const rows = db
    .prepare(
      `SELECT node_id, node_type, error
       FROM node_executions
       WHERE execution_id = ? AND status = 'failed'`,
    )
    .all(executionId) as Array<{ node_id: string; node_type: string; error: string | null }>

  return rows.map((row) => ({
    node_id: row.node_id,
    node_type: row.node_type,
    errorSnippet: truncate(row.error ?? "", MAX_ERROR_SNIPPET),
  }))
}

function getExecutionCost(executionId: string, db: Database.Database): number {
  // Primary: node_token_usages (covers all executor types including swarm)
  const ntuRow = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) as cost
       FROM node_token_usages
       WHERE node_execution_id IN (
         SELECT id FROM node_executions WHERE execution_id = ?
       )`,
    )
    .get(executionId) as { cost: number }
  const ntuCost = Number(ntuRow.cost) || 0
  if (ntuCost > 0) return ntuCost

  // Fallback: llm_calls (legacy path)
  const lcRow = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) as cost
       FROM llm_calls
       WHERE execution_id = ?`,
    )
    .get(executionId) as { cost: number }
  return Number(lcRow.cost) || 0
}

function sampleExecutions(executions: ExecutionRow[], db: Database.Database): ExecutionRow[] {
  if (executions.length <= MAX_EXECUTIONS) return executions

  const failures = executions.filter((e) => e.status === "failed")
  const nonFailures = executions.filter((e) => e.status !== "failed")

  // Most recent 20 (executions are ordered by created_at DESC from DAO)
  const recentIds = new Set(nonFailures.slice(0, 20).map((e) => e.id))

  // Top 10 by cost (compute in JS to include executions with no llm_calls)
  const execCosts = executions.map((e) => ({ id: e.id, cost: getExecutionCost(e.id, db) }))
  execCosts.sort((a, b) => b.cost - a.cost)
  const topCostIds = new Set(execCosts.slice(0, 10).map((c) => c.id))

  const selectedIds = new Set<string>()
  for (const f of failures) selectedIds.add(f.id)
  for (const id of recentIds) selectedIds.add(id)
  for (const id of topCostIds) selectedIds.add(id)

  const remaining = executions.filter((e) => !selectedIds.has(e.id))
  const fillNeeded = Math.max(0, MAX_EXECUTIONS - selectedIds.size)

  if (fillNeeded > 0 && remaining.length > 0) {
    const step = remaining.length / fillNeeded
    for (let i = 0; i < fillNeeded; i++) {
      selectedIds.add(remaining[Math.floor(i * step)].id)
    }
  }

  return executions.filter((e) => selectedIds.has(e.id))
}

async function buildExecutionSummaries(
  executions: ExecutionRow[],
  executionDAO: ExecutionDAO,
  db: Database.Database,
): Promise<ExecutionSummary[]> {
  return executions.map((exec, index) => {
    const duration_s = (exec.duration ?? 0) / 1000
    const cost = getExecutionCost(exec.id, db)
    const failedNodes = buildFailedNodes(exec.id, db)

    return {
      index,
      workflow_name: exec.workflow_name || "(unnamed)",
      status: exec.status,
      duration_s,
      cost,
      started_at: exec.started_at ?? exec.created_at,
      failedNodes,
    }
  })
}

function buildWorkflowProfiles(
  executions: ExecutionRow[],
  db: Database.Database,
): WorkflowProfile[] {
  const grouped = new Map<string, ExecutionRow[]>()
  for (const exec of executions) {
    const name = exec.workflow_name || "(unnamed)"
    if (!grouped.has(name)) grouped.set(name, [])
    grouped.get(name)!.push(exec)
  }

  const profiles: WorkflowProfile[] = []

  for (const [name, execs] of grouped) {
    const count = execs.length
    const successCount = execs.filter((e) => e.status === "completed").length
    const failCount = execs.filter((e) => e.status === "failed").length
    const successRate = count > 0 ? successCount / count : 0

    const durations = execs.map((e) => e.duration ?? 0)
    const avgDuration_s = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length / 1000 : 0

    const costs = execs.map((e) => getExecutionCost(e.id, db))
    const avgCost = costs.length > 0 ? costs.reduce((a, b) => a + b, 0) / costs.length : 0

    const nodeTypes = [
      ...new Set(
        execs.flatMap((e) =>
          (
            db
              .prepare("SELECT DISTINCT node_type FROM node_executions WHERE execution_id = ?")
              .all(e.id) as Array<{ node_type: string }>
          ).map((r) => r.node_type),
        ),
      ),
    ]

    // Cost trend: first half vs second half average (ordered by started_at)
    const sorted = [...execs].sort((a, b) =>
      (a.started_at ?? a.created_at).localeCompare(b.started_at ?? b.created_at),
    )
    const mid = Math.floor(sorted.length / 2)
    const firstHalf = sorted.slice(0, mid)
    const secondHalf = sorted.slice(mid)

    const firstAvg =
      firstHalf.length > 0
        ? firstHalf.reduce((sum, e) => sum + getExecutionCost(e.id, db), 0) / firstHalf.length
        : 0
    const secondAvg =
      secondHalf.length > 0
        ? secondHalf.reduce((sum, e) => sum + getExecutionCost(e.id, db), 0) / secondHalf.length
        : 0

    let costTrendDirection: "increasing" | "decreasing" | "stable" = "stable"
    let costTrend = "stable"
    let trendPct = 0

    if (firstAvg > 0) {
      trendPct = ((secondAvg - firstAvg) / firstAvg) * 100
      if (trendPct > 10) {
        costTrendDirection = "increasing"
        costTrend = "increasing"
      } else if (trendPct < -10) {
        costTrendDirection = "decreasing"
        costTrend = "decreasing"
      }
    } else if (secondAvg > 0) {
      costTrendDirection = "increasing"
      costTrend = "increasing"
      trendPct = 100
    }

    profiles.push({
      name,
      count,
      successCount,
      failCount,
      successRate,
      avgCost,
      avgDuration_s,
      nodeTypes,
      costTrend,
      costTrendDirection,
    })
  }

  return profiles.sort((a, b) => b.count - a.count)
}

function buildErrorCatalog(workspaceId: string, db: Database.Database): ErrorEntry[] {
  const rows = db
    .prepare(
      `SELECT
         ne.node_id,
         e.workflow_name,
         SUBSTR(ne.error, 1, ${MAX_ERROR_SNIPPET}) as errorSnippet,
         COUNT(*) as frequency,
         MAX(ne.completed_at) as lastOccurred,
         COUNT(DISTINCT e.id) as workflowCount
       FROM node_executions ne
       JOIN executions e ON ne.execution_id = e.id
       WHERE e.workspace_id = ?
         AND ne.status = 'failed'
         AND ne.error IS NOT NULL
       GROUP BY ne.node_id, SUBSTR(ne.error, 1, ${MAX_ERROR_SNIPPET})
       ORDER BY frequency DESC
       LIMIT ${MAX_ERRORS}`,
    )
    .all(workspaceId) as Array<{
    node_id: string
    workflow_name: string
    errorSnippet: string
    frequency: number
    lastOccurred: string
    workflowCount: number
  }>

  return rows.map((row) => ({
    node_id: row.node_id,
    workflow_name: row.workflow_name || "(unnamed)",
    frequency: row.frequency,
    errorSnippet: row.errorSnippet,
    lastOccurred: row.lastOccurred,
    workflowCount: row.workflowCount,
  }))
}

function buildCostProfile(
  workspaceId: string,
  db: Database.Database,
): CostProfile {
  // Use node_token_usages (covers all executor types including swarm)
  // Path: node_token_usages → node_executions → executions
  const totalRow = db
    .prepare(
      `SELECT COALESCE(SUM(ntu.cost_usd), 0) as total
       FROM node_token_usages ntu
       JOIN node_executions ne ON ntu.node_execution_id = ne.id
       JOIN executions e ON ne.execution_id = e.id
       WHERE e.workspace_id = ?`,
    )
    .get(workspaceId) as { total: number }
  const total_cost = Number(totalRow.total) || 0

  // Daily average: use execution started_at for date range
  const dateRangeRow = db
    .prepare(
      `SELECT MIN(e.started_at) as min_ts, MAX(e.started_at) as max_ts
       FROM node_token_usages ntu
       JOIN node_executions ne ON ntu.node_execution_id = ne.id
       JOIN executions e ON ne.execution_id = e.id
       WHERE e.workspace_id = ?`,
    )
    .get(workspaceId) as { min_ts: string | null; max_ts: string | null }

  let daily_avg = 0
  let trend_direction: "increasing" | "decreasing" | "stable" = "stable"
  let trend_pct = 0

  if (dateRangeRow.min_ts != null && dateRangeRow.max_ts != null) {
    const minMs = new Date(dateRangeRow.min_ts).getTime()
    const maxMs = new Date(dateRangeRow.max_ts).getTime()
    const days = Math.max(1, Math.ceil((maxMs - minMs) / (1000 * 60 * 60 * 24)))
    daily_avg = total_cost / days
  } else if (total_cost > 0) {
    daily_avg = total_cost
  }

  // Cost trend from daily costs (group by execution date)
  const dailyRows = db
    .prepare(
      `SELECT DATE(e.started_at) as day, SUM(ntu.cost_usd) as cost
       FROM node_token_usages ntu
       JOIN node_executions ne ON ntu.node_execution_id = ne.id
       JOIN executions e ON ne.execution_id = e.id
       WHERE e.workspace_id = ?
       GROUP BY day
       ORDER BY day ASC`,
    )
    .all(workspaceId) as Array<{ day: string; cost: number }>

  if (dailyRows.length >= 2) {
    const mid = Math.floor(dailyRows.length / 2)
    const firstHalf = dailyRows.slice(0, mid)
    const secondHalf = dailyRows.slice(mid)

    const firstAvg = firstHalf.reduce((s, r) => s + r.cost, 0) / firstHalf.length
    const secondAvg = secondHalf.reduce((s, r) => s + r.cost, 0) / secondHalf.length

    if (firstAvg > 0) {
      trend_pct = ((secondAvg - firstAvg) / firstAvg) * 100
      if (trend_pct > 10) trend_direction = "increasing"
      else if (trend_pct < -10) trend_direction = "decreasing"
    } else if (secondAvg > 0) {
      trend_direction = "increasing"
      trend_pct = 100
    }
  }

  // Model breakdown
  const modelRows = db
    .prepare(
      `SELECT ntu.model,
              COUNT(*) as calls,
              SUM(ntu.input_tokens + ntu.output_tokens) as tokens,
              COALESCE(SUM(ntu.cost_usd), 0) as cost
       FROM node_token_usages ntu
       JOIN node_executions ne ON ntu.node_execution_id = ne.id
       JOIN executions e ON ne.execution_id = e.id
       WHERE e.workspace_id = ?
       GROUP BY ntu.model
       ORDER BY cost DESC`,
    )
    .all(workspaceId) as Array<{ model: string; calls: number; tokens: number; cost: number }>

  const modelBreakdown: ModelBreakdown[] = modelRows.map((row) => ({
    model: row.model ?? "unknown",
    calls: row.calls,
    tokens: Number(row.tokens) || 0,
    cost: Number(row.cost) || 0,
  }))

  return { total_cost, daily_avg, trend_direction, trend_pct, modelBreakdown }
}

function buildNodePatterns(
  workspaceId: string,
  db: Database.Database,
): NodePattern[] {
  const rows = db
    .prepare(
      `SELECT
         ne.node_type,
         ne.node_id,
         COUNT(*) as frequency,
         CAST(SUM(CASE WHEN ne.status = 'completed' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as successRate,
         AVG(ne.duration) as avgDuration_ms,
         GROUP_CONCAT(DISTINCT e.workflow_name) as workflowNames
       FROM node_executions ne
       JOIN executions e ON ne.execution_id = e.id
       WHERE e.workspace_id = ?
       GROUP BY ne.node_type, ne.node_id
       ORDER BY frequency DESC`,
    )
    .all(workspaceId) as Array<{
    node_type: string
    node_id: string
    frequency: number
    successRate: number
    avgDuration_ms: number
    workflowNames: string
  }>

  return rows.map((row) => ({
    node_type: row.node_type,
    node_id: row.node_id,
    frequency: row.frequency,
    successRate: Number(row.successRate) || 0,
    avgDuration_s: (Number(row.avgDuration_ms) || 0) / 1000,
    workflowNames: row.workflowNames ? row.workflowNames.split(",").filter(Boolean) : [],
  }))
}

async function loadExistingKnowledge(org: string): Promise<ExistingRule[]> {
  try {
    const { listAllActiveRules } = await import("../knowledge/file-ops")
    const rules = listAllActiveRules(org)
    return rules
      .slice(0, MAX_KNOWLEDGE)
      .map((r) => ({
        id: r.rule_id,
        text: truncate(r.text, MAX_KNOWLEDGE_TEXT),
        scope: r.scope,
      }))
  } catch (err) {
    logError("Failed to load existing knowledge for archive context", err)
    return []
  }
}

function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen)
}
