export type AuditAction =
  | 'created' | 'updated' | 'deleted'
  | 'enabled' | 'disabled'
  | 'triggered'
  | 'ai_created' | 'ai_updated' | 'ai_deleted'

export interface SchedulerAuditLog {
  id: string
  schedule_id: string
  action: AuditAction
  actor: string
  changes: Record<string, { before: unknown; after: unknown }> | null
  ip_address: string | null
  created_at: string
}

export interface ListAuditLogsParams {
  page?: number
  limit?: number
  action?: string
}
