import type { ExecutionDAO } from "../../db/dao/execution-dao"
import type { TokenUsageDAO } from "../../db/dao/token-usage-dao"
import type { ArchiveDAO } from "../../db/dao/archive-dao"
import type { ExecutionArchiveRow } from "../../db/types"

export interface Layer1Result {
  node_summary: Array<{ nodeId: string; type: string; status: string; duration_ms: number | null }>
  model_breakdown: Record<string, { input_tokens: number; output_tokens: number; cost_usd: number }>
  total_input_tokens: number
  total_output_tokens: number
  total_cost_usd: number
}

export interface Layer2Result {
  failed_nodes: string[]
  error_message: string | null
  vars_snapshot: Record<string, unknown>
}

export interface ExperiencePotential {
  score: number
  signals: {
    cost_anomaly: boolean
    duration_anomaly: boolean
    retry_pattern: boolean
    failure_recovery: boolean
    new_error_type: boolean
    var_pool_delta: boolean
    token_spike: boolean
  }
}

export const REFLECTION_THRESHOLD = 40

export class LayerFilter {
  constructor(
    private executionDAO: ExecutionDAO,
    private tokenUsageDAO: TokenUsageDAO,
    private archiveDAO: ArchiveDAO,
  ) {}

  extractLayer1(executionId: string): Layer1Result {
    const nodeExecs = this.executionDAO.findNodeExecutions(executionId)
    const tokenUsages = this.tokenUsageDAO.findByExecution(executionId)

    const nodeSummary = nodeExecs.map(ne => ({
      nodeId: ne.node_id,
      type: ne.node_type,
      status: ne.status,
      duration_ms: ne.duration,
    }))

    const modelBreakdown: Record<string, { input_tokens: number; output_tokens: number; cost_usd: number }> = {}
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalCostUsd = 0

    for (const tu of tokenUsages) {
      if (!modelBreakdown[tu.model]) {
        modelBreakdown[tu.model] = { input_tokens: 0, output_tokens: 0, cost_usd: 0 }
      }
      modelBreakdown[tu.model].input_tokens += tu.input_tokens
      modelBreakdown[tu.model].output_tokens += tu.output_tokens
      modelBreakdown[tu.model].cost_usd += tu.cost_usd ?? 0
      totalInputTokens += tu.input_tokens
      totalOutputTokens += tu.output_tokens
      totalCostUsd += tu.cost_usd ?? 0
    }

    return {
      node_summary: nodeSummary,
      model_breakdown: modelBreakdown,
      total_input_tokens: totalInputTokens,
      total_output_tokens: totalOutputTokens,
      total_cost_usd: totalCostUsd,
    }
  }

  extractLayer2(executionId: string, layer1: Layer1Result): Layer2Result {
    const exec = this.executionDAO.findById(executionId)
    if (!exec) throw new Error(`Execution not found: ${executionId}`)

    const nodeExecs = this.executionDAO.findNodeExecutions(executionId)
    const failedNodes = nodeExecs
      .filter(ne => ne.status === "failed")
      .map(ne => ne.node_id)

    let errorMessage: string | null = null
    if (exec.status === "failed") {
      const firstFailed = nodeExecs.find(ne => ne.status === "failed")
      errorMessage = firstFailed?.error ?? "Execution failed"
    }

    let varsSnapshot: Record<string, unknown> = {}
    try {
      varsSnapshot = JSON.parse(exec.var_pool ?? "{}")
    } catch {
      varsSnapshot = {}
    }

    return {
      failed_nodes: failedNodes,
      error_message: errorMessage,
      vars_snapshot: varsSnapshot,
    }
  }

  computeExperiencePotential(archiveId: string): ExperiencePotential {
    const archive = this.archiveDAO.findExecutionArchiveById(archiveId)
    if (!archive) {
      return {
        score: 0,
        signals: {
          cost_anomaly: false,
          duration_anomaly: false,
          retry_pattern: false,
          failure_recovery: false,
          new_error_type: false,
          var_pool_delta: false,
          token_spike: false,
        },
      }
    }

    const stats = this.archiveDAO.getRollingStats(archive.workflow_ref, 30)
    let score = 0
    const signals = {
      cost_anomaly: false,
      duration_anomaly: false,
      retry_pattern: false,
      failure_recovery: false,
      new_error_type: false,
      var_pool_delta: false,
      token_spike: false,
    }

    if (stats && stats.count > 1) {
      const costThreshold = stats.avg_cost + 2 * stats.stddev_cost
      if (archive.total_cost_usd > costThreshold) {
        signals.cost_anomaly = true
        score += 15
      }

      const durationThreshold = stats.avg_duration + 2 * stats.stddev_duration
      if (archive.duration_ms && archive.duration_ms > durationThreshold) {
        signals.duration_anomaly = true
        score += 10
      }
    }

    if (archive.failed_nodes) {
      try {
        const failedNodes = JSON.parse(archive.failed_nodes)
        if (failedNodes.length > 0) {
          signals.retry_pattern = true
          score += 15
        }
      } catch {}
    }

    if (archive.status === "failed" && archive.error_message) {
      signals.failure_recovery = true
      score += 15
    }

    if (archive.error_message) {
      signals.new_error_type = true
      score += 20
    }

    if (archive.vars_snapshot) {
      try {
        const vars = JSON.parse(archive.vars_snapshot)
        const keyCount = Object.keys(vars).length
        if (keyCount > 10) {
          signals.var_pool_delta = true
          score += 10
        }
      } catch {}
    }

    if (archive.total_input_tokens + archive.total_output_tokens > 100000) {
      signals.token_spike = true
      score += 15
    }

    return { score, signals }
  }
}
