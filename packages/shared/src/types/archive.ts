// packages/shared/src/types/archive.ts
// Shared types for archive execution data — used by server routes and web-app client.

export interface ArchiveStats {
  total_executions: number
  total_cost_usd: number
  today_cost_usd: number
  week_cost_usd: number
  month_cost_usd: number
  top_workflows: {
    workflow_ref: string
    workflow_name: string
    execution_count: number
    total_cost_usd: number
  }[]
}

export interface ArchiveExecution {
  id: string
  workflow_ref: string
  workflow_name: string
  status: "completed" | "failed" | "cancelled"
  started_at: string
  completed_at: string | null
  duration_ms: number | null
  total_input_tokens: number
  total_output_tokens: number
  total_cost_usd: number
  workspace_id: string | null
  parent_execution_id: string | null
  chain_position: number | null
  created_at: string
}

export interface ArchivePaginatedResult<T> {
  data: T[]
  total: number
  page: number
  pageSize: number
}

export interface ArchiveNodeSummary {
  nodeId: string
  type: string
  status: string
  duration_ms: number | null
}

export interface ArchiveModelBreakdown {
  input_tokens: number
  output_tokens: number
  cost_usd: number
}

export interface ArchiveExperience {
  id: string
  type: string
  title: string
  content: string
  relevance_score: number
}

export interface ArchiveExecutionDetail extends ArchiveExecution {
  org: string
  node_summary: ArchiveNodeSummary[]
  failed_nodes: string[] | null
  error_message: string | null
  model_breakdown: Record<string, ArchiveModelBreakdown> | null
  vars_snapshot: Record<string, unknown>
  lessons_learned: string | null
  workspace_archive_id: string | null
  schedule_id: string | null
  clone_name: string | null
  experiences: ArchiveExperience[]
}

export interface CostTrendPoint {
  date: string
  total_cost_usd: number
  execution_count: number
}

export interface CostTrendSummary {
  total_cost_usd: number
  avg_daily_cost_usd: number
  max_daily_cost_usd: number
}

export interface WorkflowStat {
  workflow_ref: string
  workflow_name: string
  execution_count: number
  success_count: number
  failed_count: number
  success_rate: number
  total_cost_usd: number
  avg_cost_usd: number
  avg_duration_ms: number
  last_executed_at: string | null
}

export interface ExperienceItem {
  id: string
  type: "bug" | "pattern" | "cost" | "failure"
  title: string
  content: string
  status: "active" | "resolved" | "obsolete" | "superseded"
  project: string | null
  package: string | null
  file_pattern: string | null
  keywords: string[]
  relevance_score: number
  use_count: number
  workflow_name: string | null
  archive_id: string | null
  created_at: string
  updated_at: string
}

export interface LeaderboardEntry {
  rank: number
  workflow_ref: string
  workflow_name: string
  execution_count: number
  success_rate: number
  total_cost_usd: number
  avg_duration_ms: number
}
