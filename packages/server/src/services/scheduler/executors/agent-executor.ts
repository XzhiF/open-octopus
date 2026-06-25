import Database from 'better-sqlite3'
import os from 'os'
import type { SchedulerJob, AgentConfig, AgentRetryPolicy } from '@octopus/shared'
import type { Executor, ExecutionResult } from './executor-interface'
import type { IAgentProvider, MessageChunk } from '@octopus/providers'
import { getProvider } from '@octopus/providers'
import { ScheduleRunDAO } from '../../../db/dao'
import { ExecutionDAO } from '../../../db/dao'

const DEFAULT_TIMEOUT_SECONDS = 300
const MAX_OUTPUT_LENGTH = 50_000

/**
 * Executes agent-type scheduled jobs by dispatching the prompt to the
 * configured Agent provider (ClaudeSDKProvider by default).
 *
 * Replaces the previous setTimeout mock with a real LLM call. The provider
 * streams text deltas; we accumulate them into `agent_output` and read
 * token usage + model from the terminal `result` chunk.
 */
export class AgentExecutor implements Executor {
  private runDAO: ScheduleRunDAO
  private execDAO: ExecutionDAO

  constructor(
    runDAO: ScheduleRunDAO,
    execDAO: ExecutionDAO,
    private provider?: IAgentProvider,
  ) {
    this.runDAO = runDAO
    this.execDAO = execDAO
  }

  getType(): string {
    return 'agent'
  }

  async execute(job: SchedulerJob, executionId: string): Promise<ExecutionResult> {
    const startTime = Date.now()
    const config = this.parseConfig(job)

    // 1. Update execution record to 'running'
    this.runDAO.markExecutionRunning(executionId)

    // 2. Execute with retry logic. max_attempts === 0 means "no retry, one shot".
    const retryPolicy: AgentRetryPolicy = config.retry_policy ?? {
      max_attempts: 1,
      backoff_type: 'fixed',
      base_delay_ms: 0,
      max_delay_ms: 0,
      jitter: false,
    }
    const maxAttempts = Math.max(1, retryPolicy.max_attempts || 1)

    let lastError: Error | undefined
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await this.runOnce(job, config, executionId, startTime, attempt)
        return result
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err))
        console.error(
          `[AgentExecutor] attempt ${attempt}/${maxAttempts} failed for job ${job.id}:`,
          lastError.message,
        )

        if (attempt < maxAttempts) {
          const delayMs = this.calculateDelay(retryPolicy, attempt)
          await sleep(delayMs)
        }
      }
    }

    // All attempts exhausted — record failure
    const errorMessage = lastError?.message ?? 'Agent execution failed'
    const isTimeout = lastError instanceof AgentTimeoutError

    this.runDAO.setExecutionResult(
      executionId,
      isTimeout ? 'timeout' : 'failed',
      errorMessage,
      Date.now() - startTime,
    )

    return {
      success: false,
      exitCode: isTimeout ? 124 : 1,
      errorMessage,
      durationMs: Date.now() - startTime,
      status: isTimeout ? 'timeout' : 'failure',
    }
  }

  // ── Private ────────────────────────────────────────────────────────

  private async runOnce(
    job: SchedulerJob,
    config: AgentConfig,
    executionId: string,
    startTime: number,
    _attempt: number,
  ): Promise<ExecutionResult> {
    const timeoutSeconds = config.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS
    const timeoutMs = timeoutSeconds * 1000
    const provider = this.provider ?? getProvider('claude')
    const cwd = this.resolveCwd(job.workspace_id)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let outputText = ''
    let modelUsed: string | undefined
    let tokenUsage: { input: number; output: number } | undefined
    let resultContent: string | undefined

    try {
      const stream = provider.sendQuery(config.prompt, cwd, undefined, {
        model: config.model && config.model !== 'default' ? config.model : undefined,
        abortSignal: controller.signal,
      })

      for await (const chunk of stream as AsyncGenerator<MessageChunk>) {
        if (controller.signal.aborted) break

        switch (chunk.type) {
          case 'text_delta':
            outputText += chunk.content
            // Cap accumulation to avoid unbounded memory growth; the final
            // persisted value is truncated again below.
            if (outputText.length > MAX_OUTPUT_LENGTH * 2) {
              outputText = outputText.slice(-MAX_OUTPUT_LENGTH)
            }
            break
          case 'result':
            resultContent = chunk.content
            if (chunk.tokens) {
              tokenUsage = { input: chunk.tokens.input, output: chunk.tokens.output }
            }
            if (chunk.modelUsages && chunk.modelUsages.length > 0) {
              modelUsed = chunk.modelUsages[0].model
            }
            break
          default:
            // Other chunk types (thinking, tool_call, etc.) are not persisted
            // for scheduled agent runs — only the final text + usage.
            break
        }
      }
    } catch (err: unknown) {
      if (controller.signal.aborted || err instanceof AgentTimeoutError) {
        throw new AgentTimeoutError(`Agent timed out after ${timeoutSeconds}s`)
      }
      throw err
    } finally {
      clearTimeout(timer)
    }

    // Prefer result.content (final assembled text) when available; otherwise
    // use the accumulated text_delta stream.
    const agentOutput = (resultContent && resultContent.length > 0 ? resultContent : outputText).trim()
    if (!agentOutput) {
      throw new Error('Agent returned empty output')
    }

    const finalModel = modelUsed ?? config.model ?? 'default'
    const finalTokens = tokenUsage ?? { input: 0, output: 0 }
    const durationMs = Date.now() - startTime

    this.runDAO.setAgentResult(
      executionId,
      agentOutput.length > MAX_OUTPUT_LENGTH
        ? agentOutput.substring(0, MAX_OUTPUT_LENGTH)
        : agentOutput,
      finalModel,
      JSON.stringify(finalTokens),
      durationMs,
    )

    return {
      success: true,
      exitCode: 0,
      durationMs,
      status: 'success',
      agentOutput,
      modelUsed: finalModel,
      tokenUsage: finalTokens,
    }
  }

  private parseConfig(job: SchedulerJob): AgentConfig {
    if (typeof job.config === 'object' && job.config !== null) {
      // Discriminated union: narrow to agent branch.
      if (job.config.type === 'agent') return job.config
      // Backwards compat: legacy configs without `type` field.
      return job.config as unknown as AgentConfig
    }
    try {
      return JSON.parse(job.config as unknown as string) as AgentConfig
    } catch {
      return {
        schema_version: '1.0',
        type: 'agent',
        prompt: '',
        model: 'default',
        timeout_seconds: DEFAULT_TIMEOUT_SECONDS,
      }
    }
  }

  private resolveCwd(workspaceId: string | null | undefined): string {
    if (!workspaceId) return os.tmpdir()
    const wsPath = this.execDAO.findWorkspacePath(workspaceId)
    if (!wsPath) return os.tmpdir()
    return wsPath.replace(/^~/, os.homedir())
  }

  private calculateDelay(policy: AgentRetryPolicy, attempt: number): number {
    let delay: number
    if (policy.backoff_type === 'exponential') {
      delay = policy.base_delay_ms * Math.pow(2, attempt - 1)
    } else {
      delay = policy.base_delay_ms
    }
    delay = Math.min(delay, policy.max_delay_ms)
    if (policy.jitter) {
      delay = delay * (0.5 + Math.random() * 0.5)
    }
    return Math.round(delay)
  }
}

class AgentTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentTimeoutError'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
