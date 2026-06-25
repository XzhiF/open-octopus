import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { TokenUsageDAO } from "../db/dao"
import { ExecutionDAO } from "../db/dao"

// === Type Definitions ===

export interface HealthSummary {
  totalExecutions: number
  successRate: number
  failureRate: number
  avgDurationMs: number
  totalCostUsd: number
  activeAlerts: number
  periodDays: number
  dailyTrend: DailyTrendPoint[]
}

export interface DailyTrendPoint {
  date: string
  successCount: number
  failedCount: number
}

export interface Alert {
  id: string
  severity: "critical" | "warning" | "info"
  category: "consecutive_failures" | "high_failure_rate" | "cost_spike" | "duration_anomaly"
  title: string
  description: string
  workflow_ref: string
  node_id?: string
  metadata: Record<string, unknown>
  detected_at: string
}

export interface ErrorCategory {
  category: "timeout" | "aborted" | "script_error" | "api_error" | "auth_error" | "unknown" | "no_error_info"
  count: number
  percentage: number
  lastSeen: string
  sampleErrors: string[]
}

export interface FragilityScore {
  nodeId: string
  nodeType: string
  workflowRef: string
  totalRuns: number
  failures: number
  failureRate: number
  fragilityScore: number
  avgDurationMs: number
  lastFailure: string
}

export interface FailureChain {
  failedNode: string
  downstreamNode: string
  downstreamStatus: string
  occurrences: number
}

export interface DurationAnomaly {
  executionId: string
  nodeId: string
  currentDurationMs: number
  meanDurationMs: number
  stddevDurationMs: number
  zScore: number
  severity: "critical" | "warning"
}

export interface ConsecutiveFailure {
  workflowRef: string
  streakLength: number
  streakStart: string
  streakEnd: string
}

export interface CostAnomaly {
  executionId: string
  workflowRef: string
  execCostUsd: number
  avgCostUsd: number
  costRatio: number
  severity: "critical" | "warning"
}

export interface CostTrendPoint {
  date: string
  totalCostUsd: number
  executionCount: number
}

export interface TokenDistribution {
  model: string
  totalInputTokens: number
  totalOutputTokens: number
  totalCostUsd: number
  cacheHitRate: number
}

export interface WorkflowCost {
  workflowRef: string
  totalCostUsd: number
  executionCount: number
  avgCostPerExecution: number
}

export interface LogContext {
  executionId: string
  nodeId: string
  error: string | null
  exitCode: number | null
  contextLines: LogLine[]
  totalLines: number
}

export interface LogLine {
  timestamp: string
  event: string
  data: unknown
}

// === Alert ID generator ===
function generateAlertId(category: string, workflowRef: string, nodeId: string | undefined, date: string): string {
  const raw = `${category}:${workflowRef}:${nodeId ?? "global"}:${date.slice(0, 10)}`
  let hash = 0
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0
  }
  return `${category}-${Math.abs(hash).toString(16).padStart(8, "0").slice(0, 16)}`
}

// === Service ===

// R2-C-1: 模块级单例工厂，确保缓存 Map 在请求间持久存在
// 添加 db 实例追踪，防止开发模式热重载后持有已关闭的旧 db 连接
let serviceInstance: LogAnalysisService | null = null

export function getLogAnalysisService(dao?: { tokenDao: TokenUsageDAO; execDao: ExecutionDAO }): LogAnalysisService {
  if (!serviceInstance && dao) {
    serviceInstance = new LogAnalysisService(dao.tokenDao, dao.execDao)
  }
  return serviceInstance!
}

export class LogAnalysisService {
  private cache = new Map<string, { data: unknown; expiresAt: number }>()
  private readonly CACHE_TTL_MS = 5 * 60 * 1000
  private readonly MAX_CACHE_SIZE = 200
  private cacheOps = 0
  private tokenDao: TokenUsageDAO
  private execDao: ExecutionDAO

  constructor(tokenDao: TokenUsageDAO, execDao: ExecutionDAO) {
    this.tokenDao = tokenDao
    this.execDao = execDao
  }

  private cached<T>(key: string, compute: () => T): T {
    const hit = this.cache.get(key)
    if (hit && hit.expiresAt > Date.now()) return hit.data as T
    const data = compute()
    this.cache.set(key, { data, expiresAt: Date.now() + this.CACHE_TTL_MS })
    // R2-H-2: 每 100 次操作或超过容量上限时清理过期条目
    if (++this.cacheOps % 100 === 0 || this.cache.size > this.MAX_CACHE_SIZE) {
      const now = Date.now()
      for (const [k, v] of this.cache) {
        if (v.expiresAt <= now) this.cache.delete(k)
      }
    }
    return data
  }

  /**
   * 清除指定 workspace 的所有缓存（在数据变更时调用）
   */
  invalidateWorkspaceCache(workspaceId: string): void {
    for (const key of this.cache.keys()) {
      if (key.includes(`:${workspaceId}:`)) {
        this.cache.delete(key)
      }
    }
  }

  getHealthSummary(workspaceId: string, days: number): HealthSummary {
    return this.cached(`health:${workspaceId}:${days}`, () => {
      const stats = this.tokenDao.getHealthStats(workspaceId, days)

      const total = stats.total || 0
      const success = stats.success_count || 0
      const failure = stats.failure_count || 0

      // Daily trend
      const trendRows = this.tokenDao.getDailyTrend(workspaceId, days)

      // Active alerts count
      const alertCount = this.tokenDao.getActiveAlertCount(workspaceId, days)

      return {
        totalExecutions: total,
        successRate: total > 0 ? Math.round((success / total) * 1000) / 10 : 0,
        failureRate: total > 0 ? Math.round((failure / total) * 1000) / 10 : 0,
        avgDurationMs: Math.round(stats.avg_duration ?? 0),
        totalCostUsd: Math.round((stats.total_cost ?? 0) * 100) / 100,
        activeAlerts: alertCount,
        periodDays: days,
        dailyTrend: trendRows.map(r => ({
          date: r.date,
          successCount: r.success_count,
          failedCount: r.failed_count,
        })),
      }
    })
  }

  getAlerts(workspaceId: string, days: number, limit: number): Alert[] {
    return this.cached(`alerts:${workspaceId}:${days}:${limit}`, () => {
      const alerts: Alert[] = []

      // 1. Consecutive failures
      const streaks = this.tokenDao.getConsecutiveFailureAlerts(workspaceId, days)

      for (const s of streaks) {
        alerts.push({
          id: generateAlertId("consecutive_failures", s.workflow_ref, undefined, s.streak_end),
          severity: s.streak_length >= 5 ? "critical" : "warning",
          category: "consecutive_failures",
          title: `${s.workflow_ref} 连续失败 ${s.streak_length} 次`,
          description: `从 ${s.streak_start.slice(0, 16)} 开始连续失败`,
          workflow_ref: s.workflow_ref,
          metadata: { streakLength: s.streak_length },
          detected_at: s.streak_end,
        })
      }

      // 2. High failure rate nodes
      const fragileNodes = this.tokenDao.getHighFailureRateAlerts(workspaceId, days)

      for (const n of fragileNodes) {
        alerts.push({
          id: generateAlertId("high_failure_rate", n.workflow_ref, n.node_id, n.last_failure ?? ""),
          severity: n.failure_pct >= 70 ? "critical" : "warning",
          category: "high_failure_rate",
          title: `${n.node_id} 节点失败率 ${n.failure_pct}%`,
          description: `${n.node_type} 节点，${n.failures}/${n.total_runs} 次失败`,
          workflow_ref: n.workflow_ref,
          node_id: n.node_id,
          metadata: { failurePct: n.failure_pct, totalRuns: n.total_runs },
          detected_at: n.last_failure ?? new Date().toISOString(),
        })
      }

      // 3. Cost spikes
      const costSpikes = this.tokenDao.getCostSpikeAlerts(workspaceId, days)

      for (const c of costSpikes) {
        alerts.push({
          id: generateAlertId("cost_spike", c.workflow_ref, undefined, c.created_at),
          severity: c.cost_ratio >= 5 ? "critical" : "warning",
          category: "cost_spike",
          title: `执行成本是均值的 ${c.cost_ratio} 倍`,
          description: `$${c.exec_cost.toFixed(2)} (均值 $${c.avg_cost.toFixed(2)})`,
          workflow_ref: c.workflow_ref,
          metadata: { executionId: c.id, costRatio: c.cost_ratio },
          detected_at: c.created_at,
        })
      }

      // Sort by severity (critical first), then by detected_at desc
      const severityOrder = { critical: 0, warning: 1, info: 2 }
      alerts.sort((a, b) => {
        const sevDiff = severityOrder[a.severity] - severityOrder[b.severity]
        if (sevDiff !== 0) return sevDiff
        return b.detected_at.localeCompare(a.detected_at)
      })

      return alerts.slice(0, limit)
    })
  }

  getFailurePatterns(workspaceId: string, days: number): {
    errorCategories: ErrorCategory[]
    fragilityRanking: FragilityScore[]
    failureChains: FailureChain[]
  } {
    return this.cached(`failures:${workspaceId}:${days}`, () => {
      // Error categories
      const catRows = this.tokenDao.getErrorCategories(workspaceId, days)

      const totalErrors = catRows.reduce((sum, r) => sum + r.count, 0)
      const errorCategories: ErrorCategory[] = catRows.map(r => ({
        category: r.error_category as ErrorCategory["category"],
        count: r.count,
        percentage: totalErrors > 0 ? Math.round((r.count / totalErrors) * 1000) / 10 : 0,
        lastSeen: r.last_seen ?? "",
        sampleErrors: r.sample_errors ? r.sample_errors.split("|||").filter(Boolean) : [],
      }))

      // Fragility ranking
      const fragRows = this.tokenDao.getFragilityRanking(workspaceId, days)

      const fragilityRanking: FragilityScore[] = fragRows.map(r => ({
        nodeId: r.node_id,
        nodeType: r.node_type,
        workflowRef: r.workflow_ref,
        totalRuns: r.total_runs,
        failures: r.failures,
        failureRate: Math.round((r.failures / r.total_runs) * 1000) / 10,
        fragilityScore: r.fragility_score,
        avgDurationMs: Math.round(r.avg_duration ?? 0),
        lastFailure: r.last_failure ?? "",
      }))

      // Failure chains
      const chainRows = this.tokenDao.getFailureChains(workspaceId, days)

      const failureChains: FailureChain[] = chainRows.map(r => ({
        failedNode: r.failed_node,
        downstreamNode: r.downstream_node,
        downstreamStatus: r.downstream_status,
        occurrences: r.occurrences,
      }))

      return { errorCategories, fragilityRanking, failureChains }
    })
  }

  getAnomalies(workspaceId: string, days: number): {
    durationAnomalies: DurationAnomaly[]
    consecutiveFailures: ConsecutiveFailure[]
    costAnomalies: CostAnomaly[]
  } {
    return this.cached(`anomalies:${workspaceId}:${days}`, () => {
      // Duration anomalies (Z-Score with Bessel correction)
      const durRows = this.tokenDao.getDurationAnomalies(workspaceId, days)

      const durationAnomalies: DurationAnomaly[] = durRows.map(r => ({
        executionId: r.execution_id,
        nodeId: r.node_id,
        currentDurationMs: r.current_duration,
        meanDurationMs: Math.round(r.mean_duration),
        stddevDurationMs: Math.round(r.stddev_duration),
        zScore: r.z_score,
        severity: r.severity as "critical" | "warning",
      }))

      // Consecutive failures
      const streakRows = this.tokenDao.getConsecutiveFailureAlerts(workspaceId, days)

      const consecutiveFailures: ConsecutiveFailure[] = streakRows.map(r => ({
        workflowRef: r.workflow_ref,
        streakLength: r.streak_length,
        streakStart: r.streak_start,
        streakEnd: r.streak_end,
      }))

      // Cost anomalies
      const costRows = this.tokenDao.getCostAnomalies(workspaceId, days)

      const costAnomalies: CostAnomaly[] = costRows
        .filter(r => r.severity !== "normal")
        .map(r => ({
          executionId: r.id,
          workflowRef: r.workflow_ref,
          execCostUsd: Math.round(r.exec_cost * 100) / 100,
          avgCostUsd: Math.round(r.avg_cost * 100) / 100,
          costRatio: r.cost_ratio,
          severity: r.severity as "critical" | "warning",
        }))

      return { durationAnomalies, consecutiveFailures, costAnomalies }
    })
  }

  getCostAnalysis(workspaceId: string, days: number): {
    costTrend: CostTrendPoint[]
    tokenDistribution: TokenDistribution[]
    costByWorkflow: WorkflowCost[]
  } {
    return this.cached(`cost:${workspaceId}:${days}`, () => {
      const trendRows = this.tokenDao.getCostTrend(workspaceId, days)

      const costTrend: CostTrendPoint[] = trendRows.map(r => ({
        date: r.date,
        totalCostUsd: Math.round(r.total_cost * 100) / 100,
        executionCount: r.exec_count,
      }))

      const tokenRows = this.tokenDao.getTokenDistribution(workspaceId, days)

      const tokenDistribution: TokenDistribution[] = tokenRows.map(r => ({
        model: r.model,
        totalInputTokens: r.total_input,
        totalOutputTokens: r.total_output,
        totalCostUsd: Math.round(r.total_cost * 100) / 100,
        cacheHitRate: r.cache_hit_rate,
      }))

      const wfRows = this.tokenDao.getCostByWorkflow(workspaceId, days)

      const costByWorkflow: WorkflowCost[] = wfRows.map(r => ({
        workflowRef: r.workflow_ref,
        totalCostUsd: Math.round(r.total_cost * 100) / 100,
        executionCount: r.exec_count,
        avgCostPerExecution: Math.round(r.avg_cost * 100) / 100,
      }))

      return { costTrend, tokenDistribution, costByWorkflow }
    })
  }

  // Safe identifier pattern: alphanumeric, dashes, underscores, dots (for UUIDs and node IDs)
  private static readonly SAFE_PATH_SEGMENT = /^[a-zA-Z0-9._-]+$/

  async getExecutionLogs(workspaceId: string, executionId: string, nodeId?: string): Promise<LogContext> {
    // Validate path segments to prevent path traversal
    if (!LogAnalysisService.SAFE_PATH_SEGMENT.test(executionId)) {
      return { executionId, nodeId: nodeId ?? "unknown", error: "Invalid execution ID format", exitCode: null, contextLines: [], totalLines: 0 }
    }
    if (nodeId && !LogAnalysisService.SAFE_PATH_SEGMENT.test(nodeId)) {
      return { executionId, nodeId, error: "Invalid node ID format", exitCode: null, contextLines: [], totalLines: 0 }
    }

    // R3-B-1 修复：仅从 executions + workspaces 获取 workspace_path
    const workspacePathRaw = this.execDao.findWorkspacePathByExecution(executionId, workspaceId)

    if (!workspacePathRaw) {
      return { executionId, nodeId: nodeId ?? "unknown", error: null, exitCode: null, contextLines: [], totalLines: 0 }
    }

    // 从 node_executions 获取 error 和 exit_code（当指定了 nodeId 时）
    const nodeExec = nodeId
      ? this.execDao.findNodeErrorAndExitCode(executionId, nodeId)
      : null

    const workspacePath = workspacePathRaw.replace(/^~/, os.homedir())
    const logDir = path.join(workspacePath, "logs", executionId)
    const logFile = nodeId
      ? path.join(logDir, `${nodeId}.jsonl`)
      : path.join(logDir, "final-summary.jsonl")

    // Defense in depth: verify resolved path stays within expected log directory
    const resolvedFile = path.resolve(logFile)
    const resolvedLogDir = path.resolve(workspacePath, "logs")
    if (!resolvedFile.startsWith(resolvedLogDir + path.sep)) {
      return { executionId, nodeId: nodeId ?? "unknown", error: "Invalid log path", exitCode: null, contextLines: [], totalLines: 0 }
    }

    if (!fs.existsSync(logFile)) {
      return { executionId, nodeId: nodeId ?? "unknown", error: nodeExec?.error ?? null, exitCode: nodeExec?.exit_code ?? null, contextLines: [], totalLines: 0 }
    }

    // 文件大小检查 - 防止大文件导致内存溢出
    const MAX_FILE_SIZE = 50 * 1024 * 1024 // 50MB
    const stats = await fs.promises.stat(logFile)
    if (stats.size > MAX_FILE_SIZE) {
      return {
        executionId,
        nodeId: nodeId ?? "unknown",
        error: `Log file too large (${(stats.size / 1024 / 1024).toFixed(1)}MB), please view directly in workspace`,
        exitCode: null,
        contextLines: [],
        totalLines: -1, // 标记为超大文件
      }
    }

    const content = await fs.promises.readFile(logFile, "utf-8")
    const lines = content.split("\n").filter(Boolean).map(line => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean) as LogLine[]

    const errorIndex = lines.findIndex(l => l.event === "error" || (l as { type?: string }).type === "error" || l.event === "end")
    const start = Math.max(0, errorIndex >= 0 ? errorIndex - 10 : lines.length - 15)
    const end = Math.min(lines.length, errorIndex >= 0 ? errorIndex + 5 : lines.length)

    return {
      executionId,
      nodeId: nodeId ?? "unknown",
      error: nodeExec?.error ?? null,
      exitCode: nodeExec?.exit_code ?? null,
      contextLines: lines.slice(start, end),
      totalLines: lines.length,
    }
  }
}
