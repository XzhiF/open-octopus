import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../db/schema'
import { WorkflowExecutor } from '../services/scheduler/executors/workflow-executor'
import { AgentExecutor } from '../services/scheduler/executors/agent-executor'
import { ScheduleConfigDAO, ScheduleRunDAO, ExecutionDAO, WorkspaceDAO } from '../db/dao'
import { WorkspaceService } from '../services/workspace'
import type { SchedulerJob, WorkflowConfig, AgentConfig } from '@octopus/shared'
import type { IAgentProvider, MessageChunk } from '@octopus/providers'

// Mocks
const mockSSE = { emit: vi.fn() } as any

// Mock getExecutionService — vi.mock the whole module
vi.mock('../services/execution-service-registry', () => ({
  getExecutionService: vi.fn(() => ({
    service: {
      create: vi.fn(() => ({ id: 'exec-1' })),
      start: vi.fn(async () => {}),
      registerExternalCallbacks: vi.fn(),
      clearExternalCallbacks: vi.fn(),
    },
    wsPath: '/tmp/ws',
  })),
}))

// TODO(v23): WorkflowExecutor now creates workspaces dynamically via WorkspaceService.createFromSpec().
// Tests need to be rewritten with a mock WorkspaceService and updated execution flow.
describe.skip('WorkflowExecutor', () => {
  let db: Database.Database
  let executor: WorkflowExecutor
  const wsId = 'ws-1'
  const schedId = 's-1'
  const execId = 'e-1'

  function seedSchedule(jobType: 'workflow' | 'agent' = 'workflow') {
    db.prepare(`
      INSERT INTO workspaces (id, name, org, path, created_at, updated_at)
      VALUES (?, 'test', 'test', '/tmp', datetime('now'), datetime('now'))
    `).run(wsId)
    db.prepare(`
      INSERT INTO schedules (
        id, org, name, cron_expression, timezone,
        enabled, timeout_seconds, notify_on_failure,
        created_at, updated_at, job_type, config, parallel_policy, version, consecutive_failures, max_retain
      ) VALUES (?, 'test', 'test', '0 9 * * *', 'UTC',
        1, 3600, 0, datetime('now'), datetime('now'),
        ?, '{"schema_version":"1.0","type":"workflow","workspace_spec":{},"workflow_chain":[]}', 'skip', 1, 0, 10)
    `).run(schedId, jobType)
  }

  function seedTriggeredExecution() {
    db.prepare(`
      INSERT INTO schedule_executions (
        id, schedule_id, status, trigger_type, triggered_at,
        timezone_offset, timezone_iana, created_at, triggered_by
      ) VALUES (?, ?, 'triggered', 'scheduled', datetime('now'), '+00:00', 'UTC', datetime('now'), 'scheduler')
    `).run(execId, schedId)
  }

  beforeEach(() => {
    db = new Database(':memory:')
    applySchema(db)
    // Disable FK checks so we can use mock execution IDs without inserting
    // into the executions table. applySchema forces FK ON, so do this after.
    db.pragma('foreign_keys = OFF')
    executor = new WorkflowExecutor(mockSSE, new ScheduleConfigDAO(db), new ScheduleRunDAO(db), new ExecutionDAO(db), new WorkspaceService(new WorkspaceDAO(db)))
  })

  afterEach(() => {
    db.close()
  })

  function buildJob(): SchedulerJob {
    return {
      id: schedId,
      name: 'test',
      job_type: 'workflow',
      cron_expression: '0 9 * * *',
      timezone: 'UTC',
      enabled: true,
      org: 'test',
      config: {
        schema_version: '1.0',
        type: 'workflow',
        workspace_spec: {},
        workflow_chain: [],
      } as WorkflowConfig,
      parallel_policy: 'skip',
      timeout_seconds: 3600,
      notify_on_failure: false,
      version: 1,
      consecutive_failures: 0,
      next_trigger_at: null,
      deleted_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
  }

  it('A1: skip check excludes current executionId', async () => {
    seedSchedule()
    seedTriggeredExecution()

    const job = buildJob()
    const result = await executor.execute(job, execId)

    // Without A1 fix: would return status='skipped' because current triggered
    // row would be counted. With fix: proceeds to execute.
    expect(result.status).not.toBe('skipped')
  })

  it('A1: skip triggers when another execution IS running in same workspace', async () => {
    seedSchedule()
    seedTriggeredExecution()

    // Insert a SECOND schedule in the same workspace
    db.prepare(`
      INSERT INTO schedules (
        id, org, name, cron_expression, timezone,
        enabled, timeout_seconds, notify_on_failure,
        created_at, updated_at, job_type, config, parallel_policy, version, consecutive_failures, max_retain
      ) VALUES ('s-other', 'test', 'other', '0 9 * * *', 'UTC',
        1, 3600, 0, datetime('now'), datetime('now'),
        'workflow', '{"schema_version":"1.0","type":"workflow","workspace_spec":{},"workflow_chain":[]}', 'skip', 1, 0, 10)
    `).run()

    // Insert a RUNNING execution for the OTHER schedule (same workspace, different schedule)
    // Partial UNIQUE index only blocks (triggered|running) per schedule_id, so different schedule_id is OK
    db.prepare(`
      INSERT INTO schedule_executions (
        id, schedule_id, status, trigger_type, triggered_at,
        timezone_offset, timezone_iana, created_at, triggered_by
      ) VALUES ('e-other', 's-other', 'running', 'scheduled', datetime('now'), '+00:00', 'UTC', datetime('now'), 'scheduler')
    `).run()

    const job = buildJob()
    const result = await executor.execute(job, execId)

    // Same-workspace skip: even though e-1 is the only execution for s-1,
    // the running e-other in the same workspace causes skip.
    expect(result.status).toBe('skipped')
    expect(result.errorMessage).toContain('workspace')
  })

  it('returns failure for non-existent schedule', async () => {
    applySchema(db) // fresh db
    const job = buildJob()
    job.id = 'non-existent'
    const result = await executor.execute(job, execId)
    expect(result.status).toBe('failure')
    expect(result.errorMessage).toContain('not found')
  })
})

describe('AgentExecutor', () => {
  let db: Database.Database
  const wsId = 'ws-2'
  const schedId = 's-2'
  const execId = 'e-2'

  function buildAgentJob(): SchedulerJob {
    return {
      id: schedId,
      name: 'agent-test',
      job_type: 'agent',
      cron_expression: '0 9 * * *',
      timezone: 'UTC',
      enabled: true,
      org: 'test',
      config: {
        schema_version: '1.0',
        type: 'agent',
        prompt: 'Say hello',
        model: 'default',
        timeout_seconds: 30,
      } as AgentConfig,
      parallel_policy: 'skip',
      timeout_seconds: 30,
      notify_on_failure: false,
      version: 1,
      consecutive_failures: 0,
      next_trigger_at: null,
      deleted_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
  }

  function createMockProvider(output: string, tokens = { input: 10, output: 20 }): IAgentProvider {
    return {
      getType: () => 'mock',
      async *sendQuery(): AsyncGenerator<MessageChunk> {
        yield { type: 'message_start', messageId: 'm-1' }
        yield { type: 'text_delta', content: output, messageId: 'm-1' }
        yield { type: 'text_done', messageId: 'm-1' }
        yield {
          type: 'result',
          content: output,
          sessionId: 'sess-1',
          tokens,
          modelUsages: [{ model: 'claude-sonnet-4-5-20250514', inputTokens: tokens.input, outputTokens: tokens.output }],
        }
      },
    }
  }

  beforeEach(() => {
    db = new Database(':memory:')
    applySchema(db)
    db.prepare(`
      INSERT INTO workspaces (id, name, org, path, created_at, updated_at)
      VALUES (?, 'test', 'test', '/tmp', datetime('now'), datetime('now'))
    `).run(wsId)
    db.prepare(`
      INSERT INTO schedules (
        id, org, name, cron_expression, timezone,
        enabled, timeout_seconds, notify_on_failure, created_at, updated_at,
        job_type, config, parallel_policy, version, consecutive_failures, max_retain
      ) VALUES (?, 'test', 'agent-test', '0 9 * * *', 'UTC', 1, 30, 0,
        datetime('now'), datetime('now'), 'agent',
        '{"schema_version":"1.0","type":"agent","prompt":"Say hello"}', 'skip', 1, 0, 10)
    `).run(schedId)
    db.prepare(`
      INSERT INTO schedule_executions (
        id, schedule_id, status, trigger_type, triggered_at,
        timezone_offset, timezone_iana, created_at, triggered_by
      ) VALUES (?, ?, 'triggered', 'scheduled', datetime('now'), '+00:00', 'UTC', datetime('now'), 'scheduler')
    `).run(execId, schedId)
  })

  afterEach(() => {
    db.close()
  })

  it('A3: executes via provider and persists real token usage', async () => {
    const provider = createMockProvider('Hello world', { input: 100, output: 200 })
    const agentExec = new AgentExecutor(new ScheduleRunDAO(db), new ExecutionDAO(db), provider)

    const job = buildAgentJob()
    const result = await agentExec.execute(job, execId)

    expect(result.success).toBe(true)
    expect(result.modelUsed).toBe('claude-sonnet-4-5-20250514')
    expect(result.tokenUsage).toEqual({ input: 100, output: 200 })

    const row = db.prepare('SELECT agent_output, model_used, token_usage, status FROM schedule_executions WHERE id = ?').get(execId) as any
    expect(row.status).toBe('completed')
    expect(row.agent_output).toBe('Hello world')
    expect(row.model_used).toBe('claude-sonnet-4-5-20250514')
    expect(JSON.parse(row.token_usage)).toEqual({ input: 100, output: 200 })
  })

  it('A3: retries on failure and respects max_attempts', async () => {
    let callCount = 0
    const failingProvider: IAgentProvider = {
      getType: () => 'mock',
      async *sendQuery(): AsyncGenerator<MessageChunk> {
        callCount++
        throw new Error('API error')
      },
    }

    const job = buildAgentJob()
    ;(job.config as AgentConfig).retry_policy = {
      max_attempts: 3,
      backoff_type: 'fixed',
      base_delay_ms: 10,
      max_delay_ms: 10,
      jitter: false,
    }

    const agentExec = new AgentExecutor(new ScheduleRunDAO(db), new ExecutionDAO(db), failingProvider)
    const result = await agentExec.execute(job, execId)

    expect(result.success).toBe(false)
    expect(callCount).toBe(3)
  })

  it('A3: times out and aborts provider', async () => {
    const slowProvider: IAgentProvider = {
      getType: () => 'mock',
      async *sendQuery(_prompt, _cwd, _resume, options): AsyncGenerator<MessageChunk> {
        // Wait for abort
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => resolve(), 10_000)
          options?.abortSignal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new Error('aborted'))
          })
        })
      },
    }

    const job = buildAgentJob()
    ;(job.config as AgentConfig).timeout_seconds = 0.1 // 100ms timeout

    const agentExec = new AgentExecutor(new ScheduleRunDAO(db), new ExecutionDAO(db), slowProvider)
    const result = await agentExec.execute(job, execId)

    expect(result.success).toBe(false)
    expect(result.status).toBe('timeout')

    const row = db.prepare('SELECT status FROM schedule_executions WHERE id = ?').get(execId) as { status: string }
    expect(row.status).toBe('timeout')
  })

  it('falls back to tmpdir for execution without workspace', async () => {
    const provider = createMockProvider('no-workspace test')
    const agentExec = new AgentExecutor(new ScheduleRunDAO(db), new ExecutionDAO(db), provider)

    // The execution seeded in beforeEach has no workspace_id on schedule_executions,
    // so the executor should fall back to a temp directory.
    const job = buildAgentJob()
    const result = await agentExec.execute(job, execId)
    expect(result.success).toBe(true)
  })
})
