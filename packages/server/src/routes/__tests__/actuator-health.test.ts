import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { Hono } from 'hono'
import { initDb, closeDb, getDb } from '../../db/connection'
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

const TEST_DB = path.join(os.tmpdir(), `actuator-health-test-${Date.now()}.db`)
const WS_ID = randomUUID()

let app: Hono

beforeAll(() => {
  const db = initDb(TEST_DB)
  applySchema(db)

  // Seed workspace
  const now = new Date().toISOString()
  db.prepare('INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(WS_ID, 'test-ws', 'xzf', '/tmp/test-ws', now, now)

  // Create actuator service with test deps
  const executionDAO = new ExecutionDAO(db)
  const workspaceDAO = new WorkspaceDAO(db)
  const tokenUsageDAO = new TokenUsageDAO(db)
  const scheduleConfigDAO = new ScheduleConfigDAO(db)
  const scheduleRunDAO = new ScheduleRunDAO(db)
  const observability = new ObservabilityService(executionDAO, tokenUsageDAO, new PrivacyFilter())
  const secretMasker = new SecretMasker()
  const eventLoopMonitor = new EventLoopMonitor()

  // Create a minimal SchedulerService mock
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
    getSubsystemProbes: () => ({
      workflow_engine: true,
      workspace_service: true,
      scheduler_service: false,
      notify_subsystem: false,
      claude_provider: false,
    }),
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

describe('Actuator Health Endpoint', () => {
  it('GET /api/actuator/health returns 200 with 5 components', async () => {
    const res = await app.request('/api/actuator/health')
    expect(res.status).toBe(200)
    const data = await res.json()

    expect(data).toHaveProperty('status')
    expect(data).toHaveProperty('timestamp')
    expect(data).toHaveProperty('components')

    const components = data.components
    expect(components).toHaveProperty('server')
    expect(components).toHaveProperty('database')
    expect(components).toHaveProperty('agent')
    expect(components).toHaveProperty('engine_pool')
    expect(components).toHaveProperty('scheduler')
  })

  it('server component contains expected fields', async () => {
    const res = await app.request('/api/actuator/health')
    const data = await res.json()
    const server = data.components.server

    expect(server.status).toBe('ok')
    expect(server.details).toHaveProperty('pid')
    expect(server.details).toHaveProperty('uptime_seconds')
    expect(server.details).toHaveProperty('started_at')
    expect(server.details).toHaveProperty('node_version')
    expect(server.details).toHaveProperty('port')
    expect(server.details).toHaveProperty('mode')
    expect(server.details).toHaveProperty('branch')
  })

  it('timestamp is ISO 8601 format', async () => {
    const res = await app.request('/api/actuator/health')
    const data = await res.json()
    expect(data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it('Content-Type is application/json', async () => {
    const res = await app.request('/api/actuator/health')
    expect(res.headers.get('content-type')).toContain('application/json')
  })

  it('all-ok returns status ok', async () => {
    const res = await app.request('/api/actuator/health')
    const data = await res.json()
    expect(['ok', 'degraded']).toContain(data.status)
  })

  it('each component has independent status', async () => {
    const res = await app.request('/api/actuator/health')
    const data = await res.json()
    for (const [name, comp] of Object.entries(data.components)) {
      expect(comp).toHaveProperty('status')
      expect(['ok', 'degraded', 'down']).toContain(comp.status)
    }
  })
})

describe('Actuator Active Executions Endpoint', () => {
  it('GET /api/actuator/executions/active returns count and executions array', async () => {
    const res = await app.request('/api/actuator/executions/active')
    expect(res.status).toBe(200)
    const data = await res.json()

    expect(data).toHaveProperty('count')
    expect(data).toHaveProperty('executions')
    expect(Array.isArray(data.executions)).toBe(true)
  })

  it('empty state returns count 0 and empty array', async () => {
    const res = await app.request('/api/actuator/executions/active')
    const data = await res.json()
    expect(data.count).toBe(0)
    expect(data.executions).toEqual([])
  })
})
