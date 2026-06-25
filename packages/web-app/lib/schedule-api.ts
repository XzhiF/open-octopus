import { getServerUrl } from "./server-config"
import type {
  Schedule,
  ScheduleExecution,
  ScheduleAuditLog,
  SchedulePermissions,
  CreateScheduleInput,
  UpdateScheduleInput,
  CronParseResult,
  NaturalLanguageCronResult,
  PaginatedResponse,
} from "@/lib/types"

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return res.json()
}

// ============ Schedules CRUD ============

export async function listSchedules(
  wsId: string,
  query?: { search?: string; status?: string }
): Promise<Schedule[]> {
  const params = new URLSearchParams()
  if (query?.search) params.set("search", query.search)
  if (query?.status) params.set("status", query.status)
  const qs = params.toString() ? `?${params}` : ""
  const res = await fetch(`${getServerUrl()}/api/workspaces/${wsId}/schedules${qs}`)
  return handleResponse<Schedule[]>(res)
}

export async function getSchedule(wsId: string, scheduleId: string): Promise<Schedule> {
  const res = await fetch(`${getServerUrl()}/api/workspaces/${wsId}/schedules/${scheduleId}`)
  return handleResponse<Schedule>(res)
}

export async function createSchedule(wsId: string, data: CreateScheduleInput): Promise<Schedule> {
  const res = await fetch(`${getServerUrl()}/api/workspaces/${wsId}/schedules`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  })
  return handleResponse<Schedule>(res)
}

export async function updateSchedule(
  wsId: string,
  scheduleId: string,
  data: UpdateScheduleInput
): Promise<Schedule> {
  const res = await fetch(`${getServerUrl()}/api/workspaces/${wsId}/schedules/${scheduleId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  })
  return handleResponse<Schedule>(res)
}

export async function deleteSchedule(wsId: string, scheduleId: string): Promise<void> {
  const res = await fetch(`${getServerUrl()}/api/workspaces/${wsId}/schedules/${scheduleId}`, {
    method: "DELETE",
  })
  return handleResponse<void>(res)
}

// ============ Schedule Actions ============

export async function enableSchedule(wsId: string, scheduleId: string): Promise<Schedule> {
  const res = await fetch(
    `${getServerUrl()}/api/workspaces/${wsId}/schedules/${scheduleId}/enable`,
    { method: "POST" }
  )
  return handleResponse<Schedule>(res)
}

export async function disableSchedule(wsId: string, scheduleId: string): Promise<Schedule> {
  const res = await fetch(
    `${getServerUrl()}/api/workspaces/${wsId}/schedules/${scheduleId}/disable`,
    { method: "POST" }
  )
  return handleResponse<Schedule>(res)
}

export async function triggerSchedule(wsId: string, scheduleId: string): Promise<ScheduleExecution> {
  const res = await fetch(
    `${getServerUrl()}/api/workspaces/${wsId}/schedules/${scheduleId}/trigger`,
    { method: "POST" }
  )
  return handleResponse<ScheduleExecution>(res)
}

export async function dismissScheduleAlert(
  wsId: string,
  scheduleId: string
): Promise<Schedule> {
  const res = await fetch(
    `${getServerUrl()}/api/workspaces/${wsId}/schedules/${scheduleId}/dismiss-alert`,
    { method: "POST" }
  )
  return handleResponse<Schedule>(res)
}

// ============ Executions ============

export async function listScheduleExecutions(
  wsId: string,
  scheduleId: string,
  query?: { page?: number; pageSize?: number }
): Promise<PaginatedResponse<ScheduleExecution>> {
  const params = new URLSearchParams()
  if (query?.page) params.set("page", String(query.page))
  if (query?.pageSize) params.set("pageSize", String(query.pageSize))
  const qs = params.toString() ? `?${params}` : ""
  const res = await fetch(
    `${getServerUrl()}/api/workspaces/${wsId}/schedules/${scheduleId}/executions${qs}`
  )
  return handleResponse<PaginatedResponse<ScheduleExecution>>(res)
}

export async function retryScheduleExecution(
  wsId: string,
  scheduleId: string,
  executionId: string
): Promise<ScheduleExecution> {
  const res = await fetch(
    `${getServerUrl()}/api/workspaces/${wsId}/schedules/${scheduleId}/executions/${executionId}/retry`,
    { method: "POST" }
  )
  return handleResponse<ScheduleExecution>(res)
}

// ============ Emergency & Audit ============

export async function emergencyStopSchedules(wsId: string): Promise<{ stopped: number }> {
  const res = await fetch(`${getServerUrl()}/api/workspaces/${wsId}/schedules/emergency-stop`, {
    method: "POST",
  })
  return handleResponse<{ stopped: number }>(res)
}

export async function listScheduleAuditLogs(
  wsId: string,
  query?: { page?: number; pageSize?: number }
): Promise<PaginatedResponse<ScheduleAuditLog>> {
  const params = new URLSearchParams()
  if (query?.page) params.set("page", String(query.page))
  if (query?.pageSize) params.set("pageSize", String(query.pageSize))
  const qs = params.toString() ? `?${params}` : ""
  const res = await fetch(`${getServerUrl()}/api/workspaces/${wsId}/schedules/audit-logs${qs}`)
  return handleResponse<PaginatedResponse<ScheduleAuditLog>>(res)
}

export async function getSchedulePermissions(
  wsId: string
): Promise<SchedulePermissions> {
  const res = await fetch(`${getServerUrl()}/api/workspaces/${wsId}/schedules/permissions`)
  return handleResponse<SchedulePermissions>(res)
}

// ============ Cron Helpers ============

export async function parseCron(
  expression: string,
  timezone?: string
): Promise<CronParseResult> {
  const res = await fetch(`${getServerUrl()}/api/schedules/cron/parse`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expression, timezone }),
  })
  return handleResponse<CronParseResult>(res)
}

export async function naturalLanguageToCron(
  input: string
): Promise<NaturalLanguageCronResult> {
  const res = await fetch(`${getServerUrl()}/api/schedules/cron/natural-language`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input }),
  })
  return handleResponse<NaturalLanguageCronResult>(res)
}
