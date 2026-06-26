export type ArchiveStatus = "completed" | "completed_with_failures" | "failed" | "cancelled"
export type ExperienceType = "bug" | "pattern" | "cost" | "failure"
export type ExperienceStatus = "active" | "resolved" | "obsolete" | "superseded"

export interface ArchiveStats {
  total_executions: number
  completed_executions: number
  failed_executions: number
  success_rate: number
  total_cost_usd: number
  total_cost_display: string
  avg_duration_ms: number | null
  top_workflows: Array<{ workflow_name: string; runs: number; total_cost_usd: number }>
}

export interface CostTrendPoint {
  date: string
  cost_usd: number
  execution_count: number
}

export interface CostTrendResponse {
  points: CostTrendPoint[]
  summary: { today_cost_usd: number; week_cost_usd: number; month_cost_usd: number }
}

export interface WorkflowStat {
  workflow_name: string
  workflow_ref: string
  runs: number
  completed_runs: number
  success_rate: number
  total_cost_usd: number
  avg_duration_ms: number | null
}

export interface LeaderboardEntry {
  id: string
  workflow_name: string
  total_cost_usd: number
  duration_ms: number | null
  status: string
  created_at: string
}

export interface LeaderboardResponse {
  cheapest: LeaderboardEntry[]
  fastest: LeaderboardEntry[]
  most_reliable: Array<{ workflow_name: string; runs: number; success_rate: number; total_cost_usd: number }>
}

export interface ArchiveExecutionListItem {
  id: string
  workflow_ref: string
  workflow_name: string
  status: ArchiveStatus
  started_at: string
  completed_at: string | null
  duration_ms: number | null
  total_cost_usd: number
  workspace_name: string | null
  workspace_id: string | null
  created_at: string
}

export interface NodeSummaryItem {
  nodeId: string
  type: string
  status: string
  duration: number
}

export interface ModelBreakdown {
  input: number
  output: number
  cost: number
}

export interface ExperienceItem {
  id: string
  type: ExperienceType
  title: string
  content: string
  project: string | null
  package: string | null
  file_pattern: string | null
  keywords: string[] | null
  status: ExperienceStatus
  relevance_score: number
  use_count: number
  workflow_name: string
  created_at: string
}

export interface ArchiveExecutionDetail {
  id: string
  org: string
  workflow_ref: string
  workflow_name: string
  status: ArchiveStatus
  started_at: string
  completed_at: string | null
  duration_ms: number | null
  total_input_tokens: number
  total_output_tokens: number
  total_cost_usd: number
  node_summary: NodeSummaryItem[]
  model_breakdown: Record<string, ModelBreakdown> | null
  failed_nodes: string[] | null
  error_message: string | null
  vars_snapshot: Record<string, unknown>
  lessons_learned: string | null
  lessons: Array<Pick<ExperienceItem, "id" | "type" | "title" | "content" | "status">>
  chain: {
    parent_execution_id: string | null
    children: Array<{ id: string; workflow_name: string; status: string }>
  }
  workspace_archive_id: string | null
  workspace_name: string | null
  created_at: string
}

export interface PaginatedResult<T> {
  data: T[]
  total: number
  page: number
  pageSize: number
}
