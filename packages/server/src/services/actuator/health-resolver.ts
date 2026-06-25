import type Database from 'better-sqlite3'
import type { ExecutionDAO } from '../../db/dao/execution-dao'
import type { SchedulerService } from '../scheduler/scheduler-service'
import type { SchedulerEngine } from '../scheduler/scheduler-engine'
import type { ObservabilityService } from '../observability'

// ── Types ──────────────────────────────────────────────────────────

interface HealthIndicatorResult {
  status: 'ok' | 'degraded' | 'down'
  details?: Record<string, unknown>
}

interface HealthIndicator {
  name: string
  health(): Promise<HealthIndicatorResult>
}

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'down'
  timestamp: string
  components: Record<string, HealthIndicatorResult>
}

// ── Indicators ─────────────────────────────────────────────────────

class ServerIndicator implements HealthIndicator {
  name = 'server'
  constructor(private startedAt: Date, private port: number, private mode: string, private branch: string | null) {}

  async health(): Promise<HealthIndicatorResult> {
    return {
      status: 'ok',
      details: {
        pid: process.pid,
        uptime_seconds: Math.round(process.uptime()),
        started_at: this.startedAt.toISOString(),
        node_version: process.version,
        port: this.port,
        mode: this.mode,
        branch: this.branch,
      },
    }
  }
}

class DatabaseIndicator implements HealthIndicator {
  name = 'database'
  constructor(private db: Database.Database) {}

  async health(): Promise<HealthIndicatorResult> {
    try {
      const start = performance.now()
      this.db.pragma('quick_check')
      const response_ms = Math.round((performance.now() - start) * 100) / 100
      const dbPath = this.db.name
      return { status: 'ok', details: { path: dbPath, response_ms } }
    } catch {
      return { status: 'down', details: { path: '', response_ms: -1 } }
    }
  }
}

class AgentIndicator implements HealthIndicator {
  name = 'agent'
  constructor(
    private observability: ObservabilityService,
    private getSubsystemProbes: () => Record<string, boolean>,
    private getSafeMode: () => boolean,
    private getRecoveryNeeded: () => boolean,
  ) {}

  async health(): Promise<HealthIndicatorResult> {
    const degraded = this.observability.isDegraded()
    return {
      status: degraded ? 'degraded' : 'ok',
      details: {
        subsystems: this.getSubsystemProbes(),
        safe_mode: this.getSafeMode(),
        recovery_needed: this.getRecoveryNeeded(),
      },
    }
  }
}

class EnginePoolIndicator implements HealthIndicator {
  name = 'engine_pool'
  constructor(private executionDAO: ExecutionDAO) {}

  async health(): Promise<HealthIndicatorResult> {
    try {
      const active = this.executionDAO.findAllActiveExecutions()
      return { status: 'ok', details: { active_executions: active.length } }
    } catch {
      return { status: 'ok', details: { active_executions: 0 } }
    }
  }
}

class SchedulerIndicator implements HealthIndicator {
  name = 'scheduler'
  constructor(
    private schedulerService: SchedulerService,
    private schedulerEngine: SchedulerEngine | null,
  ) {}

  async health(): Promise<HealthIndicatorResult> {
    try {
      const jobs = this.schedulerService.listJobs({ limit: 1 })
      const active = jobs.total
      const circuitBroken = this.schedulerEngine
        ? (this.schedulerEngine.getCircuitBreakerSummary().state === 'open' ? 1 : 0)
        : 0
      return { status: circuitBroken > 0 ? 'degraded' : 'ok', details: { active_jobs: active, circuit_broken: circuitBroken } }
    } catch {
      return { status: 'ok', details: { active_jobs: 0, circuit_broken: 0 } }
    }
  }
}

// ── Resolver ───────────────────────────────────────────────────────

// ponytail: 3s per-indicator timeout, 5s global — sufficient for 2-5 users polling every 5min

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ])
}

export class HealthResolver {
  private indicators: HealthIndicator[]

  constructor(indicators: HealthIndicator[]) {
    this.indicators = indicators
  }

  async resolve(): Promise<HealthResponse> {
    const fallbackResponse: HealthResponse = {
      status: 'degraded',
      timestamp: new Date().toISOString(),
      components: Object.fromEntries(
        this.indicators.map(ind => [ind.name, { status: 'degraded' as const, details: { error: 'global timeout after 5s' } }])
      ),
    }

    const results = await withTimeout(
      Promise.allSettled(
        this.indicators.map(ind =>
          withTimeout(ind.health(), 3000, { status: 'degraded' as const, details: { error: 'timeout after 3s' } })
        )
      ),
      5000,
      null as PromiseSettledResult<HealthIndicatorResult>[] | null,
    )

    if (!results) return fallbackResponse

    const components: Record<string, HealthIndicatorResult> = {}
    for (let i = 0; i < this.indicators.length; i++) {
      const result = results[i]
      components[this.indicators[i].name] = result.status === 'fulfilled'
        ? result.value
        : { status: 'degraded', details: { error: result.reason?.message ?? 'unknown error' } }
    }

    return {
      status: this.aggregateStatus(components),
      timestamp: new Date().toISOString(),
      components,
    }
  }

  private aggregateStatus(components: Record<string, HealthIndicatorResult>): 'ok' | 'degraded' | 'down' {
    const statuses = Object.values(components).map(c => c.status)
    if (statuses.includes('down')) return 'down'
    if (statuses.includes('degraded')) return 'degraded'
    return 'ok'
  }

  // Factory: create resolver with all 5 indicators
  static create(deps: {
    db: Database.Database
    executionDAO: ExecutionDAO
    observability: ObservabilityService
    schedulerService: SchedulerService
    schedulerEngine: SchedulerEngine | null
    startedAt: Date
    port: number
    mode: string
    branch: string | null
    getSubsystemProbes: () => Record<string, boolean>
    getSafeMode: () => boolean
    getRecoveryNeeded: () => boolean
  }): HealthResolver {
    return new HealthResolver([
      new ServerIndicator(deps.startedAt, deps.port, deps.mode, deps.branch),
      new DatabaseIndicator(deps.db),
      new AgentIndicator(deps.observability, deps.getSubsystemProbes, deps.getSafeMode, deps.getRecoveryNeeded),
      new EnginePoolIndicator(deps.executionDAO),
      new SchedulerIndicator(deps.schedulerService, deps.schedulerEngine),
    ])
  }
}
