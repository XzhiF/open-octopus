import Database from "better-sqlite3"
import { TokenUsageDAO } from "../db/dao"

// ============ 排行榜响应类型 ============

export interface ModelUsageGroup {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalTokens: number
  costUsd: number | null
  costComplete: boolean
}

export interface WorkspaceRanking {
  workspaceId: string
  workspaceName: string
  totalTokens: number
  totalCostUsd: number | null
  costComplete: boolean
  models: ModelUsageGroup[]
}

export interface ExecutionRanking {
  executionId: string
  workflowRef: string
  workflowName: string
  workspaceId: string
  workspaceName: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalCostUsd: number | null
  costComplete: boolean
  models: ModelUsageGroup[]
}

export interface WorkflowRanking {
  workflowRef: string
  workflowName: string
  workspaceId: string
  workspaceName: string
  totalTokens: number
  totalCostUsd: number | null
  costComplete: boolean
  models: ModelUsageGroup[]
}

export interface ModelRanking {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalTokens: number
  costUsd: number | null
  costComplete: boolean
}

export interface LeaderboardResponse {
  byWorkspace: WorkspaceRanking[]
  byWorkflow: ExecutionRanking[]
  byModel: ModelRanking[]
}

// ============ LeaderboardService ============

export class LeaderboardService {
  private cache: { data: LeaderboardResponse; expiresAt: number } | null = null
  private readonly CACHE_TTL_MS = 30_000
  private dao: TokenUsageDAO

  constructor(dao: TokenUsageDAO) {
    this.dao = dao
  }

  clearCache(): void {
    this.cache = null
  }

  getLeaderboard(limit: number = 6): LeaderboardResponse {
    const clampedLimit = Math.min(Math.max(Math.floor(limit), 1), 50)

    if (this.cache && Date.now() < this.cache.expiresAt) {
      return this.cache.data
    }

    const data: LeaderboardResponse = {
      byWorkspace: this.getByWorkspace(clampedLimit),
      byWorkflow: this.getByExecution(clampedLimit),
      byModel: this.getByModel(clampedLimit),
    }

    this.cache = { data, expiresAt: Date.now() + this.CACHE_TTL_MS }
    return data
  }

  private getByWorkspace(limit: number): WorkspaceRanking[] {
    const rows = this.dao.getWorkspaceRanking(limit)

    const workspaceMap = new Map<string, WorkspaceRanking>()
    for (const row of rows) {
      let entry = workspaceMap.get(row.workspace_id)
      if (!entry) {
        entry = {
          workspaceId: row.workspace_id,
          workspaceName: row.workspace_name,
          totalTokens: row.total_tokens,
          totalCostUsd: row.total_cost_usd,
          costComplete: row.cost_complete === 1,
          models: [],
        }
        workspaceMap.set(row.workspace_id, entry)
      }
      entry.models.push({
        model: row.model,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheCreationTokens: row.cache_creation_tokens,
        totalTokens: row.input_tokens + row.output_tokens + row.cache_read_tokens + row.cache_creation_tokens,
        costUsd: row.model_cost_usd,
        costComplete: row.cost_complete === 1,
      })
    }

    return Array.from(workspaceMap.values())
  }

  private getByExecution(limit: number): ExecutionRanking[] {
    const rows = this.dao.getExecutionRanking(limit)

    return rows.map(row => {
      const models = this.dao.getExecutionModelBreakdown(row.execution_id)

      return {
        executionId: row.execution_id,
        workflowRef: row.workflow_ref,
        workflowName: row.workflow_name ?? row.workflow_ref,
        workspaceId: row.workspace_id,
        workspaceName: row.workspace_name,
        totalTokens: row.total_tokens,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheCreationTokens: row.cache_creation_tokens,
        totalCostUsd: row.total_cost_usd,
        costComplete: row.cost_complete === 1,
        models: models.map(m => ({
          model: m.model,
          inputTokens: m.input_tokens,
          outputTokens: m.output_tokens,
          cacheReadTokens: m.cache_read_tokens,
          cacheCreationTokens: m.cache_creation_tokens,
          totalTokens: m.input_tokens + m.output_tokens + m.cache_read_tokens + m.cache_creation_tokens,
          costUsd: m.model_cost_usd,
          costComplete: m.cost_complete === 1,
        })),
      }
    })
  }

  private getByModel(limit: number): ModelRanking[] {
    const rows = this.dao.getModelRanking(limit)

    return rows.map(row => ({
      model: row.model,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheCreationTokens: row.cache_creation_tokens,
      totalTokens: row.total_tokens,
      costUsd: row.cost_usd,
      costComplete: row.cost_complete === 1,
    }))
  }
}
