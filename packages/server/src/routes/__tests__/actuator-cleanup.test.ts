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
import mainApp from '../../index'

const TEST_DB = path.join(os.tmpdir(), `actuator-cleanup-test-${Date.now()}.db`)

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

describe('Actuator Index Page', () => {
  it('GET /api/actuator returns HAL+JSON links', async () => {
    const res = await app.request('/api/actuator')
    expect(res.status).toBe(200)
    const data = await res.json()

    expect(data).toHaveProperty('_links')
    const links = data._links
    expect(links.self.href).toBe('/api/actuator/')
    expect(links.health.href).toBe('/api/actuator/health')
    expect(links['executions-active'].href).toBe('/api/actuator/executions/active')
    expect(links['execution-progress'].href).toContain('{id}')
    expect(links['execution-progress'].templated).toBe(true)
    expect(links.config.href).toBe('/api/actuator/config')
    expect(links.recovery.href).toBe('/api/actuator/recovery')
    expect(links.scheduler.href).toBe('/api/actuator/scheduler')
    expect(links.errors.href).toBe('/api/actuator/errors')
    expect(links.system.href).toBe('/api/actuator/system')
  })
})

describe('Old Endpoints Return 404', () => {
  it('GET /api/health returns 404', async () => {
    const res = await mainApp.request('/api/health')
    expect(res.status).toBe(404)
  })

  it('GET /api/agent/health returns 401 (auth required) or 404', async () => {
    const res = await mainApp.request('/api/agent/health')
    // Without auth token, should get 401
    expect([401, 404]).toContain(res.status)
  })

  it('GET /api/runtime/metrics returns 404', async () => {
    const res = await mainApp.request('/api/runtime/metrics')
    expect(res.status).toBe(404)
  })

  it('GET /api/runtime/errors returns 404', async () => {
    const res = await mainApp.request('/api/runtime/errors')
    expect(res.status).toBe(404)
  })

  it('GET /api/observability/status returns 404', async () => {
    const res = await mainApp.request('/api/observability/status')
    expect(res.status).toBe(404)
  })
})

describe('Unified Error Format', () => {
  it('404 errors use { error, message } format', async () => {
    const res = await app.request('/api/actuator/executions/non-existent/progress')
    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data).toHaveProperty('error')
    expect(data).toHaveProperty('message')
    expect(data.error).toBe('not_found')
  })

  it('403 errors use { error, message } format', async () => {
    const res = await app.request('/api/actuator/config')
    expect(res.status).toBe(403)
    const data = await res.json()
    expect(data).toHaveProperty('error')
    expect(data).toHaveProperty('message')
    expect(data.error).toBe('forbidden')
  })
})

describe('SecretMasker Independent Reuse', () => {
  it('can be imported and used standalone', () => {
    const masker = new SecretMasker()
    expect(masker.maskValue('API_KEY', 'my-secret-key')).toBe('my-***...key')
    expect(masker.maskValue('NODE_ENV', 'production')).toBe('production')
  })

  it('supports custom patterns', () => {
    const masker = new SecretMasker({ sensitivePatterns: [/^CUSTOM_/] })
    expect(masker.maskValue('CUSTOM_TOKEN', 'abcdef12345')).toBe('abc***...345')
  })
})

describe('All Actuator Endpoints Smoke Test', () => {
  const endpoints = ['/health', '/executions/active', '/config', '/errors', '/system', '/recovery', '/scheduler']

  for (const ep of endpoints) {
    it(`GET /api/actuator${ep} responds without crash`, async () => {
      const res = await app.request(`/api/actuator${ep}`)
      // Config will be 403 in test (no socket), others should be 200
      expect([200, 403]).toContain(res.status)
    })
  }
})
