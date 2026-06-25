import Database from 'better-sqlite3'
import type { DashboardSummary, TrendDirection } from '@octopus/shared'
import { ScheduleConfigDAO, ScheduleRunDAO } from '../../db/dao'

interface CacheEntry {
  data: DashboardSummary
  expiresAt: number
}

const CACHE_TTL_MS = 60_000 // 60 seconds

export class DashboardService {
  private cache = new Map<string, CacheEntry>()
  private configDAO: ScheduleConfigDAO
  private runDAO: ScheduleRunDAO

  constructor(configDAO: ScheduleConfigDAO, runDAO: ScheduleRunDAO) {
    this.configDAO = configDAO
    this.runDAO = runDAO
  }

  getSummary(range: 'all' | '24h' | '7d' | '30d' | 'custom', from?: string, to?: string): DashboardSummary {
    // Validate custom range
    if (range === 'custom' && (!from || !to)) {
      throw new Error("from and to are required when range is 'custom'")
    }

    const cacheKey = `${range}:${from ?? ''}:${to ?? ''}`
    const cached = this.cache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data
    }

    const { startDate, endDate, previousStart, previousEnd } = this.calculateTimeRange(range, from, to)

    // 1. Total active schedules (enabled and not deleted)
    const totalActive = this.configDAO.countActiveSchedules()

    // 2. Success rate for current period
    const currentStats = this.runDAO.countExecutionStatsInRange(startDate, endDate)
    const previousStats = this.runDAO.countExecutionStatsInRange(previousStart, previousEnd)

    let successRate: DashboardSummary['success_rate'] = null
    if (currentStats.total > 0) {
      const currentValue = (currentStats.success / currentStats.total) * 100
      let trend: TrendDirection = 'flat'
      let trendDelta = 0

      if (previousStats.total > 0) {
        const previousValue = (previousStats.success / previousStats.total) * 100
        trendDelta = Math.round((currentValue - previousValue) * 10) / 10
        if (trendDelta > 0.5) trend = 'up'
        else if (trendDelta < -0.5) trend = 'down'
      }

      successRate = {
        value: Math.round(currentValue * 10) / 10,
        trend,
        trend_delta: trendDelta,
      }
    }

    // 3. Failed count (schedules with consecutive_failures > 0 and enabled)
    const failedCount = this.configDAO.countFailedSchedules()

    // 4. Next trigger
    const nextTriggerRow = this.configDAO.findNextTrigger()

    let nextTrigger: DashboardSummary['next_trigger'] = null
    if (nextTriggerRow) {
      const triggerAt = new Date(nextTriggerRow.next_trigger_at)
      const countdownSeconds = Math.max(0, Math.round((triggerAt.getTime() - Date.now()) / 1000))
      nextTrigger = {
        schedule_name: nextTriggerRow.name,
        schedule_id: nextTriggerRow.id,
        trigger_at: nextTriggerRow.next_trigger_at,
        countdown_seconds: countdownSeconds,
      }
    }

    const result: DashboardSummary = {
      total_active: totalActive,
      success_rate: successRate,
      failed_count: failedCount,
      next_trigger: nextTrigger,
      range,
      computed_at: new Date().toISOString(),
    }

    // Cache result
    this.cache.set(cacheKey, { data: result, expiresAt: Date.now() + CACHE_TTL_MS })

    return result
  }

  invalidateCache(): void {
    this.cache.clear()
  }

  private calculateTimeRange(range: string, from?: string, to?: string) {
    const now = new Date()
    let startDate: string
    let endDate: string
    let durationMs: number

    if (range === 'all') {
      // No time filter: use epoch as start, no meaningful previous period
      startDate = '1970-01-01T00:00:00.000Z'
      endDate = now.toISOString()
      durationMs = 0
    } else if (range === 'custom' && from && to) {
      startDate = from
      endDate = to
      durationMs = new Date(to).getTime() - new Date(from).getTime()
    } else if (range === '7d') {
      durationMs = 7 * 24 * 60 * 60 * 1000
      startDate = new Date(now.getTime() - durationMs).toISOString()
      endDate = now.toISOString()
    } else if (range === '30d') {
      durationMs = 30 * 24 * 60 * 60 * 1000
      startDate = new Date(now.getTime() - durationMs).toISOString()
      endDate = now.toISOString()
    } else {
      // Default: 24h
      durationMs = 24 * 60 * 60 * 1000
      startDate = new Date(now.getTime() - durationMs).toISOString()
      endDate = now.toISOString()
    }

    const previousEnd = startDate
    const previousStart = new Date(new Date(startDate).getTime() - durationMs).toISOString()

    return { startDate, endDate, previousStart, previousEnd }
  }
}
