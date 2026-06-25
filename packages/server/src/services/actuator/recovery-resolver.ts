import type { ExecutionDAO } from '../../db/dao/execution-dao'

export interface RecoveryResponse {
  stale_executions: {
    count: number
    items: {
      id: string
      workflow_name: string
      started_at: string
      last_updated_at: string
      stale_duration_hours: number
    }[]
  }
  pending_resume: { count: number; items: unknown[] }
  pending_hooks: { count: number; items: unknown[] }
  orphaned_nodes: {
    last_fixed_count: number
    last_fixed_at: string | null
  }
  agent_recovery: {
    last_recovery_at: string | null
    last_result: {
      sessions_restored: number
      clones_recovered: number
      provider_sessions_recreated: number
      interrupted_workflows: number
      errors: string[]
    } | null
  }
}

const STALE_THRESHOLD_MS = 30 * 60 * 1000 // 30 minutes

export class RecoveryResolver {
  constructor(
    private executionDAO: ExecutionDAO,
    private getRecoveryService: (org: string) => { needsRecovery(): boolean; getStatus(): any },
  ) {}

  getRecovery(org?: string): RecoveryResponse {
    return {
      stale_executions: this.findStaleExecutions(),
      pending_resume: { count: 0, items: [] },
      pending_hooks: this.findPendingHooks(),
      orphaned_nodes: { last_fixed_count: 0, last_fixed_at: null },
      agent_recovery: this.getAgentRecovery(org ?? 'default'),
    }
  }

  private findStaleExecutions(): RecoveryResponse['stale_executions'] {
    try {
      const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString()
      const rows = this.executionDAO.findAllActiveExecutions()
        .filter(r => r.status === 'running' && r.updated_at && r.updated_at < cutoff)

      const items = rows.map(r => ({
        id: r.id,
        workflow_name: r.workflow_name,
        started_at: r.started_at ?? '',
        last_updated_at: r.updated_at ?? '',
        stale_duration_hours: Math.round((Date.now() - new Date(r.updated_at ?? '').getTime()) / 3600000 * 10) / 10,
      }))

      return { count: items.length, items }
    } catch {
      return { count: 0, items: [] }
    }
  }

  private findPendingHooks(): RecoveryResponse['pending_hooks'] {
    try {
      const rows = this.executionDAO.findAllActiveExecutions()
        .filter(r => r.status === 'pending_hooks' || r.status === 'pending')
      return { count: rows.length, items: rows.map(r => ({ id: r.id, workflow_name: r.workflow_name })) }
    } catch {
      return { count: 0, items: [] }
    }
  }

  private getAgentRecovery(org: string): RecoveryResponse['agent_recovery'] {
    try {
      const service = this.getRecoveryService(org)
      const status = service.getStatus()
      if (!status) return { last_recovery_at: null, last_result: null }
      return {
        last_recovery_at: status.last_recovery ?? null,
        last_result: status.last_result ?? null,
      }
    } catch {
      return { last_recovery_at: null, last_result: null }
    }
  }
}
