import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../db/schema'
import { ExecutionDAO } from '../db/dao/execution-dao'
import { UsageTrackerService } from '../services/scheduler/usage-tracker'

const WS_ID = 'ws-usage-test-0001-0001-0001'
const ORG = 'test-usage'

describe('UsageTrackerService', () => {
  let db: Database.Database
  let service: UsageTrackerService

  beforeAll(() => {
    db = new Database(':memory:')
    applySchema(db)

    // Insert a test workspace
    db.prepare(`
      INSERT INTO workspaces (id, name, org, path, status, source, created_at, updated_at)
      VALUES (?, 'test-ws', ?, '/tmp/test', 'active', 'manual', datetime('now'), datetime('now'))
    `).run(WS_ID, ORG)

    const executionDAO = new ExecutionDAO(db)
    service = new UsageTrackerService(executionDAO)

    // Seed execution data: 10 runs for workflow-A, 5 for workflow-B
    const now = new Date()
    for (let i = 0; i < 10; i++) {
      const id = `exec-a-${i}`
      const status = i < 7 ? 'completed' : 'failed' // 70% success, 30% failure
      const duration = 5000 + i * 100
      executionDAO.insertExecution({
        id,
        workspace_id: WS_ID,
        org: ORG,
        workflow_ref: 'workflow-a.yaml',
        workflow_name: 'Workflow A',
        status,
        duration,
        started_at: new Date(now.getTime() - i * 86400000).toISOString(),
        completed_at: new Date(now.getTime() - i * 86400000 + duration).toISOString(),
      })
    }

    for (let i = 0; i < 5; i++) {
      const id = `exec-b-${i}`
      const status = i < 1 ? 'completed' : 'failed' // 20% success, 80% failure
      const duration = 10000
      executionDAO.insertExecution({
        id,
        workspace_id: WS_ID,
        org: ORG,
        workflow_ref: 'workflow-b.yaml',
        workflow_name: 'Workflow B',
        status,
        duration,
        started_at: new Date(now.getTime() - i * 86400000).toISOString(),
        completed_at: new Date(now.getTime() - i * 86400000 + duration).toISOString(),
      })
    }

    // Workflow-C: 2 runs in 90 days — low usage
    for (let i = 0; i < 2; i++) {
      executionDAO.insertExecution({
        id: `exec-c-${i}`,
        workspace_id: WS_ID,
        org: ORG,
        workflow_ref: 'workflow-c.yaml',
        workflow_name: 'Workflow C',
        status: 'completed',
        duration: 3000,
        started_at: new Date(now.getTime() - i * 86400000 * 30).toISOString(),
        completed_at: new Date(now.getTime() - i * 86400000 * 30 + 3000).toISOString(),
      })
    }
  })

  afterAll(() => {
    db.close()
  })

  // ── getUsageStats ────────────────────────────────────────────────

  it('returns stats for a known workflow', () => {
    const stats = service.getUsageStats('workflow-a.yaml', 90)
    expect(stats).not.toBeNull()
    expect(stats!.total_runs).toBe(10)
    expect(stats!.success_runs).toBe(7)
    expect(stats!.failure_runs).toBe(3)
    expect(stats!.failure_rate).toBeCloseTo(0.3, 1)
    expect(stats!.avg_duration_ms).toBeGreaterThan(0)
  })

  it('returns null for unknown workflow', () => {
    expect(service.getUsageStats('nonexistent.yaml', 90)).toBeNull()
  })

  // ── getHighFailureWorkflows ──────────────────────────────────────

  it('returns high-failure workflows above threshold', () => {
    const items = service.getHighFailureWorkflows(0.5, 90)
    expect(items.length).toBeGreaterThanOrEqual(1)
    const b = items.find(i => i.workflow_ref === 'workflow-b.yaml')
    expect(b).toBeDefined()
    expect(b!.failure_rate).toBeGreaterThan(0.5)
  })

  it('excludes workflows below threshold', () => {
    const items = service.getHighFailureWorkflows(0.99, 90)
    const b = items.find(i => i.workflow_ref === 'workflow-b.yaml')
    // workflow-b has 80% failure, should be excluded at 99% threshold
    expect(b).toBeUndefined()
  })

  // ── getLowUsageWorkflows ─────────────────────────────────────────

  it('returns low-usage workflows below threshold', () => {
    const items = service.getLowUsageWorkflows(0.05, 90)
    expect(items.length).toBeGreaterThanOrEqual(1)
    // workflow-c has 2 runs in 90 days ≈ 0.022/day < 0.05
    const c = items.find(i => i.workflow_ref === 'workflow-c.yaml')
    expect(c).toBeDefined()
  })

  // ── listAllWorkflowStats ─────────────────────────────────────────

  it('lists all workflows sorted by usage', () => {
    const items = service.listAllWorkflowStats(90)
    expect(items.length).toBe(3)
    // Sorted descending by usage_rate
    expect(items[0].usage_rate).toBeGreaterThanOrEqual(items[1].usage_rate)
    expect(items[1].usage_rate).toBeGreaterThanOrEqual(items[2].usage_rate)
  })
})
