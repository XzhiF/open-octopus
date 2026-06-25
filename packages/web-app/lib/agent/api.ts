import type { SkillSource } from './types'
import type {
  AgentSession, AgentMessage, PaginatedResponse,
  MemoryContent, MemorySearchResult, MemoryLayer,
  CloneInfo, CreateCloneRequest, Experience,
  SkillInfo, EvolutionLogEntry,
  TaskInfo, ScheduledJob, ReportInfo,
  AgentConfig, SafeModeStatus,
  SafetyEvent, DebugLogEntry,
} from './types'
import { getServerUrl } from '@/lib/server-config'

const BASE = () => `${getServerUrl()}/api/agent`
const AUTH_HEADER = 'Bearer agent'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE()}${url}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': AUTH_HEADER,
      ...init?.headers,
    },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { code: 'UNKNOWN', message: res.statusText } }))
    const err = new Error(body.error?.message ?? res.statusText) as Error & { code?: string; status?: number }
    err.code = body.error?.code
    err.status = res.status
    throw err
  }
  if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as T
  return res.json() as Promise<T>
}

// Sessions
export function createSession(opts?: { clone_name?: string }) {
  return request<AgentSession>('/sessions', { method: 'POST', body: JSON.stringify(opts ?? {}) })
}
export function listSessions(query?: { clone?: string; limit?: number; cursor?: string }) {
  const params = new URLSearchParams()
  if (query?.clone) params.set('clone', query.clone)
  if (query?.limit) params.set('limit', String(query.limit))
  if (query?.cursor) params.set('cursor', query.cursor)
  const qs = params.toString()
  return request<PaginatedResponse<AgentSession>>(`/sessions${qs ? `?${qs}` : ''}`)
}
export function getSession(id: string, query?: { limit?: number; cursor?: string }) {
  const params = new URLSearchParams()
  if (query?.limit) params.set('limit', String(query.limit))
  if (query?.cursor) params.set('cursor', query.cursor)
  const qs = params.toString()
  return request<{ session: AgentSession; messages: PaginatedResponse<AgentMessage> }>(`/sessions/${id}${qs ? `?${qs}` : ''}`)
}
export function updateSession(id: string, data: { title: string }) {
  return request<void>(`/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(data) })
}
export function deleteSession(id: string) {
  return request<void>(`/sessions/${id}`, { method: 'DELETE' })
}
export function stopChat(id: string) {
  return request<void>(`/sessions/${id}/stop`, { method: 'POST' })
}

// Chat SSE (POST + ReadableStream, compatible with contract POST method)
export interface AgentSSEConnection {
  reader: ReadableStreamDefaultReader<Uint8Array>
  abort: () => void
}

export function chatStream(id: string, message: string, opts?: { debug?: boolean }): AgentSSEConnection {
  const controller = new AbortController()
  const url = `${BASE()}/sessions/${id}/chat`
  const body = JSON.stringify({ message, debug: opts?.debug })

  const streamPromise = fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': AUTH_HEADER },
    body,
    signal: controller.signal,
  })

  // Create a readable stream that wraps the fetch response
  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const response = await streamPromise
        if (!response.ok || !response.body) {
          controller.error(new Error(`SSE connection failed: ${response.status}`))
          return
        }
        const reader = response.body.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          controller.enqueue(value)
        }
        controller.close()
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          controller.error(err)
        }
      }
    }
  })

  return {
    reader: readable.getReader(),
    abort: () => controller.abort(),
  }
}

// Memory
export function getMemory(layer: MemoryLayer, query?: { clone?: string; date?: string }) {
  const params = new URLSearchParams()
  if (query?.clone) params.set('clone', query.clone)
  if (query?.date) params.set('date', query.date)
  const qs = params.toString()
  return request<MemoryContent | MemoryContent[]>(`/memory/${layer}${qs ? `?${qs}` : ''}`)
}
export function addMemory(data: { layer: MemoryLayer; content: string; clone_name?: string; expected_last_modified?: string }) {
  return request<{ ok: boolean; token_count: number }>('/memory', { method: 'POST', body: JSON.stringify(data) })
}
export function searchMemory(q: string, limit?: number) {
  const params = new URLSearchParams({ q })
  if (limit) params.set('limit', String(limit))
  return request<{ results: MemorySearchResult[]; degraded: boolean }>(`/memory/search?${params}`)
}
export function rebuildFts() {
  return request<{ ok: boolean; indexed_count: number }>('/memory/rebuild-fts', { method: 'POST' })
}
export function triggerArchive(date?: string) {
  return request<{ ok: boolean; archived_date: string; essence_summary: string }>('/memory/archive', {
    method: 'POST', body: JSON.stringify({ date })
  })
}

// Clones
export function createClone(data: CreateCloneRequest) {
  return request<CloneInfo>('/clones', { method: 'POST', body: JSON.stringify(data) })
}
export function listClones() {
  return request<{ clones: CloneInfo[] }>('/clones')
}
export function deleteClone(name: string, keepWorkspace = true) {
  return request<{ ok: boolean; workspace_kept: boolean }>(`/clones/${name}?keep_workspace=${keepWorkspace}`, { method: 'DELETE' })
}
export function mergeClone(name: string) {
  return request<{ ok: boolean; archived_lessons: number; clone_removed: boolean }>(`/clones/${name}/merge`, { method: 'POST' })
}
export function delegateStream(name: string, prompt: string): AgentSSEConnection {
  const controller = new AbortController()
  const url = `${BASE()}/clones/${name}/delegate`
  const body = JSON.stringify({ prompt })

  const streamPromise = fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': AUTH_HEADER },
    body,
    signal: controller.signal,
  })

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const response = await streamPromise
        if (!response.ok || !response.body) {
          controller.error(new Error(`SSE connection failed: ${response.status}`))
          return
        }
        const reader = response.body.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          controller.enqueue(value)
        }
        controller.close()
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          controller.error(err)
        }
      }
    }
  })

  return {
    reader: readable.getReader(),
    abort: () => controller.abort(),
  }
}
export function cancelDelegate(name: string) {
  return request<{ ok: boolean }>(`/clones/${name}/delegate/cancel`, { method: 'POST' })
}
export function getCloneExperiences(name: string, q?: string) {
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  const qs = params.toString()
  return request<{ experiences: Experience[] }>(`/clones/${name}/experiences${qs ? `?${qs}` : ''}`)
}

// Skills
export function listSkills() {
  return request<{ skills?: SkillInfo[]; items?: SkillInfo[] }>('/skills')
}
export function getSkill(name: string) {
  return request<{ name: string; source: SkillSource; content: string; token_count: number; last_modified: string | null }>(`/skills/${name}`)
}
export function getSkillDiff(name: string) {
  return request<{ has_diff: boolean; diff: string | null; local_version: string | null; builtin_version: string | null }>(`/skills/${name}/diff-builtin`)
}
export function revertToBuiltin(name: string) {
  return request<{ ok: boolean; reverted_to: string; backup_created: string }>(`/skills/${name}/local`, { method: 'DELETE' })
}

// Evolution
export function getChangelog(query?: { skill?: string; limit?: number; cursor?: string }) {
  const params = new URLSearchParams()
  if (query?.skill) params.set('skill', query.skill)
  if (query?.limit) params.set('limit', String(query.limit))
  if (query?.cursor) params.set('cursor', query.cursor)
  const qs = params.toString()
  return request<PaginatedResponse<EvolutionLogEntry>>(`/evolution/changelog${qs ? `?${qs}` : ''}`)
}
export function getExperiences(query?: { skill?: string; q?: string }) {
  const params = new URLSearchParams()
  if (query?.skill) params.set('skill', query.skill)
  if (query?.q) params.set('q', query.q)
  const qs = params.toString()
  return request<{ experiences?: Experience[]; items?: Experience[] }>(`/evolution/experiences${qs ? `?${qs}` : ''}`)
}
export function rollbackEvolution(id: number) {
  return request<{ ok: boolean; rolled_back_skill: string; new_changelog_id: number }>(`/evolution/rollback/${id}`, { method: 'POST' })
}

// Tasks
export function getTasks(history = false) {
  return request<{ active: TaskInfo[]; scheduled: ScheduledJob[] }>(`/tasks${history ? '?history=true' : ''}`)
}
export function cancelTask(id: string) {
  return request<{ ok: boolean }>(`/tasks/${id}/cancel`, { method: 'POST' })
}
export function getTaskProgress() {
  return request<{
    executions: Array<{ id: string; workflow_name: string; status: string; started_at: string | null; current_node: string | null; progress: number | null; workspace_name?: string; elapsed_ms: number | null }>
    clone_delegations: Array<{ name: string; task: string; delegated_at: string }>
    total_active: number
  }>('/tasks/progress')
}
export function getTaskHistory(query?: { job_name?: string; limit?: number }) {
  const params = new URLSearchParams()
  if (query?.job_name) params.set('job_name', query.job_name)
  if (query?.limit) params.set('limit', String(query.limit))
  const qs = params.toString()
  return request<{
    executions: Array<{
      id: string; job_name: string; status: string; started_at: string;
      finished_at: string | null; duration_ms: number | null;
      report_path: string | null; report_summary: string | null;
      error_message: string | null; trigger_type: string; metadata: unknown
    }>
    summary: { total: number; success: number; failure: number; avg_duration_ms: number; success_rate: number }
  }>(`/tasks/history${qs ? `?${qs}` : ''}`)
}
export function getReports(query?: { task?: string; date?: string; q?: string; limit?: number; cursor?: string }) {
  const params = new URLSearchParams()
  if (query?.task) params.set('task', query.task)
  if (query?.date) params.set('date', query.date)
  if (query?.q) params.set('q', query.q)
  if (query?.limit) params.set('limit', String(query.limit))
  if (query?.cursor) params.set('cursor', query.cursor)
  const qs = params.toString()
  return request<PaginatedResponse<ReportInfo>>(`/tasks/reports${qs ? `?${qs}` : ''}`)
}
export function getReport(id: string) {
  return request<{ report: ReportInfo; content: string | null; rebuilt: boolean }>(`/tasks/reports/${id}`)
}

// Config
export function getConfig() {
  return request<AgentConfig & { config_degraded: boolean }>('/config')
}
export function updateConfig(data: Partial<AgentConfig>) {
  return request<{ ok: boolean; config_degraded: boolean }>('/config', { method: 'PUT', body: JSON.stringify(data) })
}
export function getPersona() {
  return request<{ content: string; token_count: number }>('/config/persona')
}
export function updatePersona(content: string) {
  return request<{ ok: boolean; token_count: number }>('/config/persona', { method: 'PUT', body: JSON.stringify({ content }) })
}

// Safety
export function confirmSafety(eventId: string, decision: 'accept' | 'reject') {
  return request<{ ok: boolean; decision_applied: string }>('/safety/confirm', {
    method: 'POST', body: JSON.stringify({ event_id: eventId, decision })
  })
}
export function getSafetyEvents(query?: { type?: string; actor?: string; limit?: number; cursor?: string }) {
  const params = new URLSearchParams()
  if (query?.type) params.set('type', query.type)
  if (query?.actor) params.set('actor', query.actor)
  if (query?.limit) params.set('limit', String(query.limit))
  if (query?.cursor) params.set('cursor', query.cursor)
  const qs = params.toString()
  return request<PaginatedResponse<SafetyEvent>>(`/safety/events${qs ? `?${qs}` : ''}`)
}

// Safe Mode
export function getSafeMode() { return request<SafeModeStatus>('/safe-mode') }
export function enableSafeMode() {
  return request<{ ok: boolean; safe_mode: SafeModeStatus }>('/safe-mode/enable', { method: 'POST' })
}
export function disableSafeMode() {
  return request<{ ok: boolean; safe_mode: SafeModeStatus }>('/safe-mode/disable', { method: 'POST' })
}

// Debug
export function getDebugLog(query?: { session_id?: string; limit?: number; cursor?: string }) {
  const params = new URLSearchParams()
  if (query?.session_id) params.set('session_id', query.session_id)
  if (query?.limit) params.set('limit', String(query.limit))
  if (query?.cursor) params.set('cursor', query.cursor)
  const qs = params.toString()
  return request<PaginatedResponse<DebugLogEntry>>(`/debug/log${qs ? `?${qs}` : ''}`)
}
export function getAssembleDetail(chatId: string) {
  return request<DebugLogEntry>(`/debug/assemble/${chatId}`)
}

// Observability (tracer + metrics + events)
export function getObservability(view?: string, opts?: Record<string, string>) {
  const params = new URLSearchParams()
  if (view) params.set('view', view)
  if (opts) Object.entries(opts).forEach(([k, v]) => params.set(k, v))
  const qs = params.toString()
  return request<unknown>(`/observability${qs ? `?${qs}` : ''}`)
}
