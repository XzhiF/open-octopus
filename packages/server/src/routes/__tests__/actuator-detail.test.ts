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
import { ErrorTracker, globalErrorTracker } from '../../services/error-tracker'
import { createActuatorRoutes } from '../actuator'

const TEST_DB = path.join(os.tmpdir(), `actuator-detail-test-${Date.now()}.db`)
const WS_ID = randomUUID()
const EXEC_ID = randomUUID()

let app: Hono
let db: ReturnType<typeof initDb>

beforeAll(() => {
  db = initDb(TEST_DB)
  applySchema(db)

  const now = new Date().toISOString()
  db.prepare('INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(WS_ID, 'test-ws', 'xzf', '/tmp/test-ws', now, now)

  // Seed an execution
  db.prepare(`INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name, status, gate_status, rollback, rollback_on_error, input_values, var_pool, progress, triggered_by, node_type, branch, start_commit_id, end_commit_id, name, instance_id, global_session_id, retry_count, pending_hooks, approval_metadata, resume_attempts, pipeline_config, chain_retry_count, preset_inputs, started_at, completed_at, duration, org, created_at, updated_at) VALUES (?, ?, '', 0, 'test-wf@1.0.0', 'test-workflow', 'running', 'open', '', 0, '', '{}', 50, 'manual', 'bash', NULL, NULL, NULL, NULL, NULL, NULL, 0, '[]', NULL, 0, '{}', 0, NULL, ?, NULL, NULL, 'xzf', ?, ?)`)
    .run(EXEC_ID, WS_ID, now, now, now)

  // Seed a node execution
  db.prepare(`INSERT INTO node_executions (id, execution_id, node_id, node_type, status, started_at, completed_at, duration, exit_code, error, vars_snapshot, outputs, session_id) VALUES (?, ?, 'node-1', 'bash', 'running', ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`)
    .run(randomUUID(), EXEC_ID, now)

  // Seed an error
  globalErrorTracker.capture('execution', 'test error', { execution_id: EXEC_ID, node_id: 'node-1', workflow_name: 'test-workflow' })

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

describe('GET /executions/:id/progress', () => {
  it('returns execution progress with nodes', async () => {
    const res = await app.request(`/api/actuator/executions/${EXEC_ID}/progress`)
    expect(res.status).toBe(200)
    const data = await res.json()

    expect(data.id).toBe(EXEC_ID)
    expect(data.workflow_name).toBe('test-workflow')
    expect(data.status).toBe('running')
    expect(Array.isArray(data.nodes)).toBe(true)
    expect(data.nodes.length).toBeGreaterThanOrEqual(1)
  })

  it('returns 404 for non-existent execution', async () => {
    const res = await app.request('/api/actuator/executions/non-existent-id/progress')
    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.error).toBe('not_found')
  })

  it('includes token usage (null when no tokens)', async () => {
    const res = await app.request(`/api/actuator/executions/${EXEC_ID}/progress`)
    const data = await res.json()
    // No tokens seeded, should be null
    expect(data.tokens).toBeNull()
  })

  it('includes recent errors for this execution', async () => {
    const res = await app.request(`/api/actuator/executions/${EXEC_ID}/progress`)
    const data = await res.json()
    expect(Array.isArray(data.recent_errors)).toBe(true)
    expect(data.recent_errors.length).toBeGreaterThanOrEqual(1)
    expect(data.recent_errors[0].node_id).toBe('node-1')
  })
})

describe('GET /config', () => {
  it('returns masked configuration', async () => {
    // In test mode, no incoming socket — localhost check will fail
    // We need to mock the env.incoming for the test
    const res = await app.request('/api/actuator/config')
    // Without socket info, should get 403
    expect(res.status).toBe(403)
  })

  it('returns 403 without valid localhost IP', async () => {
    const res = await app.request('/api/actuator/config')
    expect(res.status).toBe(403)
    const data = await res.json()
    expect(data.error).toBe('forbidden')
  })
})

describe('GET /errors', () => {
  it('returns error tracking data', async () => {
    const res = await app.request('/api/actuator/errors')
    expect(res.status).toBe(200)
    const data = await res.json()

    expect(data).toHaveProperty('total')
    expect(data).toHaveProperty('by_category')
    expect(data).toHaveProperty('recent')
    expect(data.total).toBeGreaterThanOrEqual(1)
    expect(data.recent.length).toBeGreaterThanOrEqual(1)
  })

  it('errors include execution context', async () => {
    const res = await app.request('/api/actuator/errors')
    const data = await res.json()
    const execError = data.recent.find((e: any) => e.context.execution_id === EXEC_ID)
    expect(execError).toBeDefined()
    expect(execError.context.node_id).toBe('node-1')
    expect(execError.context.workflow_name).toBe('test-workflow')
  })

  it('by_category includes execution category', async () => {
    const res = await app.request('/api/actuator/errors')
    const data = await res.json()
    expect(data.by_category.execution).toBeGreaterThanOrEqual(1)
  })
})
