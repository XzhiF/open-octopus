import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../db/schema'
import { ExecutionDAO } from '../db/dao/execution-dao'
import { UsageTrackerService } from '../services/scheduler/usage-tracker'
import { WorkflowAnalyzer } from '../services/analysis/workflow-analyzer'

const WS_ID = 'ws-analyzer-test-0001-0001-001'
const ORG = 'test-analyzer'

describe('WorkflowAnalyzer', () => {
  let db: Database.Database
  let analyzer: WorkflowAnalyzer

  beforeAll(() => {
    db = new Database(':memory:')
    applySchema(db)

    db.prepare(`
      INSERT INTO workspaces (id, name, org, path, status, source, created_at, updated_at)
      VALUES (?, 'test-ws', ?, '/tmp/test', 'active', 'manual', datetime('now'), datetime('now'))
    `).run(WS_ID, ORG)

    const executionDAO = new ExecutionDAO(db)
    const usageTracker = new UsageTrackerService(executionDAO)
    analyzer = new WorkflowAnalyzer(usageTracker)

    const now = new Date()

    // Workflow-A: moderate usage, low failure (healthy)
    for (let i = 0; i < 20; i++) {
      executionDAO.insertExecution({
        id: `wf-a-${i}`,
        workspace_id: WS_ID,
        org: ORG,
        workflow_ref: 'healthy-workflow.yaml',
        workflow_name: 'Healthy',
        status: 'completed',
        duration: 30000,
        started_at: new Date(now.getTime() - i * 86400000).toISOString(),
        completed_at: new Date(now.getTime() - i * 86400000 + 30000).toISOString(),
      })
    }

    // Workflow-B: high failure rate
    for (let i = 0; i < 10; i++) {
      executionDAO.insertExecution({
        id: `wf-b-${i}`,
        workspace_id: WS_ID,
        org: ORG,
        workflow_ref: 'failing-workflow.yaml',
        workflow_name: 'Failing',
        status: i < 2 ? 'completed' : 'failed', // 80% failure
        duration: 60000,
        started_at: new Date(now.getTime() - i * 86400000).toISOString(),
        completed_at: new Date(now.getTime() - i * 86400000 + 60000).toISOString(),
      })
    }

    // Workflow-C: long running
    for (let i = 0; i < 5; i++) {
      executionDAO.insertExecution({
        id: `wf-c-${i}`,
        workspace_id: WS_ID,
        org: ORG,
        workflow_ref: 'slow-workflow.yaml',
        workflow_name: 'Slow',
        status: 'completed',
        duration: 900000, // 15 minutes
        started_at: new Date(now.getTime() - i * 86400000).toISOString(),
        completed_at: new Date(now.getTime() - i * 86400000 + 900000).toISOString(),
      })
    }
  })

  afterAll(() => {
    db.close()
  })

  // ── Top N ────────────────────────────────────────────────────────

  it('returns results limited to topN', () => {
    const results = analyzer.analyzeInefficientWorkflows(90, 2)
    expect(results.length).toBeLessThanOrEqual(2)
  })

  it('returns all workflows when topN exceeds count', () => {
    const results = analyzer.analyzeInefficientWorkflows(90, 100)
    expect(results.length).toBe(3) // all 3 workflows
  })

  // ── Rule engine ──────────────────────────────────────────────────

  it('flags high failure rate workflows', () => {
    const results = analyzer.analyzeInefficientWorkflows(90, 10)
    const failing = results.find(r => r.workflowId === 'failing-workflow.yaml')
    expect(failing).toBeDefined()
    expect(failing!.failureRate).toBeGreaterThan(0.5)
    expect(failing!.suggestions.some(s => s.includes('failure rate'))).toBe(true)
  })

  it('flags long-running workflows for parallelization', () => {
    const results = analyzer.analyzeInefficientWorkflows(90, 10)
    const slow = results.find(r => r.workflowId === 'slow-workflow.yaml')
    expect(slow).toBeDefined()
    expect(slow!.avgDurationMs).toBeGreaterThan(600000)
    expect(slow!.suggestions.some(s => s.includes('parallelization') || s.includes('duration'))).toBe(true)
  })

  it('reports no issues for healthy workflows', () => {
    const results = analyzer.analyzeInefficientWorkflows(90, 10)
    const healthy = results.find(r => r.workflowId === 'healthy-workflow.yaml')
    expect(healthy).toBeDefined()
    expect(healthy!.suggestions.some(s => s.includes('No obvious'))).toBe(true)
  })

  // ── Thresholds ───────────────────────────────────────────────────

  it('sorts results by failure rate descending', () => {
    const results = analyzer.analyzeInefficientWorkflows(90, 10)
    for (let i = 1; i < results.length; i++) {
      // Either failure rate is descending, or if equal, duration is descending
      const prev = results[i - 1]
      const curr = results[i]
      expect(
        prev.failureRate > curr.failureRate ||
        (prev.failureRate === curr.failureRate && prev.avgDurationMs >= curr.avgDurationMs),
      ).toBe(true)
    }
  })
})
