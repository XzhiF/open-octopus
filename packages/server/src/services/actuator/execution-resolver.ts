import type { ExecutionDAO } from '../../db/dao/execution-dao'
import type { WorkspaceDAO } from '../../db/dao/workspace-dao'
import type { TokenUsageDAO } from '../../db/dao/token-usage-dao'
import type { ErrorTracker } from '../error-tracker'
import type { NodeExecutionRow } from '../../db/types'

// ── Types ──────────────────────────────────────────────────────────

export interface ExecutionProgressResponse {
  id: string
  workflow_name: string
  status: string
  started_at: string
  duration_ms: number
  progress: number
  triggered_by: string
  waiting_for: string | null
  nodes: {
    id: string
    type: string
    status: string
    started_at?: string
    completed_at?: string
    duration_ms: number | null
    error: string | null
    retry_count: number
    exit_code?: number
    session_id?: string
  }[]
  tokens: {
    input: number
    output: number
    cache_read: number
    estimated_cost_usd: number
  } | null
  recent_errors: {
    node_id: string
    error: string
    timestamp: string
    recovered: boolean
  }[]
}

export interface ActiveExecutionsResponse {
  count: number
  executions: ActiveExecution[]
}

interface ActiveExecution {
  id: string
  workspace_id: string
  workspace_name: string
  workflow_name: string
  workflow_ref: string
  status: string
  started_at: string
  duration_ms: number
  progress: number
  triggered_by: string
  pending_approval: boolean
  current_node: {
    id: string
    type: string
    status: string
    started_at: string
    duration_ms: number
    retry_count: number
  } | null
  node_summary: {
    total: number
    completed: number
    running: number
    pending: number
  }
}

// ── Resolver ───────────────────────────────────────────────────────

export class ExecutionResolver {
  constructor(
    private executionDAO: ExecutionDAO,
    private workspaceDAO: WorkspaceDAO,
    private tokenUsageDAO?: TokenUsageDAO,
    private errorTracker?: ErrorTracker,
  ) {}

  getActiveExecutions(): ActiveExecutionsResponse {
    const rows = this.executionDAO.findAllActiveExecutions()

    const executions: ActiveExecution[] = rows.map(row => {
      const ws = this.workspaceDAO.findById(row.workspace_id)
      const currentNode = this.resolveCurrentNode(row.id)
      const nodeSummary = this.resolveNodeSummary(row.id)

      return {
        id: row.id,
        workspace_id: row.workspace_id,
        workspace_name: ws?.name ?? row.workspace_name ?? 'unknown',
        workflow_name: row.workflow_name,
        workflow_ref: row.workflow_ref ?? row.workflow_name,
        status: row.status,
        started_at: row.started_at ?? new Date().toISOString(),
        duration_ms: row.started_at ? Date.now() - new Date(row.started_at).getTime() : 0,
        progress: row.progress ?? 0,
        triggered_by: row.triggered_by ?? 'unknown',
        pending_approval: row.status === 'pending_approval' || row.status === 'pending',
        current_node: currentNode,
        node_summary: nodeSummary,
      }
    })

    return { count: executions.length, executions }
  }

  private resolveCurrentNode(executionId: string): ActiveExecution['current_node'] {
    const node = this.executionDAO.findFirstRunningNode(executionId)
    if (!node) return null
    return {
      id: node.node_id,
      type: node.node_type,
      status: node.status,
      started_at: node.started_at ?? new Date().toISOString(),
      duration_ms: node.started_at ? Date.now() - new Date(node.started_at).getTime() : 0,
      retry_count: 0, // ponytail: retry_count not on NodeExecutionRow, default 0
    }
  }

  private resolveNodeSummary(executionId: string): ActiveExecution['node_summary'] {
    try {
      const stats = this.executionDAO.findNodeStatsForExecutionSplit(executionId)
      return stats
    } catch {
      return { total: 0, completed: 0, running: 0, pending: 0 }
    }
  }

  getExecutionProgress(id: string): ExecutionProgressResponse | null {
    const exec = this.executionDAO.findById(id)
    if (!exec) return null

    const nodeRows = this.executionDAO.findNodeExecutions(id)
    const now = Date.now()

    const nodes = nodeRows.map(n => ({
      id: n.node_id,
      type: n.node_type,
      status: n.status,
      started_at: n.started_at ?? undefined,
      completed_at: n.completed_at ?? undefined,
      duration_ms: n.status === 'running' && n.started_at
        ? now - new Date(n.started_at).getTime()
        : n.duration ?? null,
      error: n.error ?? null,
      retry_count: 0,
      ...(n.node_type === 'bash' ? { exit_code: n.exit_code ?? undefined } : {}),
      ...(n.node_type === 'agent' ? { session_id: n.session_id ?? undefined } : {}),
    }))

    const tokens = this.aggregateTokens(id)
    const recentErrors = this.getRecentErrors(id)

    // waiting_for: check if any node is pending_approval
    const waitingNode = nodeRows.find(n => n.status === 'pending' && n.node_type === 'approval')
    const waiting_for = waitingNode ? 'approval' : null

    return {
      id: exec.id,
      workflow_name: exec.workflow_name,
      status: exec.status,
      started_at: exec.started_at ?? new Date().toISOString(),
      duration_ms: exec.started_at ? now - new Date(exec.started_at).getTime() : 0,
      progress: exec.progress ?? 0,
      triggered_by: exec.triggered_by ?? 'unknown',
      waiting_for,
      nodes,
      tokens,
      recent_errors: recentErrors,
    }
  }

  private aggregateTokens(executionId: string): ExecutionProgressResponse['tokens'] {
    if (!this.tokenUsageDAO) return null
    try {
      const rows = this.tokenUsageDAO.findByExecution(executionId)
      if (rows.length === 0) return null
      const agg = rows.reduce((acc, r) => ({
        input: acc.input + (r.input_tokens ?? 0),
        output: acc.output + (r.output_tokens ?? 0),
        cache_read: acc.cache_read + (r.cache_read_tokens ?? 0),
        estimated_cost_usd: acc.estimated_cost_usd + (r.cost_usd ?? 0),
      }), { input: 0, output: 0, cache_read: 0, estimated_cost_usd: 0 })
      return agg
    } catch {
      return null
    }
  }

  private getRecentErrors(executionId: string): ExecutionProgressResponse['recent_errors'] {
    if (!this.errorTracker) return []
    try {
      return this.errorTracker.getErrors()
        .filter(e => e.context.execution_id === executionId)
        .slice(-10)
        .map(e => ({
          node_id: (e.context.node_id as string) ?? 'unknown',
          error: e.message,
          timestamp: new Date(e.timestamp).toISOString(),
          recovered: false,
        }))
    } catch {
      return []
    }
  }
}
