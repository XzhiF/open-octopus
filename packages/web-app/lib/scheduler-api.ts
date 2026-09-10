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
  CodeJobConfig,
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
  CodeJobConfig,
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

// ============ JobDetail ============
// GET /jobs/:id returns a plain SchedulerJob (ticket 10/13 used to hang a composite
// children[]/dag[] off it, read out of the per-task envelope rows; ADR-0021 票03
// deleted SchedulerService.findCompositeChildren/buildDagFromTaskSpec, and a task's
// runs now live on GET /api/tasks/:id instead. The alias stays because getJob/abortJob
// are typed with it and because the two composite view-models below are still the
// shapes components/tasks/composite-dag.tsx renders — it builds them client-side from
// task_spec.subunits.

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

/** One run row in the composite drill-down (a task execution badge projected onto
 *  the DAG's child axis). `run_id` was `schedule_id` while children were envelope
 *  rows; it is now the execution id, and 票05 put the subunit label ON the badge
 *  (`TaskExecutionBadge.name`, written at dispatch), so `subunit_name` reads that
 *  first — the workflow_ref→spec match is only the name-less fallback now. */
export interface JobDetailChild {
  run_id: string
  name: string
  status: string
  workflow_ref: string
  subunit_name: string
}

/** The built-in code-job rows (the `job`-type system duties, e.g. 系统 · 任务生命周期)
 *  carry a DETERMINISTIC id — `builtin-<handler>` — which is the server's seed key
 *  (packages/server/src/services/scheduler/builtin-jobs.ts, `builtinJobId`). The ops
 *  page uses this to render them as pausable-but-not-deletable: 删掉内置 job = 停掉
 *  全系统的任务启动，而 seed 不会复活软删的行（findByIdRaw 连 deleted 一起看）。
 *  User-created `job` rows are NOT builtin — they keep the normal delete affordance. */
export function isBuiltinJob(job: Pick<SchedulerJob, "id">): boolean {
  return job.id.startsWith("builtin-")
}

/** JobDetail = SchedulerJob. Kept as a name so the callers (getJob / abortJob) do
 *  not have to change with the payload. */
export type JobDetail = SchedulerJob

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

/** User-triggered abort (G4): guard status in (claimed,running) → schedules.status='aborted'
 *  + workspace cleanup + SSE schedule_status(aborted).
 *  (The draft→queued confirm gate `POST /jobs/:id/enqueue` was deleted by ADR-0021 票03
 *   together with enqueueJob + the 'draft' status: a job definition is registered, not
 *   parked. Task arming moved to POST /api/tasks/:id/trigger*.) */
export async function abortJob(id: string): Promise<JobDetail> {
  const res = await fetch(`${getServerUrl()}${BASE}/jobs/${id}/abort`, {
    method: "POST",
  })
  return handleResponse<JobDetail>(res)
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

