import type { SchedulerJob, CodeJobConfig } from '@octopus/shared'
import type { Executor, ExecutionResult } from './executor-interface'
import { ScheduleRunDAO } from '../../../db/dao'
import {
  resolveCodeJobHandler,
  listCodeJobHandlers,
  UnknownCodeJobHandlerError,
  type CodeJobContext,
} from '../code-job-registry'

const DEFAULT_TIMEOUT_SECONDS = 300
const MAX_SUMMARY_LENGTH = 2000

/**
 * CodeJobExecutor — runs `job_type='job'` schedules (ADR-0021).
 *
 * Third executor alongside WorkflowExecutor (YAML chains) and AgentExecutor (one LLM
 * prompt). Its body is a registered TypeScript handler, resolved by name through
 * {@link resolveCodeJobHandler}; the schedule row contributes cadence, `enabled`,
 * timeout and `args`, nothing else.
 *
 * Two properties the other two executors don't need and this one must keep:
 *
 *  1. **It is not counted as work.** The pump's concurrency cap exists to bound how many
 *     *real* runs (workflow / agent / task launches) hit the machine at once. A job fire
 *     is the janitor doing its round, so `countActiveWork()` excludes fires whose schedule
 *     is `job_type='job'` — otherwise the built-in task-lifecycle job, which runs every
 *     minute by design, would permanently eat one of the 3 slots. See that DAO method.
 *  2. **It must not be allowed to wedge the pump.** Handlers are arbitrary code, so the
 *     timeout is enforced here with an AbortSignal and the execution record is always
 *     terminal-written, including the unregistered-handler and throw paths.
 */
export class CodeJobExecutor implements Executor {
  private runDAO: ScheduleRunDAO

  constructor(runDAO: ScheduleRunDAO) {
    this.runDAO = runDAO
  }

  getType(): string {
    return 'job'
  }

  async execute(job: SchedulerJob, executionId: string): Promise<ExecutionResult> {
    const startTime = Date.now()
    this.runDAO.markExecutionRunning(executionId)

    // Parsing lives INSIDE the try: a malformed config must land as a failed fire with a
    // terminal row, not escape execute() and leave the fire stuck in 'running'.
    let config: CodeJobConfig
    try {
      config = parseCodeJobConfig(job)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[CodeJobExecutor] ${job.name} has an invalid config:`, message)
      return this.fail(executionId, Date.now() - startTime, message, 1)
    }

    const timeoutSeconds = config.timeout_seconds ?? job.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000)

    try {
      const handler = resolveCodeJobHandler(config.handler)
      const ctx: CodeJobContext = {
        scheduleId: job.id,
        jobName: job.name,
        org: job.org ?? '',
        fireId: executionId,
        args: config.args ?? {},
        signal: controller.signal,
        startedAtMs: startTime,
      }
      const outcome = await handler(ctx)
      const durationMs = Date.now() - startTime

      if (controller.signal.aborted) {
        // A handler that ignores its signal and finishes after the deadline is still a
        // timeout — the deadline, not the handler's opinion, is the contract.
        return this.fail(executionId, durationMs, `job 超时（${timeoutSeconds}s）`, 124)
      }

      const summary = summarize(outcome)
      this.runDAO.markCodeJobComplete(executionId, config.handler, summary, durationMs)
      return { success: true, exitCode: 0, durationMs, status: 'success', agentOutput: summary }
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime
      const aborted = controller.signal.aborted
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[CodeJobExecutor] ${job.name} (${config.handler}) failed:`, message)
      return this.fail(executionId, durationMs, aborted ? `job 超时（${timeoutSeconds}s）` : message, aborted ? 124 : 1)
    } finally {
      clearTimeout(timer)
    }
  }

  private fail(
    executionId: string,
    durationMs: number,
    errorSummary: string,
    exitCode: number,
  ): ExecutionResult {
    this.runDAO.markCodeJobFailed(executionId, errorSummary, durationMs, exitCode)
    return {
      success: false,
      exitCode,
      errorMessage: errorSummary,
      durationMs,
      status: exitCode === 124 ? 'timeout' : 'failure',
    }
  }
}

/**
 * The schedule's `config` for a job row. A definition created before `job` existed (or a
 * hand-edited row without `type`) still routes here by `job_type`, so an absent/foreign
 * `type` is treated as a config error rather than silently falling into the workflow path.
 */
function parseCodeJobConfig(job: SchedulerJob): CodeJobConfig {
  const raw = job.config as unknown
  const parsed = typeof raw === 'string' ? safeParse(raw) : raw
  const obj = (parsed ?? {}) as Partial<CodeJobConfig> & { handler?: unknown }
  const handler = typeof obj.handler === 'string' ? obj.handler : ''
  if (!handler) {
    throw new UnknownCodeJobHandlerError('(missing config.handler)', listCodeJobHandlers())
  }
  return {
    schema_version: '1.0',
    type: 'job',
    handler,
    timeout_seconds: typeof obj.timeout_seconds === 'number' ? obj.timeout_seconds : undefined,
    args: (obj.args ?? {}) as Record<string, unknown>,
  }
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/** `summary · runs=1 orphans=0` — the one line the ops page shows for a job fire. */
function summarize(outcome: { summary?: string; metrics?: Record<string, number> } | void): string {
  if (!outcome) return 'ok'
  const metrics = Object.entries(outcome.metrics ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
  const summary = (outcome.summary ?? 'ok').slice(0, MAX_SUMMARY_LENGTH)
  return metrics ? `${summary} ${metrics}` : summary
}
