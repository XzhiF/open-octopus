import type { SchedulerJob, SchedulerExecutionStatus } from '@octopus/shared'

export interface ExecutionResult {
  success: boolean
  exitCode: number
  errorMessage?: string
  durationMs: number
  status: SchedulerExecutionStatus
  // Agent-specific fields
  agentOutput?: string
  modelUsed?: string
  tokenUsage?: { input: number; output: number }
}

export interface Executor {
  execute(job: SchedulerJob, executionId: string): Promise<ExecutionResult>
  getType(): string
}
