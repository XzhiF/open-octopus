// packages/server/src/services/observe-service.ts
// ObserveService — Phase 6 of Execution Memory: OODA Observe loop.
// Analyzes execution archives to identify patterns and generate suggestions.

import type { ArchiveDAO } from "../db/dao/archive-dao"
import type { ExperienceDAO } from "../db/dao/experience-dao"

export interface ObserveResult {
  patterns: Array<{
    type: "repeated_failure" | "cost_spike" | "success_streak"
    workflow_name: string
    description: string
    data_points: number
    suggestion: string
  }>
  generated_at: string
}

export class ObserveService {
  constructor(
    private archiveDAO: ArchiveDAO,
    private experienceDAO: ExperienceDAO,
  ) {}

  /** Analyze recent executions and return patterns + suggestions. */
  analyze(days: number = 7): ObserveResult {
    const patterns: ObserveResult["patterns"] = []

    try {
      // Analyze repeated failures (same workflow fails 3+ times in period)
      const workflowStats = this.archiveDAO.getWorkflowStats()
      for (const ws of workflowStats) {
        if (ws.runs >= 3 && ws.success_rate < 0.5) {
          patterns.push({
            type: "repeated_failure",
            workflow_name: ws.workflow_name,
            description: `${ws.workflow_name} 成功率 ${(ws.success_rate * 100).toFixed(0)}% (${ws.runs} 次执行)`,
            data_points: ws.runs,
            suggestion: `建议检查 ${ws.workflow_name} 工作流配置或增加重试策略`,
          })
        }
      }
    } catch (err) {
      console.warn("[ObserveService] analyze error:", err)
    }

    return {
      patterns,
      generated_at: new Date().toISOString(),
    }
  }
}
