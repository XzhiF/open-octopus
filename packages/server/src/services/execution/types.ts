// packages/server/src/services/execution/types.ts
import type Database from "better-sqlite3"
import type { SSEService } from "../sse"
import type { WorkflowService } from "../workflow"
import type { BuiltInWorkflowService } from "../builtin-workflow"
import type { ObservabilityService } from "../observability"

export interface ServiceContext {
  db: Database.Database
  sse: SSEService
  workflowService: WorkflowService
  builtInWorkflowService: BuiltInWorkflowService
  org: string
  workspacePath: string
  workspaceDbId: string
  observability?: ObservabilityService
  chainCallback?: (executionId: string, status: string) => void | Promise<void>
}

export interface ExecutionRow {
  id: string
  workspace_id: string
  parent_id: string | null
  child_index: number
  workflow_ref: string
  workflow_name: string
  name: string | null
  status: string
  gate_status: string
  rollback: string
  rollback_on_error: number
  input_values: string
  var_pool: string
  progress: number
  triggered_by: string
  started_at: string | null
  completed_at: string | null
  duration: number | null
  node_type: string
  branch: string | null
  start_commit_id: string | null
  end_commit_id: string | null
  global_session_id: string | null
  approval_metadata: string | null
  org: string
  created_at: string
  updated_at: string
  // v17 新增
  chain_retry_count: number
  preset_inputs: string | null
  // v35 harness-semantic-v2: execution-level harness status
  harness_status: string | null
  harness_summary: string | null
  // v19+ interaction metadata
  interaction_metadata: string | null
  resume_attempts: number
  pipeline_config: string
  instance_id: string | null
  retry_count: number
  pending_hooks: string
}

export interface NodeExecutionRow {
  id: string
  execution_id: string
  node_id: string
  node_type: string
  status: string
  started_at: string | null
  completed_at: string | null
  duration: number | null
  exit_code: number | null
  error: string | null
  vars_snapshot: string | null
  outputs: string | null
  session_id: string | null
  retry_count: number
  last_retry_at: string | null
  parent_node_id: string | null
  iteration_index: number | null
  harness_status: string | null
  harness_interventions: string | null
}

export interface BranchExecutionRow {
  id: string
  node_execution_id: string
  iteration: number | null
  branch_label: string | null
  status: string
  started_at: string | null
  completed_at: string | null
  duration: number | null
  output: string | null
}
