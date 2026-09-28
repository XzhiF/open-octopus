import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../db/schema'
import { describePg, setupPgSchema, type PgFixture } from '../db/pg/__tests__/dao-fixture'

// P1 B5 票4：schedules/schedule_executions 已落 PG（DAO 于 B5 票1 迁 BasePgDAO）；
// executions/workspaces 仍 SQLite（ExecutionDAO 未迁，票5 域）。seed 分两侧，断言跟表走。
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

// ── G2 (ticket 05): handleChainComplete failure path writes schedules.status='failed' ──
// The done path (workflow-executor.ts:355-364) already writes schedules.status='done'
// + SSE for requirement-type schedules. The failure path (372-399) historically only
// marked schedule_executions + schedule_workspaces, leaving schedules.status stuck at
// 'running' → stale rollback → infinite re-dispatch loop. This block verifies the
// failed writer mirrors the done writer.
describePg('WorkflowExecutor handleChainComplete (G2 failed writer)', () => {
  let db: Database.Database
  let pg: PgFixture
  let executor: WorkflowExecutor
  const wsId = 'g2-ws'
  const schedId = 'g2-sched'
  const execId = 'g2-exec'        // root execution id (engine-level)
  const schedExecId = 'g2-se'     // schedule_executions id
  const mockSSE = { emit: vi.fn() } as any
  const mockWorkspaceService = { delete: vi.fn() } as any

  async function seedSchedule(opts: { status?: string } = {}): Promise<void> {
    const status = opts.status ?? 'running'
    // 票03: no origin_type column any more (and no isRequirement branch in the
    // executor) — a schedule row is a job definition plus its run-state.
    const claimedAt = new Date(Date.now() - 5 * 60_000).toISOString()
    await pg.sql.unsafe(`
      INSERT INTO schedules (
        id, org, name, cron_expression, timezone,
        enabled, timeout_seconds, notify_on_failure,
        created_at, updated_at, job_type, config, parallel_policy, version,
        consecutive_failures, max_retain, status, claimed_at
      ) VALUES ($1, 'test', 'g2-task', NULL, 'UTC',
        true, 3600, false, now(), now(),
        'workflow', $2::jsonb, 'skip', 1, 0, 10, $3, $4::timestamptz)`,
      [
        schedId,
        JSON.stringify({ schema_version: '2.0', type: 'workflow', workspace_spec: { org: 'test', branch_prefix: 'b', projects: [{ name: 'p', source_path: '', group: '' }] }, workflow_chain: [{ workflow_ref: 'wf', input_values: {} }] }),
        status, claimedAt,
      ],
    )
  }

  function seedExecutionRow(status: string) {
    // Root executions row — findExecutionStatusSimple / findLastChildExecution read this.
    db.prepare(`
      INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name,
        status, triggered_by, org, created_at, updated_at)
      VALUES (?, ?, '0', 0, 'wf', 'g2-wf', ?, 'scheduler', 'test', datetime('now'), datetime('now'))
    `).run(execId, wsId, status)
  }

  async function seedSchedExecution(status: string): Promise<void> {
    await pg.sql.unsafe(`
      INSERT INTO schedule_executions (id, schedule_id, status, trigger_type, triggered_at,
        timezone_offset, timezone_iana, created_at, triggered_by)
      VALUES ($1, $2, $3, 'scheduled', now(), '+00:00', 'UTC', now(), 'scheduler')`,
      [schedExecId, schedId, status],
    )
  }

  beforeEach(async () => {
    pg = await setupPgSchema()
    db = new Database(':memory:')
    applySchema(db)
    db.pragma('foreign_keys = ON')
    db.prepare(`INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, 'g2-ws', 'test', '/tmp', datetime('now'), datetime('now'))`).run(wsId)
    executor = new WorkflowExecutor(mockSSE, new ScheduleConfigDAO(pg.sql), new ScheduleRunDAO(pg.sql), new ExecutionDAO(db), mockWorkspaceService)
    mockSSE.emit.mockClear()
  })

  afterEach(async () => { db.close(); await pg.close() })

  // Helper: call the private chain-completion handler with a failed root execution.
  async function fireChainComplete() {
    const schedule = (await new ScheduleConfigDAO(pg.sql).findById(schedId))! as any
    await (executor as any).handleChainComplete({
      executionId: execId,
      schedExecId,
      schedWsId: 'sw-nonexistent',  // findScheduleWorkspaceById → null → cleanup block skipped
      scheduleId: schedId,
      triggeredAt: Date.now() - 1000,
      notifyOnFailure: false,
      schedule,
      maxRetain: 10,
    })
  }

  it('a failed fire finalizes the FIRE, and leaves the definition alone (票03)', async () => {
    // The old pair of tests here split on isRequirement: a task-shaped schedule flipped
    // schedules.status to 'failed' (terminal, so the stale sweep would not re-queue it)
    // while a cron schedule kept its status out of the lifecycle entirely. After 票03
    // there is only the cron shape — and it is worth pinning that a failing fire does NOT
    // write the definition row, because that is what keeps enabled/disabled the single
    // source of "should this job run again".
    await seedSchedule({ status: 'queued' })
    seedExecutionRow('failed')
    await seedSchedExecution('running')

    await fireChainComplete()

    const sched = (await pg.sql<{ status: string }[]>`SELECT status FROM schedules WHERE id = ${schedId}`)[0]!
    expect(sched.status).toBe('queued')
    const se = (await pg.sql<{ status: string }[]>`SELECT status FROM schedule_executions WHERE id = ${schedExecId}`)[0]!
    expect(se.status).toBe('failed')
    const failedEmits = mockSSE.emit.mock.calls.filter((c: any[]) => c[1]?.data?.status === 'failed')
    expect(failedEmits).toHaveLength(0)
  })
})

describePg('AgentExecutor', () => {
  let db: Database.Database
  let pg: PgFixture
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
          usage: { inputTokens: tokens.input, outputTokens: tokens.output, cacheReadTokens: 0, cacheCreationTokens: 0 },
          modelUsages: [{ model: 'claude-sonnet-4-5-20250514', inputTokens: tokens.input, outputTokens: tokens.output, cacheReadTokens: 0, cacheCreationTokens: 0 }],
        }
      },
    }
  }

  beforeEach(async () => {
    pg = await setupPgSchema()
    db = new Database(':memory:')
    applySchema(db)
    db.prepare(`
      INSERT INTO workspaces (id, name, org, path, created_at, updated_at)
      VALUES (?, 'test', 'test', '/tmp', datetime('now'), datetime('now'))
    `).run(wsId)
    await pg.sql.unsafe(`
      INSERT INTO schedules (
        id, org, name, cron_expression, timezone,
        enabled, timeout_seconds, notify_on_failure, created_at, updated_at,
        job_type, config, parallel_policy, version, consecutive_failures, max_retain
      ) VALUES ($1, 'test', 'agent-test', '0 9 * * *', 'UTC', true, 30, false,
        now(), now(), 'agent',
        '{"schema_version":"1.0","type":"agent","prompt":"Say hello"}'::jsonb, 'skip', 1, 0, 10)`,
      [schedId],
    )
    await pg.sql.unsafe(`
      INSERT INTO schedule_executions (
        id, schedule_id, status, trigger_type, triggered_at,
        timezone_offset, timezone_iana, created_at, triggered_by
      ) VALUES ($1, $2, 'triggered', 'scheduled', now(), '+00:00', 'UTC', now(), 'scheduler')`,
      [execId, schedId],
    )
  })

  afterEach(async () => {
    db.close()
    await pg.close()
  })

  it('A3: executes via provider and persists real token usage', async () => {
    const provider = createMockProvider('Hello world', { input: 100, output: 200 })
    const agentExec = new AgentExecutor(new ScheduleRunDAO(pg.sql), new ExecutionDAO(db), provider)

    const job = buildAgentJob()
    const result = await agentExec.execute(job, execId)

    expect(result.success).toBe(true)
    expect(result.modelUsed).toBe('claude-sonnet-4-5-20250514')
    expect(result.tokenUsage).toEqual({ inputTokens: 100, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0 })

    const row = (await pg.sql<{ agent_output: string; model_used: string; token_usage: unknown; status: string }[]>
      `SELECT agent_output, model_used, token_usage, status FROM schedule_executions WHERE id = ${execId}`)[0]!
    expect(row.status).toBe('completed')
    expect(row.agent_output).toBe('Hello world')
    expect(row.model_used).toBe('claude-sonnet-4-5-20250514')
    // jsonb 裸读回是对象；DAO 出口才是 JSON 串 —— 语义 deep-equal
    expect(typeof row.token_usage === 'string' ? JSON.parse(row.token_usage) : row.token_usage)
      .toEqual({ inputTokens: 100, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0 })
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

    const agentExec = new AgentExecutor(new ScheduleRunDAO(pg.sql), new ExecutionDAO(db), failingProvider)
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

    const agentExec = new AgentExecutor(new ScheduleRunDAO(pg.sql), new ExecutionDAO(db), slowProvider)
    const result = await agentExec.execute(job, execId)

    expect(result.success).toBe(false)
    expect(result.status).toBe('timeout')

    const row = (await pg.sql<{ status: string }[]>`SELECT status FROM schedule_executions WHERE id = ${execId}`)[0]!
    expect(row.status).toBe('timeout')
  })

  it('falls back to tmpdir for execution without workspace', async () => {
    const provider = createMockProvider('no-workspace test')
    const agentExec = new AgentExecutor(new ScheduleRunDAO(pg.sql), new ExecutionDAO(db), provider)

    // The execution seeded in beforeEach has no workspace_id on schedule_executions,
    // so the executor should fall back to a temp directory.
    const job = buildAgentJob()
    const result = await agentExec.execute(job, execId)
    expect(result.success).toBe(true)
  })
})
