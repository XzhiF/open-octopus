import { Hono } from 'hono'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import { createAgentError, mapErrorToStatus } from './middleware'
import { WorkspaceDAO, SafetyDAO, ScheduleConfigDAO, ExecutionDAO } from '../../db/dao'
import { SchedulerService } from '../../services/scheduler/scheduler-service'
import { getWorkspaceLifecycleService } from '../../services/agent/workspace-lifecycle'
import { getClonesDir } from '../../services/agent/paths'

export interface TaskRouteDeps {
  workspaceDAO: WorkspaceDAO
  safetyDAO: SafetyDAO
  scheduleConfigDAO: ScheduleConfigDAO
  executionDAO: ExecutionDAO
  schedulerService: SchedulerService
}

export function createTaskRoutes(deps: TaskRouteDeps): Hono {
  const { workspaceDAO, safetyDAO, scheduleConfigDAO, executionDAO, schedulerService } = deps
  const app = new Hono()

  // Tasks — includes workflow executions + scheduler jobs
  app.get('/tasks', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)

      const result = schedulerService.listJobs({ org })

      // Also check schedules table for scheduled tasks (TC-041)
      let scheduled: Array<{ id: string; name: string; cron_expression: string; enabled: number }> = []
      try {
        scheduled = scheduleConfigDAO.listSchedulesByOrg(org)
      } catch { /* schedules table may not exist */ }

      // Query workflow executions for task status (TC-009, TC-014)
      let executions: Array<{
        id: string; workspace_id: string; workflow_name: string; status: string;
        started_at: string | null; completed_at: string | null; workspace_name?: string
      }> = []
      try {
        executions = executionDAO.findByOrgWithWorkspace(org, 50)
      } catch { /* executions table may not exist */ }

      // Merge executions into items as task entries
      const executionItems = executions.map((exec) => ({
        id: exec.id,
        name: exec.workflow_name,
        status: exec.status,
        workspace_id: exec.workspace_id,
        workspace_name: exec.workspace_name,
        started_at: exec.started_at,
        completed_at: exec.completed_at,
        type: 'execution' as const,
      }))

      const allItems = [...executionItems, ...result.items.map((item: Record<string, unknown>) => ({ ...item, type: 'scheduler' as const }))]

      return c.json({
        items: allItems,
        total: allItems.length,
        active: allItems.filter((j: { status: string }) => j.status === 'running' || j.status === 'active').length,
        scheduled,
      })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  app.post('/tasks/:id/cancel', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      const id = c.req.param('id')

      // Use toggleJob to disable — pauseJob was never a SchedulerService method
      const job = schedulerService.toggleJob(id)
      return c.json({ ok: true, job })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      // SchedulerJobNotFoundError has no .code property — map by name
      if (error.name === 'SchedulerJobNotFoundError') {
        return c.json(createAgentError('NOT_FOUND', error.message), 404)
      }
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })

  // TC-014: Delete workspace for a completed task (preserve main repo branch)
  app.delete('/tasks/:id/workspace', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      const id = c.req.param('id')

      // Find the execution and its workspace
      let execution: { id: string; workspace_id: string; status: string; workflow_name: string } | undefined
      try {
        execution = executionDAO.findByIdAndOrg(id, org) ?? undefined
      } catch { /* table may not exist */ }

      if (!execution) {
        return c.json(createAgentError('NOT_FOUND', `Task ${id} not found`), 404)
      }

      // Guard: only terminal-state executions can have their workspace deleted
      const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled']
      if (!TERMINAL_STATUSES.includes(execution.status)) {
        return c.json(
          createAgentError('INVALID_STATE', `Task ${id} is still ${execution.status}; cannot delete workspace`),
          409,
        )
      }

      // Get workspace details
      let workspace: { id: string; name: string; path: string; status: string } | undefined
      try {
        const wsRow = workspaceDAO.findById(execution.workspace_id)
        if (wsRow && wsRow.org === org) {
          workspace = { id: wsRow.id, name: wsRow.name, path: wsRow.path, status: wsRow.status }
        }
      } catch { /* table may not exist */ }

      if (!workspace) {
        return c.json(createAgentError('NOT_FOUND', `Workspace for task ${id} not found`), 404)
      }

      // Path boundary validation: workspace must be within org directory
      const allowedBase = path.resolve(path.join(os.homedir(), '.octopus', 'orgs', org))
      const resolvedWsPath = path.resolve(workspace.path)
      if (!resolvedWsPath.startsWith(allowedBase + path.sep) && resolvedWsPath !== allowedBase) {
        return c.json(createAgentError('INVALID_PARAM', 'Workspace path outside org boundary'), 400)
      }

      // Use WorkspaceLifecycleService to clean up
      const lifecycleService = getWorkspaceLifecycleService(org)
      const cleanupResult = lifecycleService.cleanupWorkspace(workspace.path)

      // Remove worktree if it exists (git worktree remove — using execFileSync to prevent injection)
      let worktreeRemoved = false
      if (cleanupResult.cleaned) {
        try {
          if (fs.existsSync(path.join(workspace.path, '.git'))) {
            const configPath = path.join(workspace.path, 'config.json')
            if (fs.existsSync(configPath)) {
              const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
              if (config.projects) {
                for (const project of Object.values(config.projects) as Array<{ main_path?: string; worktree_path?: string }>) {
                  if (project.main_path && project.worktree_path) {
                    // Validate paths within org boundary
                    const resolvedMain = path.resolve(project.main_path)
                    const resolvedWt = path.resolve(project.worktree_path)
                    if (!resolvedMain.startsWith(allowedBase + path.sep) || !resolvedWt.startsWith(allowedBase + path.sep)) {
                      continue // skip paths outside org boundary
                    }
                    try {
                      execFileSync('git', ['worktree', 'remove', project.worktree_path, '--force'], {
                        cwd: project.main_path,
                        stdio: 'pipe',
                        timeout: 10000,
                      })
                      worktreeRemoved = true
                    } catch { /* worktree may already be removed */ }
                  }
                }
              }
            }
            if (!worktreeRemoved) {
              try {
                execFileSync('git', ['worktree', 'prune'], { cwd: workspace.path, stdio: 'pipe', timeout: 10000 })
                worktreeRemoved = true
              } catch { /* non-fatal */ }
            }
          }
        } catch { /* execFileSync failure is non-fatal */ }
      }

      // Update workspace status + schedule_workspaces in a transaction
      let dbUpdateFailed = false
      try {
        const now = new Date().toISOString()
        workspaceDAO.transaction(() => {
          workspaceDAO.update(workspace!.id, { status: 'completed' })
          try {
            scheduleConfigDAO.updateScheduleWorkspacesCleaned(workspace!.id, now)
          } catch { /* schedule_workspaces table may not exist or row may not exist */ }
        })
      } catch {
        dbUpdateFailed = true
      }

      return c.json({
        ok: !dbUpdateFailed,
        task_id: id,
        workspace_id: workspace.id,
        workspace_name: workspace.name,
        worktree_removed: worktreeRemoved,
        branch_preserved: true,
        cleanup: cleanupResult,
      })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  app.get('/tasks/reports', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      // Query reports table if exists, fallback to file scan
      try {
        const rows = safetyDAO.listReportsByOrg(org)
        return c.json({ items: rows, total: rows.length })
      } catch {
        // Table may not exist — return empty
        return c.json({ items: [], total: 0 })
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  app.get('/tasks/reports/:id', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      const id = c.req.param('id')

      // Try to find report in DB
      try {
        const report = safetyDAO.findReportById(id)

        if (report && report.org === org) {
          // Check if file exists
          if (fs.existsSync(report.file_path)) {
            const content = fs.readFileSync(report.file_path, 'utf-8')
            return c.json({ id: report.id, task_name: report.task_name, date: report.date, content, rebuilt: false })
          }
          // File missing — rebuild from metadata (TC-046)
          const rebuiltContent = `# ${report.task_name} — ${report.date}\n\n⚠️ 原报告丢失\n\n执行状态: ${report.status}\n创建时间: ${report.date}`
          return c.json({
            id: report.id,
            task_name: report.task_name,
            date: report.date,
            content: rebuiltContent,
            rebuilt: true,
            warning: '原报告丢失',
          })
        }
      } catch {
        // Table may not exist
      }

      return c.json(createAgentError('NOT_FOUND', `Report ${id} not found`), 404)
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  // ── B2: Task progress polling (supplements SSE in chat) ────────────
  app.get('/tasks/progress', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)

      // Query active executions with their node progress
      let activeExecutions: Array<{
        id: string; workspace_id: string; workflow_name: string; status: string;
        started_at: string | null; current_node: string | null; progress: number | null;
        workspace_name?: string
      }> = []
      try {
        activeExecutions = executionDAO.findActiveExecutionsByOrg(org)
      } catch { /* executions table may not exist */ }

      // Also check active clone delegations
      const base = getClonesDir()
      const activeClones: Array<{ name: string; task: string; delegated_at: string }> = []
      if (fs.existsSync(base)) {
        const entries = fs.readdirSync(base, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const metaFile = path.join(base, entry.name, 'meta.json')
            if (fs.existsSync(metaFile)) {
              try {
                const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'))
                if (meta.status === 'running') {
                  activeClones.push({
                    name: meta.name,
                    task: meta.current_task ?? '',
                    delegated_at: meta.delegated_at ?? '',
                  })
                }
              } catch { /* skip */ }
            }
          }
        }
      }

      return c.json({
        executions: activeExecutions.map(e => ({
          id: e.id,
          workflow_name: e.workflow_name,
          status: e.status,
          started_at: e.started_at,
          current_node: e.current_node,
          progress: e.progress,
          workspace_name: e.workspace_name,
          elapsed_ms: e.started_at ? Date.now() - new Date(e.started_at).getTime() : null,
        })),
        clone_delegations: activeClones,
        total_active: activeExecutions.length + activeClones.length,
      })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  // ── E3: Scheduler execution history (click job → timeline) ──────────
  app.get('/tasks/history', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)

      const jobName = c.req.query('job_name')
      const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 200)

      // Query scheduled_job_executions table
      let executions: Array<{
        id: string; job_name: string; status: string; started_at: string;
        finished_at: string | null; duration_ms: number | null;
        report_path: string | null; report_summary: string | null;
        error_message: string | null; trigger_type: string; metadata: string | null
      }> = []

      try {
        const jobExecutions = safetyDAO.listJobExecutionsByOrg(org, { job_name: jobName, limit })
        executions = jobExecutions.map(je => ({
          id: je.id, job_name: je.job_name, status: je.status,
          started_at: je.started_at, finished_at: je.finished_at,
          duration_ms: je.duration_ms, report_path: je.report_path,
          report_summary: je.report_summary, error_message: je.error_message,
          trigger_type: je.trigger_type, metadata: je.metadata,
        })) as typeof executions
      } catch {
        // Table may not exist yet — fall back to reports table
        try {
          const reports = safetyDAO.listReportsByOrg(org, { task_name: jobName })
          executions = reports.map(r => ({
            id: r.id, task_name: r.task_name,
            status: r.status === 'ok' ? 'success' : r.status === 'missing' ? 'failure' : r.status,
            started_at: r.created_at, finished_at: null as string | null,
            duration_ms: null as number | null, report_path: r.file_path,
            report_summary: null as string | null, error_message: null as string | null,
            trigger_type: 'cron', metadata: null as string | null,
          })) as unknown as typeof executions
        } catch {
          // Reports table may not exist either
        }
      }

      // Compute summary stats
      const totalExecutions = executions.length
      const successCount = executions.filter(e => e.status === 'success').length
      const failureCount = executions.filter(e => e.status === 'failure' || e.status === 'timeout').length
      const avgDuration = executions
        .filter(e => e.duration_ms != null)
        .reduce((sum, e) => sum + (e.duration_ms ?? 0), 0) / Math.max(successCount, 1)

      return c.json({
        executions: executions.map(e => ({
          id: e.id,
          job_name: e.job_name,
          status: e.status,
          started_at: e.started_at,
          finished_at: e.finished_at,
          duration_ms: e.duration_ms,
          report_path: e.report_path,
          report_summary: e.report_summary,
          error_message: e.error_message,
          trigger_type: e.trigger_type,
          metadata: e.metadata ? JSON.parse(e.metadata) : null,
        })),
        summary: {
          total: totalExecutions,
          success: successCount,
          failure: failureCount,
          avg_duration_ms: Math.round(avgDuration),
          success_rate: totalExecutions > 0 ? Math.round((successCount / totalExecutions) * 100) : 0,
        },
      })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  return app
}
