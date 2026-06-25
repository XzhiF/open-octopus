import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { Hono } from 'hono'
import { initDb, closeDb } from '../../db/connection'
import { applySchema } from '../../db/schema'
import { ExecutionDAO, WorkspaceDAO, TokenUsageDAO, ScheduleConfigDAO, ScheduleRunDAO } from '../../db/dao'
import { randomUUID } from 'crypto'
import { ActuatorService } from '../../services/actuator/actuator-service'
import { SecretMasker } from '../../services/actuator/secret-masker'
import { EventLoopMonitor } from '../../services/actuator/event-loop-monitor'
import { ObservabilityService } from '../../services/observability'
import { PrivacyFilter } from '../../services/privacy-filter'
import { globalErrorTracker } from '../../services/error-tracker'
import { createActuatorRoutes } from '../actuator'

const TEST_DB = path.join(os.tmpdir(), `actuator-extended-test-${Date.now()}.db`)

let app: Hono

beforeAll(() => {
  const db = initDb(TEST_DB)
  applySchema(db)

  const now = new Date().toISOString()
  db.prepare('INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), 'test-ws', 'xzf', '/tmp/test-ws', now, now)

  const executionDAO = new ExecutionDAO(db)
  const workspaceDAO = new WorkspaceDAO(db)
  const tokenUsageDAO = new TokenUsageDAO(db)
  const scheduleConfigDAO = new ScheduleConfigDAO(db)
  const scheduleRunDAO = new ScheduleRunDAO(db)
  const observability = new ObservabilityService(executionDAO, tokenUsageDAO, new PrivacyFilter())
  const secretMasker = new SecretMasker()
  const eventLoopMonitor = new EventLoopMonitor()
  const schedulerService = { listJobs: () => ({ rows: [], total: 0 }) } as any

  const actuatorService = new ActuatorService({
    db,
    executionDAO,
    workspaceDAO,
    tokenUsageDAO,
    scheduleConfigDAO,
    scheduleRunDAO,
    schedulerService,
    schedulerEngine: null,
    observability,
    secretMasker,
    errorTracker: globalErrorTracker,
    eventLoopMonitor,
    getRecoveryService: () => ({ needsRecovery: () => false, getStatus: () => null }) as any,
    getSubsystemProbes: () => ({ workflow_engine: true, workspace_service: true, scheduler_service: false, notify_subsystem: false, claude_provider: false }),
    getSafeMode: () => false,
    getRecoveryNeeded: () => false,
    startedAt: new Date(),
    port: 3001,
    mode: 'default',
    branch: null,
  })

  app = new Hono()
  app.route('/api/actuator', createActuatorRoutes(actuatorService))
})

afterAll(() => {
  closeDb()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

describe('GET /system', () => {
  it('returns complete system resource data', async () => {
    const res = await app.request('/api/actuator/system')
    expect(res.status).toBe(200)
    const data = await res.json()

    expect(data).toHaveProperty('process')
    expect(data).toHaveProperty('os')
    expect(data).toHaveProperty('event_loop')
    expect(data).toHaveProperty('executions')

    // Process
    expect(data.process).toHaveProperty('pid')
    expect(data.process).toHaveProperty('uptime_seconds')
    expect(data.process).toHaveProperty('node_version')
    expect(data.process.memory).toHaveProperty('rss_mb')
    expect(data.process.memory).toHaveProperty('heap_used_mb')
    expect(data.process.memory).toHaveProperty('heap_total_mb')
    expect(data.process.memory).toHaveProperty('external_mb')
    expect(data.process.memory).toHaveProperty('array_buffers_mb')

    // OS
    expect(data.os).toHaveProperty('platform')
    expect(data.os).toHaveProperty('arch')
    expect(data.os).toHaveProperty('cpus')
    expect(data.os).toHaveProperty('load_avg')
    expect(data.os.load_avg).toHaveLength(3)
    expect(data.os).toHaveProperty('total_mem_mb')
    expect(data.os).toHaveProperty('free_mem_mb')

    // Event loop
    expect(data.event_loop).toHaveProperty('lag_ms')
    expect(data.event_loop).toHaveProperty('utilization_percent')

    // Executions
    expect(data.executions).toHaveProperty('total')
    expect(data.executions).toHaveProperty('running')
    expect(data.executions).toHaveProperty('completed')
    expect(data.executions).toHaveProperty('failed')
    expect(data.executions).toHaveProperty('pending')
    expect(data.executions).toHaveProperty('cancelled')
  })

  it('memory values are in MB', async () => {
    const res = await app.request('/api/actuator/system')
    const data = await res.json()
    expect(data.process.memory.rss_mb).toBeGreaterThan(0)
    expect(data.os.total_mem_mb).toBeGreaterThan(0)
  })
})

describe('GET /recovery', () => {
  it('returns recovery status', async () => {
    const res = await app.request('/api/actuator/recovery')
    expect(res.status).toBe(200)
    const data = await res.json()

    expect(data).toHaveProperty('stale_executions')
    expect(data).toHaveProperty('pending_resume')
    expect(data).toHaveProperty('pending_hooks')
    expect(data).toHaveProperty('orphaned_nodes')
    expect(data).toHaveProperty('agent_recovery')
  })

  it('no stale executions when none running', async () => {
    const res = await app.request('/api/actuator/recovery')
    const data = await res.json()
    expect(data.stale_executions.count).toBe(0)
  })

  it('agent_recovery last_result is null when not run', async () => {
    const res = await app.request('/api/actuator/recovery')
    const data = await res.json()
    expect(data.agent_recovery.last_result).toBeNull()
  })
})

describe('GET /scheduler', () => {
  it('returns disabled when SchedulerEngine is null', async () => {
    const res = await app.request('/api/actuator/scheduler')
    expect(res.status).toBe(200)
    const data = await res.json()

    expect(data.status).toBe('disabled')
    expect(data.active_jobs).toBe(0)
  })
})
