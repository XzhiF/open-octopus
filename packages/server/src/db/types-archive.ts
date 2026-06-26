// packages/server/src/db/types-archive.ts
// Row type interfaces for archive tables (Execution Memory feature).
// Mirrors schema.sql definitions for execution_archive, workspace_archive, experience_index.

// ── Execution Archive ───────────────────────────────────────────────

export interface ExecutionArchiveRow {
  id: string
  org: string
  workspace_id: string | null
  workspace_name: string | null
  workflow_ref: string
  workflow_name: string
  status: string
  started_at: string | null
  completed_at: string | null
  duration_ms: number | null
  total_input_tokens: number
  total_output_tokens: number
  total_cost_usd: number
  node_summary: string | null
  model_breakdown: string | null
  failed_nodes: string | null
  error_message: string | null
  vars_snapshot: string | null
  lessons_learned: string | null
  parent_execution_id: string | null
  workspace_archive_id: string | null
  created_at: string
}

// ── Workspace Archive ───────────────────────────────────────────────

export interface WorkspaceArchiveRow {
  id: string
  org: string
  workspace_name: string
  execution_count: number
  total_cost_usd: number
  execution_chains: string | null
  workflow_manifest: string | null
  archived_at: string
  created_at: string
}

// ── Experience Index ────────────────────────────────────────────────

export interface ExperienceIndexRow {
  id: string
  type: string
  title: string
  content: string
  project: string | null
  package: string | null
  file_pattern: string | null
  keywords: string | null
  status: string
  relevance_score: number
  use_count: number
  workflow_name: string | null
  execution_id: string | null
  resolved_at: string | null
  resolved_by: string | null
  org: string
  created_at: string
  updated_at: string
}
