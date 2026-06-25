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
