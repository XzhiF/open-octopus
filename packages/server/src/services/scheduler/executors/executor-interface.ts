import type { SchedulerJob, SchedulerExecutionStatus, TokenUsage } from '@octopus/shared'

export interface ExecutionResult {
  success: boolean
  exitCode: number
  errorMessage?: string
  durationMs: number
  status: SchedulerExecutionStatus
  // Agent-specific fields
  agentOutput?: string
  modelUsed?: string
  tokenUsage?: TokenUsage
}

export interface Executor {
  execute(job: SchedulerJob, executionId: string): Promise<ExecutionResult>
  getType(): string
}
