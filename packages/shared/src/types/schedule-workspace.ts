export type ScheduleWorkspaceStatus = 'running' | 'completed' | 'failed'

export interface ScheduleWorkspace {
  id: string
  schedule_id: string
  workspace_id: string
  execution_id: string | null
  status: ScheduleWorkspaceStatus
  branch_suffix: string
  started_at: string
  completed_at: string | null
  error: string | null
}

export interface ListScheduleWorkspacesParams {
  page?: number
  limit?: number
  status?: ScheduleWorkspaceStatus
}
