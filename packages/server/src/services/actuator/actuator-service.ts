import type Database from 'better-sqlite3'
import type { ExecutionDAO } from '../../db/dao/execution-dao'
import type { WorkspaceDAO } from '../../db/dao/workspace-dao'
import type { TokenUsageDAO } from '../../db/dao/token-usage-dao'
import type { ScheduleConfigDAO } from '../../db/dao/schedule-config-dao'
import type { ScheduleRunDAO } from '../../db/dao/schedule-run-dao'
import type { SchedulerService } from '../scheduler/scheduler-service'
import type { SchedulerEngine } from '../scheduler/scheduler-engine'
import type { ObservabilityService } from '../observability'
import type { ErrorTracker } from '../error-tracker'
import type { SecretMasker } from './secret-masker'
import type { EventLoopMonitor } from './event-loop-monitor'
import { HealthResolver, type HealthResponse } from './health-resolver'
import { ExecutionResolver, type ActiveExecutionsResponse, type ExecutionProgressResponse } from './execution-resolver'
import { ConfigResolver, type ConfigResponse } from './config-resolver'
import { ErrorResolver, type ErrorsResponse } from './error-resolver'
import { SystemResolver, type SystemResponse } from './system-resolver'
import { RecoveryResolver, type RecoveryResponse } from './recovery-resolver'
import { SchedulerResolver, type SchedulerResponse } from './scheduler-resolver'

// ── Types for future resolvers (P2/P3 will implement) ──────────────

export interface ActuatorDeps {
  db: Database.Database
  executionDAO: ExecutionDAO
  workspaceDAO: WorkspaceDAO
  tokenUsageDAO: TokenUsageDAO
  scheduleConfigDAO: ScheduleConfigDAO
  scheduleRunDAO: ScheduleRunDAO
  schedulerService: SchedulerService
  schedulerEngine: SchedulerEngine | null
  observability: ObservabilityService
  secretMasker: SecretMasker
  errorTracker: ErrorTracker
  eventLoopMonitor: EventLoopMonitor
  getRecoveryService: (org: string) => { needsRecovery(): boolean; getStatus(): unknown }
  // Subsystem probe callbacks
  getSubsystemProbes: () => Record<string, boolean>
  getSafeMode: () => boolean
  getRecoveryNeeded: () => boolean
  // Server metadata
  startedAt: Date
  port: number
  mode: string
  branch: string | null
}

// ── Facade ─────────────────────────────────────────────────────────

export class ActuatorService {
  private healthResolver: HealthResolver
  private executionResolver: ExecutionResolver
  private configResolver: ConfigResolver
  private errorResolver: ErrorResolver
  private systemResolver: SystemResolver
  private recoveryResolver: RecoveryResolver
  private schedulerResolver: SchedulerResolver
  private deps: ActuatorDeps

  constructor(deps: ActuatorDeps) {
    this.deps = deps
    this.healthResolver = HealthResolver.create({
      db: deps.db,
      executionDAO: deps.executionDAO,
      observability: deps.observability,
      schedulerService: deps.schedulerService,
      schedulerEngine: deps.schedulerEngine,
      startedAt: deps.startedAt,
      port: deps.port,
      mode: deps.mode,
      branch: deps.branch,
      getSubsystemProbes: deps.getSubsystemProbes,
      getSafeMode: deps.getSafeMode,
      getRecoveryNeeded: deps.getRecoveryNeeded,
    })
    this.executionResolver = new ExecutionResolver(deps.executionDAO, deps.workspaceDAO, deps.tokenUsageDAO, deps.errorTracker)
    this.configResolver = new ConfigResolver(deps.secretMasker)
    this.errorResolver = new ErrorResolver(deps.errorTracker)
    this.systemResolver = new SystemResolver(deps.executionDAO, deps.eventLoopMonitor)
    this.recoveryResolver = new RecoveryResolver(deps.executionDAO, deps.getRecoveryService)
    this.schedulerResolver = new SchedulerResolver(deps.schedulerService, deps.schedulerEngine, deps.scheduleRunDAO)
  }

  getHealth(): Promise<HealthResponse> {
    return this.healthResolver.resolve()
  }

  getActiveExecutions(): ActiveExecutionsResponse {
    return this.executionResolver.getActiveExecutions()
  }

  getExecutionProgress(id: string): ExecutionProgressResponse | null {
    return this.executionResolver.getExecutionProgress(id)
  }

  getConfig(): ConfigResponse {
    return this.configResolver.getConfig()
  }

  getErrors(): ErrorsResponse {
    return this.errorResolver.getErrors()
  }

  getSystem(): SystemResponse {
    return this.systemResolver.getSystem()
  }

  getRecovery(org?: string): RecoveryResponse {
    return this.recoveryResolver.getRecovery(org)
  }

  getScheduler(): SchedulerResponse {
    return this.schedulerResolver.getScheduler()
  }

  getIndex(): Record<string, unknown> {
    return {
      _links: {
        self: { href: '/api/actuator/' },
        health: { href: '/api/actuator/health' },
        'executions-active': { href: '/api/actuator/executions/active' },
        'execution-progress': { href: '/api/actuator/executions/{id}/progress', templated: true },
        config: { href: '/api/actuator/config' },
        recovery: { href: '/api/actuator/recovery' },
        scheduler: { href: '/api/actuator/scheduler' },
        errors: { href: '/api/actuator/errors' },
        system: { href: '/api/actuator/system' },
      },
    }
  }
}
