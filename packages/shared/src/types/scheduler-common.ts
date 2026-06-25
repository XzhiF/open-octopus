export interface PaginatedResponse<T> {
  items: T[]
  total: number
  page: number
  limit: number
}

export type TrendDirection = 'up' | 'down' | 'flat'

export interface DashboardSummary {
  total_active: number
  success_rate: {
    value: number | null
    trend: TrendDirection
    trend_delta: number
  } | null
  failed_count: number
  next_trigger: {
    schedule_name: string
    schedule_id: string
    trigger_at: string
    countdown_seconds: number
  } | null
  range: 'all' | '24h' | '7d' | '30d' | 'custom'
  computed_at: string
}

export interface CronParseResult {
  valid: boolean
  description: string
  next_executions: string[]
  is_high_frequency: boolean
  dst_notes: string[]
}

export interface NaturalCronResult {
  expression: string | null
  description: string
  next_executions: string[]
  confidence: 'high' | 'medium' | 'error'
  error?: string
}
