import { Hono } from "hono"
import { WorkspaceService } from "../services/workspace"
import { WorkflowService } from "../services/workflow"
import { LeaderboardService } from "../services/leaderboard"
import { ExecutionDAO, TokenUsageDAO } from "../db/dao"
import type { ArchiveDAO } from "../db/dao/archive-dao"

const workflowService = new WorkflowService()

export function createDashboardRoutes(
  workspaceService: WorkspaceService,
  leaderboardService: LeaderboardService,
  execDAO: ExecutionDAO,
  tokenUsageDAO: TokenUsageDAO,
  archiveDAO?: ArchiveDAO,
): Hono {
  const dashboardRoutes = new Hono()

  dashboardRoutes.get("/stats", (c) => {
    const workspaces = workspaceService.list()
    const totalWorkflows = workspaces.reduce(
      (sum, ws) => sum + workflowService.list(ws.path).length,
      0,
    )

    const execRow = execDAO.getDashboardStats()
    const totalCost = tokenUsageDAO.totalCost()

    // Get archived workspace stats
    let archivedWorkspaces = 0
    let archivedExecutions = 0
    let archivedCost = 0
    if (archiveDAO) {
      try {
        const archived = archiveDAO.getArchivedWorkspaces()
        archivedWorkspaces = archived.length
        archivedExecutions = archived.reduce((sum, ws) => sum + ws.execution_count, 0)
        archivedCost = archived.reduce((sum, ws) => sum + ws.total_cost, 0)
      } catch (err) {
        console.warn("Failed to get archived workspace stats:", err)
      }
    }

    const stats = {
      total_workspaces: workspaces.length,
      total_workflows: totalWorkflows,
      total_executions: execRow.total_executions,
      completed_executions: execRow.completed_executions,
      failed_executions: execRow.failed_executions,
      running_executions: execRow.running_executions,
      pending_executions: execRow.pending_executions,
      avg_duration_ms: execRow.avg_duration_ms,
      total_cost: totalCost,
      // Archive V2 stats
      archived_workspaces: archivedWorkspaces,
      archived_executions: archivedExecutions,
      archived_cost: archivedCost,
    }
    return c.json(stats)
  })

  dashboardRoutes.get("/queue", (c) => {
    const active = execDAO.getQueueItems()

    const mapped = active.map(row => ({
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      workspaceName: row.workspace_name as string,
      workflowName: row.workflow_name as string,
      workflowId: row.workflow_ref as string,
      status: row.status as string,
      progress: row.progress as number,
      currentStep: row.current_step as string,
      startedAt: row.started_at as string,
      completedAt: row.completed_at as string,
      duration: row.duration as number,
      triggeredBy: row.triggered_by as string,
    }))

    return c.json(mapped)
  })

  dashboardRoutes.get("/recent", (c) => {
    const recent = execDAO.getRecentCompleted(10)

    const mapped = recent.map(row => ({
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      workspaceName: row.workspace_name as string,
      workflowName: row.workflow_name as string,
      workflowId: row.workflow_ref as string,
      status: row.status as string,
      progress: row.progress as number,
      currentStep: row.current_step as string,
      startedAt: row.started_at as string,
      completedAt: row.completed_at as string,
      duration: row.duration as number,
      triggeredBy: row.triggered_by as string,
    }))

    return c.json(mapped)
  })

  dashboardRoutes.get("/workflow-health", (c) => {
    const workflows = execDAO.getWorkflowHealth(10)
    return c.json(workflows)
  })

  dashboardRoutes.get("/leaderboard", (c) => {
    const limitParam = c.req.query("limit")
    const parsed = limitParam ? parseInt(limitParam, 10) : 6
    const limit = Number.isNaN(parsed) ? 6 : parsed

    const result = leaderboardService.getLeaderboard(limit)
    return c.json(result)
  })

  return dashboardRoutes
}

export default createDashboardRoutes
