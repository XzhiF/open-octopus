import { ExecutionDAO } from '../../db/dao/execution-dao'

// ── Types ──────────────────────────────────────────────────────────

export interface WorkflowUsageStats {
  workflow_ref: string
  total_runs: number
  success_runs: number
  failure_runs: number
  avg_duration_ms: number | null
  usage_rate: number
  failure_rate: number
}

// ── UsageTrackerService ────────────────────────────────────────────

export class UsageTrackerService {
  private executionDAO: ExecutionDAO

  constructor(executionDAO: ExecutionDAO) {
    this.executionDAO = executionDAO
  }

  /** Stats for a single workflow over the given time window. */
  getUsageStats(workflowRef: string, days = 30): WorkflowUsageStats | null {
    const raw = this.executionDAO.getUsageStatsByWorkflow(workflowRef, days)
    if (!raw) return null
    return {
      workflow_ref: workflowRef,
      total_runs: raw.total_runs,
      success_runs: raw.success_runs,
      failure_runs: raw.failure_runs,
      avg_duration_ms: raw.avg_duration_ms,
      usage_rate: raw.total_runs / Math.max(1, days),
      failure_rate: raw.failure_rate,
    }
  }

  /** Workflows whose usage rate is below threshold. */
  getLowUsageWorkflows(threshold = 0.05, days = 90): WorkflowUsageStats[] {
    const all = this.executionDAO.getAllWorkflowUsageStats(days)
    return all
      .filter(r => r.usage_rate < threshold)
      .sort((a, b) => a.usage_rate - b.usage_rate)
  }

  /** Workflows whose failure rate exceeds threshold. */
  getHighFailureWorkflows(threshold = 0.5, days = 90): WorkflowUsageStats[] {
    const all = this.executionDAO.getAllWorkflowUsageStats(days)
    return all
      .filter(r => r.failure_rate > threshold)
      .sort((a, b) => b.failure_rate - a.failure_rate)
  }

  /** All workflows sorted by usage (descending). */
  listAllWorkflowStats(days = 30): WorkflowUsageStats[] {
    const all = this.executionDAO.getAllWorkflowUsageStats(days)
    return all.sort((a, b) => b.usage_rate - a.usage_rate)
  }
}
