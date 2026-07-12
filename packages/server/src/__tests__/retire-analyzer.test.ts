import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { applySchema } from '../db/schema'
import { ExecutionDAO } from '../db/dao/execution-dao'
import { UsageTrackerService } from '../services/scheduler/usage-tracker'
import { EvolutionConfigService } from '../services/scheduler/evolution-config'
import { RetireAnalyzer } from '../services/analysis/retire-analyzer'

const WS_ID = 'ws-retire-test-0001-0001-0001'
const ORG = 'test-retire'

describe('RetireAnalyzer', () => {
  let db: Database.Database
  let tmpDir: string
  let analyzer: RetireAnalyzer

  beforeAll(() => {
    db = new Database(':memory:')
    applySchema(db)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retire-analyzer-test-'))

    db.prepare(`
      INSERT INTO workspaces (id, name, org, path, status, source, created_at, updated_at)
      VALUES (?, 'test-ws', ?, '/tmp/test', 'active', 'manual', datetime('now'), datetime('now'))
    `).run(WS_ID, ORG)

    const executionDAO = new ExecutionDAO(db)
    const usageTracker = new UsageTrackerService(executionDAO)
    const configService = new EvolutionConfigService(tmpDir)
    analyzer = new RetireAnalyzer(configService, usageTracker)

    const now = new Date()

    // Workflow-A: healthy (high usage, low failure)
    for (let i = 0; i < 30; i++) {
      executionDAO.insertExecution({
        id: `ret-a-${i}`,
        workspace_id: WS_ID,
        org: ORG,
        workflow_ref: 'healthy.yaml',
        workflow_name: 'Healthy',
        status: 'completed',
        duration: 5000,
        started_at: new Date(now.getTime() - i * 86400000).toISOString(),
        completed_at: new Date(now.getTime() - i * 86400000 + 5000).toISOString(),
      })
    }

    // Workflow-B: low usage candidate (2 runs in 90 days)
    for (let i = 0; i < 2; i++) {
      executionDAO.insertExecution({
        id: `ret-b-${i}`,
        workspace_id: WS_ID,
        org: ORG,
        workflow_ref: 'low-usage.yaml',
        workflow_name: 'Low Usage',
        status: 'completed',
        duration: 3000,
        started_at: new Date(now.getTime() - i * 86400000 * 30).toISOString(),
        completed_at: new Date(now.getTime() - i * 86400000 * 30 + 3000).toISOString(),
      })
    }

    // Workflow-C: high failure candidate
    for (let i = 0; i < 10; i++) {
      executionDAO.insertExecution({
        id: `ret-c-${i}`,
        workspace_id: WS_ID,
        org: ORG,
        workflow_ref: 'high-fail.yaml',
        workflow_name: 'High Fail',
        status: i < 2 ? 'completed' : 'failed', // 80% failure
        duration: 10000,
        started_at: new Date(now.getTime() - i * 86400000).toISOString(),
        completed_at: new Date(now.getTime() - i * 86400000 + 10000).toISOString(),
      })
    }

    // Workflow-D: protected (should be excluded)
    for (let i = 0; i < 2; i++) {
      executionDAO.insertExecution({
        id: `ret-d-${i}`,
        workspace_id: WS_ID,
        org: ORG,
        workflow_ref: 'protected-wf.yaml',
        workflow_name: 'Protected',
        status: 'failed',
        duration: 1000,
        started_at: new Date(now.getTime() - i * 86400000).toISOString(),
        completed_at: new Date(now.getTime() - i * 86400000 + 1000).toISOString(),
      })
    }

    // Set protected list
    configService.updateRetireProtected('default', ['protected-wf'])
  })

  afterAll(() => {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── Usage threshold ──────────────────────────────────────────────

  it('identifies low-usage workflows as candidates', () => {
    const candidates = analyzer.analyzeRetireCandidates(90, 0.05, 0.99)
    const lowUsage = candidates.find(c => c.workflowId === 'low-usage.yaml')
    expect(lowUsage).toBeDefined()
    expect(lowUsage!.usageRate).toBeLessThan(0.05)
    expect(lowUsage!.reason.some(r => r.includes('Low usage'))).toBe(true)
  })

  // ── Failure threshold ────────────────────────────────────────────

  it('identifies high-failure workflows as candidates', () => {
    const candidates = analyzer.analyzeRetireCandidates(90, 0.001, 0.5)
    const highFail = candidates.find(c => c.workflowId === 'high-fail.yaml')
    expect(highFail).toBeDefined()
    expect(highFail!.failureRate).toBeGreaterThan(0.5)
    expect(highFail!.reason.some(r => r.includes('failure rate'))).toBe(true)
  })

  // ── Protected list filter ────────────────────────────────────────

  it('excludes protected workflows from candidates', () => {
    const candidates = analyzer.analyzeRetireCandidates(90, 1.0, 0.0) // very permissive thresholds
    const protectedWf = candidates.find(c => c.workflowId === 'protected-wf.yaml')
    expect(protectedWf).toBeUndefined()
  })

  // ── Healthy workflow excluded ────────────────────────────────────

  it('excludes healthy workflows (high usage, low failure)', () => {
    const candidates = analyzer.analyzeRetireCandidates(90, 0.05, 0.5)
    const healthy = candidates.find(c => c.workflowId === 'healthy.yaml')
    expect(healthy).toBeUndefined()
  })

  // ── Impact assessment ────────────────────────────────────────────

  it('assigns impact levels correctly', () => {
    const candidates = analyzer.analyzeRetireCandidates(90, 1.0, 0.0)
    for (const c of candidates) {
      expect(['low', 'medium', 'high']).toContain(c.impact)
    }
  })

  // ── getRetireProtected proxy ─────────────────────────────────────

  it('returns protected list via proxy method', () => {
    const protectedList = analyzer.getRetireProtected('default')
    expect(protectedList).toContain('protected-wf')
  })
})
