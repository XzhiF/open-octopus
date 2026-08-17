import { getServerUrl } from "@/lib/server-config"
import type {
  JobType,
  ParallelPolicy,
  SchedulerExecutionStatus,
  TrendDirection,
  AuditAction,
  JobConfig,
  WorkflowConfig,
  AgentConfig,
  AgentRetryPolicy,
  SchedulerJob,
  SchedulerExecution,
  SchedulerAuditLog,
  SchedulerExecutionSummary,
  PaginatedResponse,
  DashboardSummary,
  CronParseResult,
  NaturalCronResult,
  ExecutionLogResponse,
  CreateJobInput,
  UpdateJobInput,
  ListJobsParams,
  ListExecutionsParams,
  ListAuditLogsParams,
} from "@octopus/shared"

// Re-export shared types so existing imports from "@/lib/scheduler-api" keep working
export type {
  JobType,
  ParallelPolicy,
  SchedulerExecutionStatus,
  TrendDirection,
  AuditAction,
  JobConfig,
  WorkflowConfig,
  AgentConfig,
  AgentRetryPolicy,
  SchedulerJob,
  SchedulerExecution,
  SchedulerAuditLog,
  SchedulerExecutionSummary,
  PaginatedResponse,
  DashboardSummary,
  CronParseResult,
  NaturalCronResult,
  ExecutionLogResponse,
  CreateJobInput,
  UpdateJobInput,
  ListJobsParams,
  ListExecutionsParams,
  ListAuditLogsParams,
}

// ============ JobDetail (composite view, ticket 10/13) ============
// GET /jobs/:id returns a JobDetail for composite tasks: children[] (actual
// dispatched child schedules) + dag (composition structure from task_spec).
// The canonical definitions live in @octopus/server (scheduler-service.ts), but
// web-app cannot import from the server package — these mirror that shape so the
// client is type-safe without a cross-package dependency.

export interface JobDetailDagNode {
  id: string
  type: "subunit" | "integration"
  label: string
  workflow_ref?: string
}

export interface JobDetailDagEdge {
  from: string
  to: string
}

export interface JobDetailDag {
  nodes: JobDetailDagNode[]
  edges: JobDetailDagEdge[]
}

export interface JobDetailChild {
  schedule_id: string
  name: string
  status: string
  workflow_ref: string
  subunit_name: string
}

/** JobDetail = SchedulerJob + optional composite fields. Simple tasks return a
 *  plain SchedulerJob (children/dag undefined) — backward compatible. */
export type JobDetail = SchedulerJob & {
  children?: JobDetailChild[]
  dag?: JobDetailDag
}

// ============ Helpers ============

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return res.json()
}

const BASE = "/api/scheduler"

function buildUrl(path: string, params?: object): string {
  const url = new URL(`${getServerUrl()}${BASE}${path}`)
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value))
      }
    }
  }
  return url.toString()
}

// ============ Jobs CRUD ============

export async function listJobs(
  params?: ListJobsParams,
  signal?: AbortSignal
): Promise<PaginatedResponse<SchedulerJob>> {
  const res = await fetch(buildUrl("/jobs", params), { signal })
  return handleResponse<PaginatedResponse<SchedulerJob>>(res)
}

export async function createJob(input: CreateJobInput): Promise<SchedulerJob> {
  const res = await fetch(`${getServerUrl()}${BASE}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  return handleResponse<SchedulerJob>(res)
}

export async function getJob(id: string, signal?: AbortSignal): Promise<JobDetail> {
  const res = await fetch(`${getServerUrl()}${BASE}/jobs/${id}`, { signal })
  return handleResponse<JobDetail>(res)
}

export async function updateJob(
  id: string,
  input: Record<string, unknown>,
  version: number
): Promise<SchedulerJob> {
  const res = await fetch(`${getServerUrl()}${BASE}/jobs/${id}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "If-Match": String(version),
    },
    body: JSON.stringify(input),
  })
  return handleResponse<SchedulerJob>(res)
}

export async function deleteJob(id: string): Promise<{ success: boolean }> {
  const res = await fetch(`${getServerUrl()}${BASE}/jobs/${id}`, {
    method: "DELETE",
  })
  return handleResponse<{ success: boolean }>(res)
}

export async function toggleJob(id: string): Promise<SchedulerJob> {
  const res = await fetch(`${getServerUrl()}${BASE}/jobs/${id}/toggle`, {
    method: "POST",
  })
  return handleResponse<SchedulerJob>(res)
}

export async function triggerJob(
  id: string
): Promise<{
  execution_id: string
  schedule_id: string
  status: string
  trigger_type: string
  triggered_at: string
}> {
  const res = await fetch(`${getServerUrl()}${BASE}/jobs/${id}/trigger`, {
    method: "POST",
  })
  return handleResponse(res)
}

/** Confirm gate (D13/G7): move a draft schedule draft→queued. Server runs enqueueJob →
 *  schedules.status='queued' + SSE schedule_status(queued). */
export async function enqueueJob(id: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${getServerUrl()}${BASE}/jobs/${id}/enqueue`, {
    method: "POST",
  })
  return handleResponse<{ ok: boolean }>(res)
}

/** User-triggered abort (G4): guard status in (claimed,running) → schedules.status='aborted'
 *  + workspace cleanup + SSE schedule_status(aborted). */
export async function abortJob(id: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${getServerUrl()}${BASE}/jobs/${id}/abort`, {
    method: "POST",
  })
  return handleResponse<{ ok: boolean }>(res)
}

// ============ Executions ============

export async function listExecutions(
  jobId: string,
  params?: ListExecutionsParams,
  signal?: AbortSignal
): Promise<PaginatedResponse<SchedulerExecution>> {
  const res = await fetch(
    buildUrl(`/jobs/${jobId}/executions`, params as Record<string, unknown>),
    { signal }
  )
  return handleResponse<PaginatedResponse<SchedulerExecution>>(res)
}

export async function getExecution(
  jobId: string,
  executionId: string
): Promise<SchedulerExecution> {
  const res = await fetch(
    `${getServerUrl()}${BASE}/jobs/${jobId}/executions/${executionId}`
  )
  return handleResponse<SchedulerExecution>(res)
}

export async function getExecutionLog(
  jobId: string,
  executionId: string,
  offset?: number,
  limit?: number
): Promise<ExecutionLogResponse> {
  const params: Record<string, unknown> = {}
  if (offset !== undefined) params.offset = offset
  if (limit !== undefined) params.limit = limit
  const res = await fetch(
    buildUrl(`/jobs/${jobId}/executions/${executionId}/log`, params)
  )
  return handleResponse<ExecutionLogResponse>(res)
}

// ============ Audit Logs ============

export async function listAuditLogs(
  jobId: string,
  params?: ListAuditLogsParams
): Promise<PaginatedResponse<SchedulerAuditLog>> {
  const res = await fetch(
    buildUrl(`/jobs/${jobId}/audit-logs`, params as Record<string, unknown>)
  )
  return handleResponse<PaginatedResponse<SchedulerAuditLog>>(res)
}

// ============ Dashboard ============

export interface DashboardParams {
  range?: string
  from?: string
  to?: string
}

export async function getDashboard(params?: DashboardParams): Promise<DashboardSummary> {
  const res = await fetch(buildUrl("/dashboard", params))
  return handleResponse<DashboardSummary>(res)
}

export interface ExportDashboardParams {
  format: "csv" | "pdf"
  range?: string
  from?: string
  to?: string
  scope?: "all" | "failed"
}

export async function exportDashboard(params: ExportDashboardParams): Promise<Blob> {
  const url = buildUrl("/dashboard/export", params)
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return res.blob()
}

// ============ Cron Tools ============

export async function parseCron(
  expression: string,
  timezone: string
): Promise<CronParseResult> {
  const res = await fetch(`${getServerUrl()}${BASE}/cron/parse`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expression, timezone }),
  })
  return handleResponse<CronParseResult>(res)
}

export async function naturalToCron(
  text: string,
  timezone: string
): Promise<NaturalCronResult> {
  const res = await fetch(`${getServerUrl()}${BASE}/cron/natural`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, timezone }),
  })
  return handleResponse<NaturalCronResult>(res)
}

// ============ Schedule Workspaces ============

export interface ScheduleWorkspace {
  id: string
  schedule_id: string
  workspace_id: string
  execution_id: string | null
  status: 'running' | 'completed' | 'failed'
  branch_suffix: string
  started_at: string
  completed_at: string | null
  error: string | null
  workspace_name?: string
  workspace_status?: string
}

export async function listScheduleWorkspaces(
  jobId: string,
  params: { page?: number; limit?: number; status?: string } = {}
): Promise<PaginatedResponse<ScheduleWorkspace>> {
  const searchParams = new URLSearchParams()
  if (params.page) searchParams.set('page', String(params.page))
  if (params.limit) searchParams.set('limit', String(params.limit))
  if (params.status) searchParams.set('status', params.status)

  const res = await fetch(
    `${getServerUrl()}${BASE}/jobs/${jobId}/workspaces?${searchParams}`
  )
  return handleResponse<PaginatedResponse<ScheduleWorkspace>>(res)
}

export async function getScheduleWorkspace(
  jobId: string,
  wsId: string
): Promise<ScheduleWorkspace> {
  const res = await fetch(
    `${getServerUrl()}${BASE}/jobs/${jobId}/workspaces/${wsId}`
  )
  return handleResponse<ScheduleWorkspace>(res)
}

