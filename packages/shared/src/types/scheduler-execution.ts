import type { SchedulerExecutionStatus } from './scheduler-job'

export interface SchedulerExecution {
  id: string
  schedule_id: string
  status: SchedulerExecutionStatus
  trigger_type: 'scheduled' | 'manual' | 'retry'
  triggered_at: string
  completed_at: string | null
  duration_ms: number | null
  exit_code: number | null
  error_summary: string | null
  skip_reason: string | null
  triggered_by: string | null
  agent_output: string | null
  model_used: string | null
  token_usage: { input: number; output: number } | null
  metadata: Record<string, unknown>
  created_at: string
}

export interface ListExecutionsParams {
  page?: number
  limit?: number
  status?: string
}

export interface ExecutionLogResponse {
  content: string
  offset: number
  length: number
  total_size: number
  has_more: boolean
}
