import type { ExecutionDAO } from "../db/dao/execution-dao"
import type { TokenUsageDAO } from "../db/dao/token-usage-dao"
import type { LlmCallRow, NodeExecutionRow, ExecutionRow } from "../db/types"
import type { TokenUsage } from "@octopus/shared"
import { emptyTokenUsage, addTokenUsage, totalTokens, costSummary, type LedgerTotals } from "@octopus/shared"
import { usageFromRow } from "../db/dao/usage-mapping"

// ── Types ──────────────────────────────────────────────────────────────

export interface ObservabilityTokenSummary {
  /** 规范用量（纯值四字段，C1）—— 取代 totalInput/totalCacheRead 平铺族 */
  usage: TokenUsage
  /** C3: 唯一规范总量（tokens/cost 三态/cacheHitRate 0-1），源 = ntu 账本 */
  totals: LedgerTotals
}

export interface ObservabilityNodeBreakdown {
  nodeId: string
  nodeName: string
  nodeType: string
  /** C3: server 单源总量行 */
  tokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** C3: 行级三态 —— null = 该组全部未定价（部分定价 = 已知和） */
  costUsd: number | null
  llmTurns: number
  loopIterations: number
  swarmRounds: number
  retryCount: number
  durationMs: number
  error: string | null
}

export interface ObservabilityModelBreakdown {
  model: string
  /** C3: server 单源总量行（web 不再四字段自加） */
  tokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** C3: 行级三态（null = 全未定价） */
  costUsd: number | null
  callCount: number
}

export interface ObservabilityTimeSeriesPoint {
  timestamp: string
  nodeId: string
  cumulativeInputTokens: number
  cumulativeOutputTokens: number
  cumulativeCostUsd: number
  turnIndex: number
}

export interface ObservabilityBudgetAlert {
  type: "warning" | "exceeded"
  metric: "tokens" | "duration" | "cost"
  threshold: number
  actual: number
  timestamp: string
}

export interface ObservabilityBudget {
  snapshot: { max_tokens?: number; max_duration?: number; max_cost_usd?: number; alert_threshold?: number } | null
  progress: {
    tokensPercent: number | null
    durationPercent: number | null
    costPercent: number | null
  }
  alerts: ObservabilityBudgetAlert[]
}

export interface ObservabilityError {
  timestamp: string
  nodeId: string
  nodeName: string
  errorType: "timeout" | "model_error" | "script_error" | "approval_rejected" | "tool_error" | "other"
  errorMessage: string
  retryCount: number
  finalStatus: "recovered" | "failed" | "skipped"
}

export interface ObservabilityRounds {
  totalLlmTurns: number
  totalLoopIterations: number
  totalSwarmRounds: number
  totalRetries: number
}

export interface ObservabilityData {
  executionId: string
  status: string
  tokens: ObservabilityTokenSummary
  byNode: ObservabilityNodeBreakdown[]
  byModel: ObservabilityModelBreakdown[]
  timeSeries: ObservabilityTimeSeriesPoint[]
  budget: ObservabilityBudget
  errors: ObservabilityError[]
  rounds: ObservabilityRounds
}

// ── Error classification ───────────────────────────────────────────────

export function classifyError(
  error: string,
  nodeType: string,
  status?: string,
  exitCode?: number | null,
): "timeout" | "model_error" | "script_error" | "approval_rejected" | "other" {
  const lowerError = error.toLowerCase()

  if (lowerError.includes("timeout") || lowerError.includes("timed out")) {
    return "timeout"
  }
  if (lowerError.includes("model") || lowerError.includes("rate_limit") || lowerError.includes("overloaded")) {
    return "model_error"
  }
  if ((nodeType === "bash" || nodeType === "python") && (exitCode != null && exitCode !== 0)) {
    return "script_error"
  }
  if (status === "rejected") {
    return "approval_rejected"
  }
  return "other"
}

// ── Service ────────────────────────────────────────────────────────────

export class ObservabilityQueryService {
  private execDao: ExecutionDAO
  private tokenDao: TokenUsageDAO

  constructor(execDao: ExecutionDAO, tokenDao: TokenUsageDAO) {
    this.execDao = execDao
    this.tokenDao = tokenDao
  }

  getObservabilityData(executionId: string): ObservabilityData {
    const execution = this.execDao.findById(executionId)
    if (!execution) {
      throw Object.assign(new Error("Execution not found"), { status: 404 })
    }

    const llmCalls = this.tokenDao.findLlmCallsByExecution(executionId)
    const nodeExecutions = this.execDao.findNodeExecutions(executionId)
    const toolErrors = this.execDao.findToolErrors(executionId)

    const tokens = this.computeTokenSummary(executionId)
    const byModel = this.computeByModel(llmCalls)
    const timeSeries = this.computeTimeSeries(llmCalls)
    const byNode = this.computeByNode(llmCalls, nodeExecutions)
    const errors = this.computeErrors(nodeExecutions, toolErrors)
    const rounds = this.computeRounds(llmCalls, nodeExecutions)
    const budget = this.computeBudget(execution, tokens, timeSeries)

    return {
      executionId,
      status: execution.status,
      tokens,
      byNode,
      byModel,
      timeSeries,
      budget,
      errors,
      rounds,
    }
  }

  private computeTokenSummary(executionId: string): ObservabilityTokenSummary {
    // C3/Q4: 总量唯一账本 = node_token_usages（aggregateByExecution 单源，与
    // steps/SSE 同源不跳变；llm_calls 只供下方明细分解）
    const m = this.tokenDao.aggregateByExecution(executionId)
    return { usage: m.usage, totals: m.totals }
  }

  private computeByModel(llmCalls: LlmCallRow[]): ObservabilityModelBreakdown[] {
    const modelMap = new Map<string, Omit<ObservabilityModelBreakdown, 'costUsd'> & { costs: Array<number | null> }>()

    for (const call of llmCalls) {
      const model = call.model ?? "unknown"
      let entry = modelMap.get(model)
      if (!entry) {
        entry = { model, tokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costs: [], callCount: 0 }
        modelMap.set(model, entry)
      }
      entry.inputTokens += call.input_tokens
      entry.outputTokens += call.output_tokens
      entry.cacheReadTokens += call.cache_read_tokens
      entry.cacheCreationTokens += call.cache_creation_tokens
      entry.costs.push(call.cost_usd)
      entry.callCount++
    }

    return Array.from(modelMap.values()).map(e => ({
      model: e.model, tokens: totalTokens({ inputTokens: e.inputTokens, outputTokens: e.outputTokens, cacheReadTokens: e.cacheReadTokens, cacheCreationTokens: e.cacheCreationTokens }),
      inputTokens: e.inputTokens, outputTokens: e.outputTokens,
      cacheReadTokens: e.cacheReadTokens, cacheCreationTokens: e.cacheCreationTokens,
      costUsd: costSummary(e.costs).usd, callCount: e.callCount,
    }))
  }

  private computeTimeSeries(llmCalls: LlmCallRow[]): ObservabilityTimeSeriesPoint[] {
    // Sort by timestamp, compute cumulative per-node
    const sorted = [...llmCalls].sort((a, b) => a.timestamp - b.timestamp)

    // Global cumulative counters
    let cumulativeInput = 0
    let cumulativeOutput = 0
    let cumulativeCost = 0

    const points: ObservabilityTimeSeriesPoint[] = []

    for (const call of sorted) {
      cumulativeInput += call.input_tokens
      cumulativeOutput += call.output_tokens
      cumulativeCost += call.cost_usd ?? 0 // ledger-ok: known-spend curve（明细累计曲线，非总量出口）

      points.push({
        timestamp: new Date(call.timestamp).toISOString(),
        nodeId: call.node_id ?? "unknown",
        cumulativeInputTokens: cumulativeInput,
        cumulativeOutputTokens: cumulativeOutput,
        cumulativeCostUsd: cumulativeCost,
        turnIndex: call.turn_index,
      })
    }

    return points
  }

  private computeByNode(
    llmCalls: LlmCallRow[],
    nodeExecutions: NodeExecutionRow[],
  ): ObservabilityNodeBreakdown[] {
    // Aggregate llm_calls by node_id
    const nodeTokenMap = new Map<string, {
      inputTokens: number
      outputTokens: number
      cacheReadTokens: number
      cacheCreationTokens: number
      costs: Array<number | null>
      llmTurns: number
    }>()

    for (const call of llmCalls) {
      const nodeId = call.node_id ?? "unknown"
      let entry = nodeTokenMap.get(nodeId)
      if (!entry) {
        entry = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costs: [], llmTurns: 0 }
        nodeTokenMap.set(nodeId, entry)
      }
      entry.inputTokens += call.input_tokens
      entry.outputTokens += call.output_tokens
      entry.cacheReadTokens += call.cache_read_tokens
      entry.cacheCreationTokens += call.cache_creation_tokens
      entry.costs.push(call.cost_usd)
      entry.llmTurns++
    }

    // Deduplicate nodes: a node can have multiple node_executions (retries/iterations).
    // Group by node_id, take the first one for metadata.
    const nodeMap = new Map<string, NodeExecutionRow>()
    for (const ne of nodeExecutions) {
      if (!nodeMap.has(ne.node_id)) {
        nodeMap.set(ne.node_id, ne)
      }
    }

    // Compute loop iterations per node: MAX(iteration_index) for children of loop nodes
    const loopIterationsByParent = this.computeLoopIterations(nodeExecutions)

    // Compute swarm rounds from node_executions with swarm-related event types
    // For simplicity, count from agent_events with swarm_round_end type
    const swarmRoundsByNode = this.computeSwarmRounds(nodeExecutions)

    // Build byNode array from all unique node_ids in nodeExecutions
    const result: ObservabilityNodeBreakdown[] = []
    const processedNodeIds = new Set<string>()

    for (const ne of nodeExecutions) {
      if (processedNodeIds.has(ne.node_id)) continue
      processedNodeIds.add(ne.node_id)

      const tokenData = nodeTokenMap.get(ne.node_id) ?? {
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costs: [], llmTurns: 0,
      }

      // Find the "primary" node execution (first one, or the one with the longest duration)
      const nodeExecsForId = nodeExecutions.filter(n => n.node_id === ne.node_id)
      const totalDuration = nodeExecsForId.reduce((sum, n) => sum + (n.duration ?? 0), 0)
      const totalRetryCount = nodeExecsForId.reduce((sum, n) => sum + (n.retry_count ?? 0), 0)
      const firstError = nodeExecsForId.find(n => n.error)?.error ?? null

      result.push({
        nodeId: ne.node_id,
        nodeName: ne.node_id,
        nodeType: ne.node_type,
        tokens: totalTokens({ inputTokens: tokenData.inputTokens, outputTokens: tokenData.outputTokens, cacheReadTokens: tokenData.cacheReadTokens, cacheCreationTokens: tokenData.cacheCreationTokens }),
        inputTokens: tokenData.inputTokens,
        outputTokens: tokenData.outputTokens,
        cacheReadTokens: tokenData.cacheReadTokens,
        cacheCreationTokens: tokenData.cacheCreationTokens,
        costUsd: costSummary(tokenData.costs).usd,
        llmTurns: tokenData.llmTurns,
        loopIterations: loopIterationsByParent.get(ne.node_id) ?? 0,
        swarmRounds: swarmRoundsByNode.get(ne.node_id) ?? 0,
        retryCount: totalRetryCount,
        durationMs: totalDuration,
        error: firstError,
      })
    }

    return result
  }

  private computeLoopIterations(nodeExecutions: NodeExecutionRow[]): Map<string, number> {
    // For loop nodes: SELECT MAX(iteration_index) FROM node_executions WHERE parent_node_id = :loopNodeId
    const result = new Map<string, number>()

    for (const ne of nodeExecutions) {
      if (ne.parent_node_id && ne.iteration_index != null) {
        const current = result.get(ne.parent_node_id) ?? 0
        if (ne.iteration_index > current) {
          result.set(ne.parent_node_id, ne.iteration_index)
        }
      }
    }

    return result
  }

  private computeSwarmRounds(nodeExecutions: NodeExecutionRow[]): Map<string, number> {
    // Swarm rounds are tracked via swarm-type node executions
    // For nodes with node_type containing "swarm", count unique iteration_index values
    const result = new Map<string, number>()

    // Group by parent_node_id for swarm children
    const swarmChildren = new Map<string, Set<number>>()
    for (const ne of nodeExecutions) {
      if (ne.node_type === "swarm" || ne.node_type === "expert") {
        // Count swarm rounds from the parent swarm node
        if (ne.parent_node_id) {
          let rounds = swarmChildren.get(ne.parent_node_id)
          if (!rounds) {
            rounds = new Set()
            swarmChildren.set(ne.parent_node_id, rounds)
          }
          if (ne.iteration_index != null) {
            rounds.add(ne.iteration_index)
          }
        }
      }
    }

    for (const [parentId, rounds] of swarmChildren) {
      result.set(parentId, rounds.size)
    }

    return result
  }

  private computeErrors(
    nodeExecutions: NodeExecutionRow[],
    toolErrors: Array<{ node_id: string; tool_name: string; tool_result: string; timestamp: number }>,
  ): ObservabilityError[] {
    const errors: ObservabilityError[] = []

    // Build node status lookup for tool error finalStatus
    const nodeStatusMap = new Map<string, string>()
    for (const ne of nodeExecutions) {
      // Keep the last status for each node (node_executions are ordered)
      nodeStatusMap.set(ne.node_id, ne.status)
    }

    // Node-level errors (from node_executions)
    for (const ne of nodeExecutions) {
      if (!ne.error) continue

      const errorType = classifyError(ne.error, ne.node_type, ne.status, ne.exit_code)

      // Determine final status: if retried and later succeeded, "recovered"
      // If still failed, "failed"
      // If skipped, "skipped"
      let finalStatus: "recovered" | "failed" | "skipped" = "failed"
      if (ne.status === "completed") {
        finalStatus = "recovered"
      } else if (ne.status === "skipped") {
        finalStatus = "skipped"
      }

      errors.push({
        timestamp: ne.started_at ?? ne.completed_at ?? new Date().toISOString(),
        nodeId: ne.node_id,
        nodeName: ne.node_id,
        errorType,
        errorMessage: ne.error,
        retryCount: ne.retry_count ?? 0,
        finalStatus,
      })
    }

    // Tool-level errors (from agent_events where tool_is_error = 1)
    // Dedup: same tool_name + similar message within same node → collapse with count
    const toolErrorMap = new Map<string, {
      node_id: string; tool_name: string; msg: string; timestamp: number; count: number
    }>()

    for (const te of toolErrors) {
      // Filter out expected/normal tool limitations (not real errors)
      const result = te.tool_result ?? ""
      if (
        (te.tool_name === "Read" && result.includes("exceeds maximum allowed tokens")) ||
        (te.tool_name === "Read" && result.includes("File does not exist")) ||
        (te.tool_name === "Glob" && result.includes("No files found")) ||
        (te.tool_name === "Grep" && result.includes("No matches found"))
      ) {
        continue
      }

      const msg = result.length > 200
        ? result.slice(0, 200) + "…"
        : (result || "Tool error")

      // Dedup key: node + tool_name + first 80 chars of message
      const key = `${te.node_id}:${te.tool_name}:${msg.slice(0, 80)}`
      const existing = toolErrorMap.get(key)
      if (existing) {
        existing.count++
        // Keep the latest timestamp
        if (te.timestamp > existing.timestamp) {
          existing.timestamp = te.timestamp
        }
      } else {
        toolErrorMap.set(key, { node_id: te.node_id, tool_name: te.tool_name, msg, timestamp: te.timestamp, count: 1 })
      }
    }

    for (const te of toolErrorMap.values()) {
      // Derive finalStatus from the owning node's status
      const nodeStatus = nodeStatusMap.get(te.node_id) ?? "completed"
      let finalStatus: "recovered" | "failed" | "skipped" = "recovered"
      if (nodeStatus === "failed") {
        finalStatus = "failed"
      } else if (nodeStatus === "skipped") {
        finalStatus = "skipped"
      }

      const countSuffix = te.count > 1 ? ` (×${te.count})` : ""

      errors.push({
        timestamp: new Date(te.timestamp).toISOString(),
        nodeId: te.node_id,
        nodeName: te.node_id,
        errorType: "tool_error",
        errorMessage: `[${te.tool_name}] ${te.msg}${countSuffix}`,
        retryCount: te.count - 1,
        finalStatus,
      })
    }

    // Sort by timestamp
    errors.sort((a, b) => a.timestamp.localeCompare(b.timestamp))

    return errors
  }

  private computeRounds(
    llmCalls: LlmCallRow[],
    nodeExecutions: NodeExecutionRow[],
  ): ObservabilityRounds {
    const totalLlmTurns = llmCalls.length

    // Total loop iterations: sum of max iteration_index per loop parent
    const loopIterationsMap = this.computeLoopIterations(nodeExecutions)
    let totalLoopIterations = 0
    for (const count of loopIterationsMap.values()) {
      totalLoopIterations += count
    }

    // Total swarm rounds
    const swarmRoundsMap = this.computeSwarmRounds(nodeExecutions)
    let totalSwarmRounds = 0
    for (const count of swarmRoundsMap.values()) {
      totalSwarmRounds += count
    }

    // Total retries: sum of retry_count across all node_executions
    const totalRetries = nodeExecutions.reduce((sum, ne) => sum + (ne.retry_count ?? 0), 0)

    return { totalLlmTurns, totalLoopIterations, totalSwarmRounds, totalRetries }
  }

  private computeBudget(
    execution: ExecutionRow,
    tokens: ObservabilityTokenSummary,
    _timeSeries: ObservabilityTimeSeriesPoint[],
  ): ObservabilityBudget {
    let snapshot: ObservabilityBudget["snapshot"] = null
    if (execution.budget_snapshot) {
      try {
        snapshot = JSON.parse(execution.budget_snapshot)
      } catch {
        snapshot = null
      }
    }

    const progress: ObservabilityBudget["progress"] = {
      tokensPercent: null,
      durationPercent: null,
      costPercent: null,
    }

    const alerts: ObservabilityBudgetAlert[] = []

    if (snapshot) {
      const mode = (snapshot as any).token_counting_mode ?? "all"
      const consumed = mode === "no_cache"
        ? tokens.usage.inputTokens + tokens.usage.outputTokens
        : totalTokens(tokens.usage)
      const alertThreshold = snapshot.alert_threshold ?? 0.8

      if (snapshot.max_tokens) {
        const pct = (consumed / snapshot.max_tokens) * 100
        progress.tokensPercent = Math.round(pct * 100) / 100

        if (pct >= alertThreshold * 100) {
          alerts.push({
            type: pct >= 100 ? "exceeded" : "warning",
            metric: "tokens",
            threshold: snapshot.max_tokens * alertThreshold,
            actual: consumed,
            timestamp: new Date().toISOString(),
          })
        }
      }

      if (snapshot.max_duration && execution.started_at) {
        const startedAt = new Date(execution.started_at).getTime()
        const elapsed = (execution.completed_at
          ? new Date(execution.completed_at).getTime()
          : Date.now()) - startedAt
        const elapsedSec = elapsed / 1000
        const pct = (elapsedSec / snapshot.max_duration) * 100
        progress.durationPercent = Math.round(pct * 100) / 100

        if (pct >= alertThreshold * 100) {
          alerts.push({
            type: pct >= 100 ? "exceeded" : "warning",
            metric: "duration",
            threshold: snapshot.max_duration * alertThreshold,
            actual: elapsedSec,
            timestamp: new Date().toISOString(),
          })
        }
      }

      if (snapshot.max_cost_usd && tokens.totals.cost.usd !== null) {
        const pct = (tokens.totals.cost.usd / snapshot.max_cost_usd) * 100
        progress.costPercent = Math.round(pct * 100) / 100

        if (pct >= alertThreshold * 100) {
          alerts.push({
            type: pct >= 100 ? "exceeded" : "warning",
            metric: "cost",
            threshold: snapshot.max_cost_usd * alertThreshold,
            actual: tokens.totals.cost.usd,
            timestamp: new Date().toISOString(),
          })
        }
      }
    }

    return { snapshot, progress, alerts }
  }
}
