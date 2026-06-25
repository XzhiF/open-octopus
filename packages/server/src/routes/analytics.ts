import { Hono } from 'hono'
import type { Context } from 'hono'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import os from 'os'
import { getFlag, loadFeatureFlags } from '../config/feature-flags'
import { SuggestionEngine } from '../services/suggestion-engine'
import { getLogAnalysisService } from '../services/log-analysis'
import { WorkspaceDAO, ExecutionDAO, TokenUsageDAO } from '../db/dao'
import type { LogAnalysisService } from '../services/log-analysis'

// ─── Log Analysis Routes (default export) ──────────────────────────
// Mounted at: /api/workspaces/:id/analytics

function getWorkspaceId(c: { req: { param: (name: string) => string | undefined } }): string {
  const id = c.req.param("id")
  if (!id) throw Object.assign(new Error("workspace id required"), { status: 400 })
  return id
}

function parseDays(c: { req: { query: (name: string) => string | undefined } }): number {
  const raw = c.req.query("days")
  if (!raw) return 30
  const days = parseInt(raw, 10)
  if (isNaN(days) || days < 1 || days > 365) {
    throw Object.assign(new Error("days must be between 1 and 365"), { status: 400 })
  }
  return days
}

function parseLimit(c: { req: { query: (name: string) => string | undefined } }): number {
  const raw = c.req.query("limit")
  if (!raw) return 50
  const limit = parseInt(raw, 10)
  if (isNaN(limit) || limit < 1 || limit > 200) {
    throw Object.assign(new Error("limit must be between 1 and 200"), { status: 400 })
  }
  return limit
}

export function createAnalyticsLogRoutes(
  workspaceDAO: WorkspaceDAO,
  logAnalysisService: LogAnalysisService,
): Hono {
  const analyticsRoutes = new Hono()

  analyticsRoutes.get("/health-summary", (c) => {
    const workspaceId = getWorkspaceId(c)
    const ws = workspaceDAO.findById(workspaceId)
    if (!ws) return c.json({ error: "workspace not found" }, 404)
    const days = parseDays(c)
    return c.json(logAnalysisService.getHealthSummary(workspaceId, days))
  })

  analyticsRoutes.get("/alerts", (c) => {
    const workspaceId = getWorkspaceId(c)
    const ws = workspaceDAO.findById(workspaceId)
    if (!ws) return c.json({ error: "workspace not found" }, 404)
    const days = parseDays(c)
    const limit = parseLimit(c)
    return c.json(logAnalysisService.getAlerts(workspaceId, days, limit))
  })

  analyticsRoutes.get("/failure-patterns", (c) => {
    const workspaceId = getWorkspaceId(c)
    const ws = workspaceDAO.findById(workspaceId)
    if (!ws) return c.json({ error: "workspace not found" }, 404)
    const days = parseDays(c)
    return c.json(logAnalysisService.getFailurePatterns(workspaceId, days))
  })

  analyticsRoutes.get("/anomalies", (c) => {
    const workspaceId = getWorkspaceId(c)
    const ws = workspaceDAO.findById(workspaceId)
    if (!ws) return c.json({ error: "workspace not found" }, 404)
    const days = parseDays(c)
    return c.json(logAnalysisService.getAnomalies(workspaceId, days))
  })

  analyticsRoutes.get("/cost-analysis", (c) => {
    const workspaceId = getWorkspaceId(c)
    const ws = workspaceDAO.findById(workspaceId)
    if (!ws) return c.json({ error: "workspace not found" }, 404)
    const days = parseDays(c)
    return c.json(logAnalysisService.getCostAnalysis(workspaceId, days))
  })

  analyticsRoutes.get("/execution/:executionId/logs", async (c) => {
    const workspaceId = getWorkspaceId(c)
    const ws = workspaceDAO.findById(workspaceId)
    if (!ws) return c.json({ error: "workspace not found" }, 404)
    const executionId = c.req.param("executionId")
    if (!executionId) return c.json({ error: "executionId required" }, 400)
    const nodeId = c.req.query("nodeId")
    const result = await logAnalysisService.getExecutionLogs(workspaceId, executionId, nodeId)
    return c.json(result)
  })

  // Swarm node events — returns historical JSONL events for a specific node
  analyticsRoutes.get("/swarm-events/:executionId", (c) => {
    const workspaceId = getWorkspaceId(c)
    const ws = workspaceDAO.findById(workspaceId)
    if (!ws) return c.json({ error: "Workspace not found" }, 404)

    const executionId = c.req.param("executionId")
    const nodeId = c.req.query("nodeId")
    if (!executionId || !nodeId) return c.json({ error: "executionId and nodeId required" }, 400)
    if (!/^[a-zA-Z0-9_-]+$/.test(executionId) || executionId.length > 128) {
      return c.json({ error: "Invalid executionId format" }, 400)
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(nodeId) || nodeId.length > 128) {
      return c.json({ error: "Invalid nodeId format" }, 400)
    }

    try {
      const wsPath = (ws.path || "").replace(/^~/, os.homedir())
      const jsonlPath = join(wsPath, "logs", executionId, `${nodeId}.jsonl`)
      if (!existsSync(jsonlPath)) {
        return c.json({ events: [], status: "not_found" })
      }

      const lines = readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean)
      const events: Array<Record<string, unknown>> = []
      for (const line of lines) {
        try {
          const entry = JSON.parse(line)
          // Skip internal swarm_event wrappers — keep the actual event entries
          if (entry.event === "swarm_event") continue
          events.push(entry)
        } catch { /* skip malformed */ }
      }
      return c.json({ events, status: "completed" })
    } catch {
      return c.json({ error: "Failed to read swarm events" }, 500)
    }
  })

  analyticsRoutes.get("/swarm-stats", (c) => {
    const workspaceId = getWorkspaceId(c)
    const ws = workspaceDAO.findById(workspaceId)
    if (!ws) return c.json({ error: "Workspace not found" }, 404)

    const fromStr = c.req.query("from")
    const toStr = c.req.query("to")

    let from: Date
    let to: Date
    try {
      from = fromStr ? new Date(fromStr) : new Date(Date.now() - 30 * 86400000)
      to = toStr ? new Date(toStr) : new Date()
      if (isNaN(from.getTime()) || isNaN(to.getTime())) throw new Error()
    } catch {
      return c.json({ error: "Invalid date range" }, 400)
    }

    try {
      const wsPath = (ws.path || "").replace(/^~/, os.homedir())
      const logsDir = join(wsPath, "logs")
      const stats = aggregateSwarmStats(logsDir, from, to)
      return c.json(stats)
    } catch (e: any) {
      return c.json({ error: "Failed to aggregate swarm statistics" }, 500)
    }
  })

  // ponytail: TC-P1-004 replay export — returns swarm execution data as downloadable JSON
  analyticsRoutes.get("/swarm-replay/:executionId", (c) => {
    const workspaceId = getWorkspaceId(c)
    const ws = workspaceDAO.findById(workspaceId)
    if (!ws) return c.json({ error: "Workspace not found" }, 404)

    const executionId = c.req.param("executionId")
    if (!executionId) return c.json({ error: "executionId required" }, 400)
    // ponytail: prevent path traversal — executionId must be UUID-like or alphanumeric
    if (!/^[a-zA-Z0-9_-]+$/.test(executionId) || executionId.length > 128) {
      return c.json({ error: "Invalid executionId format" }, 400)
    }

    try {
      const wsPath = (ws.path || "").replace(/^~/, os.homedir())
      const logsDir = join(wsPath, "logs", executionId)
      if (!existsSync(logsDir)) {
        return c.json({ error: "Execution logs not found" }, 404)
      }

      const replayData = buildReplayData(logsDir, executionId)
      c.header("Content-Disposition", `attachment; filename="swarm-replay-${executionId}.json"`)
      return c.json(replayData)
    } catch {
      return c.json({ error: "Failed to build replay data" }, 500)
    }
  })

  return analyticsRoutes
}

interface SwarmStatsResponse {
  total_executions: number
  success_rate: number
  avg_duration_ms: number
  avg_token_consumed: number
  mode_distribution: { review: number; debate: number; dispatch: number; swarm: number }
  avg_rounds: number
  avg_consensus_score: number | null
  top_roles: Array<{ role: string; count: number }>
  router_accuracy: number | null
}

function aggregateSwarmStats(logsDir: string, from: Date, to: Date): SwarmStatsResponse {
  const events: Array<{
    timestamp: string; mode?: string; expert_count?: number;
    rounds_used?: number; token_consumed?: number; consensus_score?: number | null;
    duration_ms?: number; status?: string; failed_experts?: string[];
    experts?: Array<{ role: string }>;
  }> = []

  if (!existsSync(logsDir)) {
    return emptyStats()
  }

  for (const execDir of readdirSync(logsDir, { withFileTypes: true })) {
    if (!execDir.isDirectory()) continue
    const dir = join(logsDir, execDir.name)

    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".jsonl")) continue
      try {
        const lines = readFileSync(join(dir, file), "utf-8").split("\n").filter(Boolean)
        for (const line of lines) {
          try {
            const entry = JSON.parse(line)
            if (entry.event === "swarm_complete") {
              const ts = new Date(entry.timestamp)
              if (ts >= from && ts <= to) {
                events.push({
                  timestamp: entry.timestamp,
                  ...(entry.eventData || entry),
                })
              }
            }
          } catch { /* skip malformed lines */ }
        }
      } catch { /* skip unreadable files */ }
    }
  }

  if (events.length === 0) return emptyStats()

  const completed = events.filter(e => e.status === "completed").length
  const total = events.length
  const durations = events.map(e => e.duration_ms ?? 0).filter(d => d > 0)
  const tokens = events.map(e => e.token_consumed ?? 0)
  const rounds = events.map(e => e.rounds_used ?? 0).filter(r => r > 0)
  const consensus = events.map(e => e.consensus_score).filter((s): s is number => typeof s === "number")

  const modeDistribution = { review: 0, debate: 0, dispatch: 0, swarm: 0 }
  for (const e of events) {
    const mode = e.mode as keyof typeof modeDistribution
    if (mode && mode in modeDistribution) modeDistribution[mode]++
  }

  const roleCounts: Record<string, number> = {}
  for (const e of events) {
    if (e.experts) {
      for (const expert of e.experts) {
        roleCounts[expert.role] = (roleCounts[expert.role] ?? 0) + 1
      }
    }
  }
  const topRoles = Object.entries(roleCounts)
    .map(([role, count]) => ({ role, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  return {
    total_executions: total,
    success_rate: total > 0 ? completed / total : 0,
    avg_duration_ms: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
    avg_token_consumed: tokens.length > 0 ? tokens.reduce((a, b) => a + b, 0) / tokens.length : 0,
    mode_distribution: modeDistribution,
    avg_rounds: rounds.length > 0 ? rounds.reduce((a, b) => a + b, 0) / rounds.length : 0,
    avg_consensus_score: consensus.length > 0 ? consensus.reduce((a, b) => a + b, 0) / consensus.length : null,
    top_roles: topRoles,
    router_accuracy: null,
  }
}

function emptyStats(): SwarmStatsResponse {
  return {
    total_executions: 0,
    success_rate: 0,
    avg_duration_ms: 0,
    avg_token_consumed: 0,
    mode_distribution: { review: 0, debate: 0, dispatch: 0, swarm: 0 },
    avg_rounds: 0,
    avg_consensus_score: null,
    top_roles: [],
    router_accuracy: null,
  }
}

/** TC-P1-004: Build replay data from execution logs */
function buildReplayData(logsDir: string, executionId: string): {
  executionId: string
  messages: Array<{ from: string; to: string; round: number; content: string; timestamp: number }>
  experts: Array<{ role: string; status: string; rounds: number }>
  consensus_history: Array<{ round: number; score: number; should_continue: boolean }>
} {
  const messages: Array<{ from: string; to: string; round: number; content: string; timestamp: number }> = []
  const experts: Array<{ role: string; status: string; rounds: number }> = []
  const consensus_history: Array<{ round: number; score: number; should_continue: boolean }> = []

  for (const file of readdirSync(logsDir)) {
    if (!file.endsWith(".jsonl")) continue
    try {
      const lines = readFileSync(join(logsDir, file), "utf-8").split("\n").filter(Boolean)
      for (const line of lines) {
        try {
          const entry = JSON.parse(line)
          if (entry.event === "expert_message" && entry.eventData) {
            messages.push({
              from: entry.eventData.role || entry.eventData.from,
              to: "*",
              round: entry.eventData.round ?? 1,
              content: entry.eventData.content || "",
              timestamp: entry.eventData.timestamp || new Date(entry.timestamp).getTime(),
            })
          } else if (entry.event === "expert_complete" && entry.eventData) {
            experts.push({
              role: entry.eventData.role || "unknown",
              status: entry.eventData.status || "completed",
              rounds: entry.eventData.round ?? 1,
            })
          } else if (entry.event === "consensus_check" && entry.eventData) {
            consensus_history.push({
              round: entry.eventData.round ?? 1,
              score: entry.eventData.score ?? 0,
              should_continue: entry.eventData.shouldContinue ?? true,
            })
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* skip unreadable */ }
  }

  return { executionId, messages, experts, consensus_history }
}

export default createAnalyticsLogRoutes

// ─── Observability Routes (named export) ───────────────────────────
// Mounted at: /api

export function createAnalyticsRoutes(
  execDAO: ExecutionDAO,
  tokenUsageDAO: TokenUsageDAO,
  workspaceDAO: WorkspaceDAO,
  errorTracker?: { getAggregates: () => unknown },
): Hono {
  const router = new Hono()

  router.get('/executions/:id/traces', (c: Context) => {
    const executionId = c.req.param('id')
    const nodeId = c.req.query('nodeId')

    const events = execDAO.findAgentEventsWithNode(executionId, nodeId || undefined)

    const turnsByNode: Record<string, Array<Record<string, unknown>>> = {}
    for (const event of events) {
      const nodeExecId = event.node_execution_id as string
      if (!turnsByNode[nodeExecId]) turnsByNode[nodeExecId] = []
      turnsByNode[nodeExecId].push(event)
    }

    const turns = Object.entries(turnsByNode).map(([nodeExecId, nodeEvents]) => {
      const turnMap = new Map<number, Array<Record<string, unknown>>>()
      for (const event of nodeEvents) {
        const turnIndex = event.turn_index as number
        if (!turnMap.has(turnIndex)) turnMap.set(turnIndex, [])
        turnMap.get(turnIndex)!.push(event)
      }
      return {
        node_execution_id: nodeExecId,
        node_id: nodeEvents[0]?.node_id,
        turns: Array.from(turnMap.entries()).map(([turnIndex, events]) => ({
          turn_index: turnIndex,
          events,
          eventCount: events.length,
        })),
      }
    })

    return c.json({
      data: turns,
      _degraded: false,
      _message: null,
    })
  })

  router.get('/executions/:id/llm-calls', (c: Context) => {
    const executionId = c.req.param('id')
    const nodeId = c.req.query('nodeId')

    const calls = tokenUsageDAO.findLlmCallsByExecution(executionId, nodeId || undefined)

    const totalInputTokens = calls.reduce((sum, c) => sum + (c.input_tokens as number ?? 0), 0)
    const totalOutputTokens = calls.reduce((sum, c) => sum + (c.output_tokens as number ?? 0), 0)
    const totalCacheReadTokens = calls.reduce((sum, c) => sum + (c.cache_read_tokens as number ?? 0), 0)
    const totalCacheCreationTokens = calls.reduce((sum, c) => sum + (c.cache_creation_tokens as number ?? 0), 0)
    const totalCost = calls.reduce((sum, c) => sum + (c.cost_usd as number ?? 0), 0)
    const totalCacheTokens = totalCacheReadTokens + totalCacheCreationTokens
    const totalTokens = totalInputTokens + totalOutputTokens
    const cacheHitRate = totalTokens > 0 ? totalCacheTokens / totalTokens : 0

    const modelBreakdown: Record<string, { calls: number; inputTokens: number; outputTokens: number; costUsd: number }> = {}
    for (const call of calls) {
      const model = (call.model as string) ?? 'unknown'
      if (!modelBreakdown[model]) {
        modelBreakdown[model] = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
      }
      modelBreakdown[model].calls++
      modelBreakdown[model].inputTokens += call.input_tokens as number ?? 0
      modelBreakdown[model].outputTokens += call.output_tokens as number ?? 0
      modelBreakdown[model].costUsd += call.cost_usd as number ?? 0
    }

    return c.json({
      data: calls,
      aggregates: {
        totalCalls: calls.length,
        totalInputTokens,
        totalOutputTokens,
        totalCacheReadTokens,
        totalCacheCreationTokens,
        totalCost,
        cacheHitRate,
        modelBreakdown,
      },
      _degraded: false,
      _message: null,
    })
  })

  router.get('/feature-flags', (c: Context) => {
    const flags = loadFeatureFlags()
    return c.json({
      data: flags,
    })
  })

  // --- Workspace Analytics ---
  router.get('/workspaces/:id/analytics', (c: Context) => {
    const workspaceId = c.req.param('id')
    const range = c.req.query('range') ?? '7d'
    const days = range === '30d' ? 30 : range === '14d' ? 14 : 7
    const cutoff = new Date(Date.now() - days * 86400000).toISOString()
    const tsCutoff = Date.now() - days * 86400000

    const totalExecutions = execDAO.countByWorkspaceSince(workspaceId, cutoff)
    const successRate = execDAO.successRateByWorkspaceSince(workspaceId, cutoff)
    const totalCost = tokenUsageDAO.totalCostByWorkspaceSince(workspaceId, tsCutoff)
    const avgDurationMs = execDAO.avgDurationByWorkspaceSince(workspaceId, cutoff)
    const workflowStats = execDAO.workflowStatsByWorkspace(workspaceId, cutoff)
    const dailyTrend = execDAO.dailyTrendByWorkspace(workspaceId, cutoff)

    return c.json({
      data: {
        totalExecutions,
        successRate: successRate ?? 0,
        totalCost,
        avgDurationMs: avgDurationMs ?? 0,
        days,
      },
      workflows: workflowStats,
      dailyTrend,
    })
  })

  // --- Per-Workflow Analytics ---
  router.get('/workspaces/:id/analytics/workflows/:ref', (c: Context) => {
    const workspaceId = c.req.param('id')
    const ref = c.req.param('ref')
    const range = c.req.query('range') ?? '7d'
    const days = range === '30d' ? 30 : range === '14d' ? 14 : 7
    const cutoff = new Date(Date.now() - days * 86400000).toISOString()
    const tsCutoff = Date.now() - days * 86400000

    const executions = execDAO.findExecutionsByWorkflow(workspaceId, ref, cutoff, 100)

    const llmCalls = tokenUsageDAO.findLlmCallsByWorkflowSince(workspaceId, ref, tsCutoff)

    const completedCount = executions.filter((e) => e.status === 'completed').length
    const failedCount = executions.filter((e) => e.status === 'failed').length
    const successScore = (completedCount + failedCount) > 0 ? completedCount / (completedCount + failedCount) : 0

    const durations = executions.filter((e) => e.duration != null).map((e) => e.duration as number)
    const avgDuration = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0
    const durationVariance = durations.length > 1
      ? durations.reduce((sum, d) => sum + Math.pow(d - avgDuration, 2), 0) / (durations.length - 1)
      : 0
    const speedStability = Math.max(0, 1 - (Math.sqrt(durationVariance) / (avgDuration || 1)))

    const totalCost = llmCalls.reduce((sum: number, c) => sum + ((c.cost_usd as number) ?? 0), 0)
    const avgCostPerRun = executions.length > 0 ? totalCost / executions.length : 0
    const costEfficiency = Math.max(0, 1 - (avgCostPerRun / 10))

    const totalTokens = llmCalls.reduce((sum: number, c) =>
      sum + ((c.input_tokens as number) ?? 0) + ((c.output_tokens as number) ?? 0), 0)
    const cacheTokens = llmCalls.reduce((sum: number, c) =>
      sum + ((c.cache_read_tokens as number) ?? 0), 0)
    const tokenEfficiency = totalTokens > 0 ? cacheTokens / totalTokens : 0

    const retryCount = executions.filter((e) => (e.retry_count as number ?? 0) > 0).length
    const retryRate = executions.length > 0 ? retryCount / executions.length : 0
    const reliability = Math.max(0, 1 - retryRate)

    const healthScore = Math.round(
      (successScore * 0.4 + speedStability * 0.2 + costEfficiency * 0.15 + tokenEfficiency * 0.15 + reliability * 0.1) * 100
    )
    const grade = healthScore >= 90 ? 'A' : healthScore >= 75 ? 'B' : healthScore >= 60 ? 'C' : healthScore >= 40 ? 'D' : 'F'

    return c.json({
      data: {
        workflowRef: ref,
        healthScore,
        grade,
        totalExecutions: executions.length,
        successRate: successScore,
        avgDurationMs: avgDuration,
        totalCost,
        avgCostPerRun,
        healthDimensions: {
          success: Math.round(successScore * 100),
          speedStability: Math.round(speedStability * 100),
          costEfficiency: Math.round(costEfficiency * 100),
          tokenEfficiency: Math.round(tokenEfficiency * 100),
          reliability: Math.round(reliability * 100),
        },
      },
      executions,
    })
  })

  // --- Cost Analysis ---
  router.get('/workspaces/:id/analytics/cost', (c: Context) => {
    const workspaceId = c.req.param('id')
    const range = c.req.query('range') ?? '30d'
    const days = range === '30d' ? 30 : range === '14d' ? 14 : range === '7d' ? 7 : 1
    const tsCutoff = Date.now() - days * 86400000

    const costByModel = tokenUsageDAO.costByModelSince(workspaceId, tsCutoff)

    const costByWorkflow = tokenUsageDAO.costByWorkflowSince(workspaceId, tsCutoff)

    const dailyCost = tokenUsageDAO.dailyCostSince(workspaceId, tsCutoff)

    return c.json({
      data: {
        totalCost: (costByModel as Array<{ total_cost: number; calls: number }>).reduce((s, m) => s + m.total_cost, 0),
        totalCalls: (costByModel as Array<{ total_cost: number; calls: number }>).reduce((s, m) => s + m.calls, 0),
        days,
      },
      byModel: costByModel,
      byWorkflow: costByWorkflow,
      dailyTrend: dailyCost,
    })
  })

  // --- SuggestionEngine GET (generate + fetch) ---
  const suggestionEngine = new SuggestionEngine()

  router.get('/workspaces/:id/suggestions', (c: Context) => {
    const workspaceId = c.req.param('id')
    const status = c.req.query('status')

    // Build RuleContext from injected DAOs
    const ctx = { tokenDao: tokenUsageDAO, execDAO, workspaceId, workflowRef: '' }
    // Generate new suggestions from live data before returning
    suggestionEngine.generate(ctx)

    const suggestions = suggestionEngine.getSuggestions(workspaceDAO, workspaceId, status ?? undefined)

    return c.json({ data: suggestions })
  })

  // --- SuggestionEngine POST (apply) ---
  router.post('/workspaces/:id/suggestions/:sid/apply', (c: Context) => {
    const workspaceId = c.req.param('id')
    const suggestionId = c.req.param('sid')

    return c.req.json().then((changes: Record<string, unknown>) => {
      const success = suggestionEngine.applySuggestion(workspaceDAO, suggestionId, changes)
      if (!success) return c.json({ success: false, error: 'Suggestion not found' }, 404)
      return c.json({ success: true })
    })
  })

  return router
}
