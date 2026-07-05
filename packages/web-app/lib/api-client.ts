import type {
  ChatSession, LeaderboardResponse,
  Resource, ResourceListResponse, ResourceSearchResult,
  AuditListResponse, TrustListResponse,
  OutdatedEntry, DoctorResponse, SyncResponse, GcResponse,
} from "@/lib/types"
import { getServerUrl } from "@/lib/server-config"

async function handleResponse(res: Response) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error?.message ?? body.error ?? `HTTP ${res.status}`)
  }
  return res.json()
}

/** Fetch wrapper that includes credentials (cookies) for auth. */
function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, credentials: "include" })
}

// ============ Workspaces ============

export async function listWorkspaces(org?: string) {
  const url = org
    ? `${getServerUrl()}/api/workspaces?org=${encodeURIComponent(org)}`
    : `${getServerUrl()}/api/workspaces`
  const res = await apiFetch(url)
  return res.json()
}

export async function getWorkspace(id: string) {
  const res = await apiFetch(`${getServerUrl()}/api/workspaces/${id}`)
  if (!res.ok) return undefined
  return res.json()
}

export async function createWorkspace(data: { name: string; org: string; description?: string; path: string; repos?: string[]; branch?: string }) {
  const res = await apiFetch(`${getServerUrl()}/api/workspaces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  })
  return handleResponse(res)
}

export async function updateWorkspace(id: string, data: { name?: string; org?: string; description?: string }) {
  const res = await apiFetch(`${getServerUrl()}/api/workspaces/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  })
  return handleResponse(res)
}

export async function deleteWorkspace(id: string) {
  const res = await apiFetch(`${getServerUrl()}/api/workspaces/${id}`, { method: "DELETE" })
  return handleResponse(res)
}

export async function fetchImportableWorkspaces(org: string) {
  const res = await apiFetch(`${getServerUrl()}/api/workspaces/importable?org=${encodeURIComponent(org)}`)
  return handleResponse(res)
}

export async function importWorkspace(name: string, org: string) {
  const res = await apiFetch(`${getServerUrl()}/api/workspaces/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, org }),
  })
  return handleResponse(res)
}

export async function fetchManifestRepos(org: string) {
  const res = await apiFetch(`${getServerUrl()}/api/workspaces/repos?org=${org}`)
  return handleResponse(res)
}

// Legacy aliases
export const fetchWorkspaces = listWorkspaces
export const fetchWorkspace = getWorkspace

// ============ File Tree ============

interface FileTreeItem {
  name: string
  type: "file" | "directory"
  path: string
  extension?: string
  size?: number
}

export async function fetchFileTree(workspaceId: string, dirPath?: string): Promise<FileTreeItem[]> {
  const url = new URL(`${getServerUrl()}/api/workspaces/${workspaceId}/file-tree`)
  if (dirPath) url.searchParams.set("path", dirPath)
  const res = await apiFetch(url.toString())
  if (!res.ok) return []
  return res.json()
}

export async function fetchFileContent(workspaceId: string, filePath: string): Promise<string> {
  const url = new URL(`${getServerUrl()}/api/workspaces/${workspaceId}/files`)
  url.searchParams.set("path", filePath)
  const res = await apiFetch(url.toString())
  if (!res.ok) throw new Error("File not found")
  return res.json().then(d => d.content ?? "")
}

// ============ Files ============

export async function createFileEntry(workspaceId: string, data: { path: string; type: "file" | "directory"; content?: string }) {
  const res = await apiFetch(`${getServerUrl()}/api/workspaces/${workspaceId}/files`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  })
  return handleResponse(res)
}

export async function saveFileEntry(
  workspaceId: string,
  data: { path: string; content: string; originalContent?: string; force?: boolean }
): Promise<{ conflict?: boolean; path?: string; externalContent?: string }> {
  const res = await apiFetch(`${getServerUrl()}/api/workspaces/${workspaceId}/files`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  })
  if (res.status === 409) {
    return res.json()
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return res.json()
}

export async function deleteFileEntry(workspaceId: string, data: { path: string }) {
  const res = await apiFetch(`${getServerUrl()}/api/workspaces/${workspaceId}/files`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  })
  return handleResponse(res)
}

export async function refreshFileTree(workspaceId: string) {
  const res = await apiFetch(`${getServerUrl()}/api/workspaces/${workspaceId}/files/refresh`, {
    method: "POST",
  })
  return handleResponse(res)
}

export async function renameFileEntry(workspaceId: string, data: { path: string; newName: string }) {
  const res = await apiFetch(`${getServerUrl()}/api/workspaces/${workspaceId}/files`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  })
  return handleResponse(res)
}

export function sendDebugLog(workspaceId: string, msg: string) {
  fetch(`${getServerUrl()}/api/workspaces/${workspaceId}/files/debug-log?msg=${encodeURIComponent(msg)}`, {
    method: "POST",
  }).catch(() => {})
}

export async function listOrgs(): Promise<{ id: number; name: string; path: string }[]> {
  const res = await apiFetch(`${getServerUrl()}/api/orgs`)
  if (!res.ok) return []
  return res.json()
}

// ============ Workflows ============

export async function fetchWorkflows(workspaceId: string) {
  const res = await apiFetch(`${getServerUrl()}/api/workspaces/${workspaceId}/workflows`)
  return res.json()
}

// ============ Built-in Workflows ============

interface WorkflowListItem {
  ref: string
  name: string
  inputs?: Record<string, { description: string; required: boolean; default: string }>
}

export async function fetchBuiltInWorkflows(): Promise<WorkflowListItem[]> {
  const res = await apiFetch(`${getServerUrl()}/api/workflows/built-in`)
  if (!res.ok) return []
  return res.json()
}

// ============ Executions ============

export async function fetchExecutionTree(workspaceId: string) {
  const res = await apiFetch(`${getServerUrl()}/api/workspaces/${workspaceId}/executions/tree`)
  if (!res.ok) return { workspace_id: workspaceId, nodes: [] }
  return res.json()
}

export async function createExecution(workspaceId: string, data: {
  workflow_ref: string
  name?: string
  node_type?: string
  parent_id?: string | null
  child_index?: number
  input_values?: Record<string, string>
}) {
  const res = await apiFetch(`${getServerUrl()}/api/workspaces/${workspaceId}/executions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  })
  return handleResponse(res)
}

export async function startExecution(workspaceId: string, executionId: string, body?: { inputValues?: Record<string, string> }) {
  const res = await apiFetch(`${getServerUrl()}/api/workspaces/${workspaceId}/executions/${executionId}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  })
  return handleResponse(res)
}

export async function retryExecution(workspaceId: string, executionId: string, failedNodeId: string, body?: { inputValues?: Record<string, string>; intervention?: string }) {
  const res = await apiFetch(`${getServerUrl()}/api/workspaces/${workspaceId}/executions/${executionId}/retry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ failedNodeId, ...body }),
  })
  return handleResponse(res)
}

export async function cancelExecution(workspaceId: string, executionId: string) {
  const res = await apiFetch(`${getServerUrl()}/api/workspaces/${workspaceId}/executions/${executionId}/cancel`, {
    method: "POST",
  })
  return handleResponse(res)
}

export async function skipExecution(workspaceId: string, executionId: string) {
  const res = await apiFetch(`${getServerUrl()}/api/workspaces/${workspaceId}/executions/${executionId}/skip`, {
    method: "POST",
  })
  return handleResponse(res)
}

export async function deleteExecution(workspaceId: string, executionId: string) {
  const res = await apiFetch(`${getServerUrl()}/api/workspaces/${workspaceId}/executions/${executionId}`, {
    method: "DELETE",
  })
  return handleResponse(res)
}

export const listExecutions = fetchExecutionTree
export const fetchExecutions = fetchExecutionTree

// ============ Dashboard ============

export async function fetchDashboardStats() {
  const res = await apiFetch(`${getServerUrl()}/api/dashboard/stats`)
  return res.json()
}

export async function fetchRunningQueue() {
  const res = await apiFetch(`${getServerUrl()}/api/dashboard/queue`)
  return res.json()
}

export async function fetchLeaderboard(limit: number = 6): Promise<LeaderboardResponse> {
  const res = await apiFetch(
    `${getServerUrl()}/api/dashboard/leaderboard?limit=${limit}`,
  )
  return handleResponse(res)
}

export async function fetchRecentExecutions() {
  const res = await apiFetch(`${getServerUrl()}/api/dashboard/recent`)
  return res.json()
}

export async function fetchWorkflowHealth() {
  const res = await apiFetch(`${getServerUrl()}/api/dashboard/workflow-health`)
  return res.json()
}

// ============ Chat ============

export async function createChatSession(workspaceId: string) {
  const res = await apiFetch(`${getServerUrl()}/api/workspaces/${workspaceId}/chat/sessions`, {
    method: "POST",
  })
  return handleResponse(res)
}

export async function fetchChatSessions(workspaceId: string) {
  const res = await apiFetch(`${getServerUrl()}/api/workspaces/${workspaceId}/chat/sessions`)
  return res.json()
}

// sendMessage is now handled by useChatStream hook consuming streamSSE directly

export async function fetchSessionWithMessages(
  workspaceId: string,
  sessionId: string
): Promise<ChatSession | null> {
  const res = await apiFetch(`${getServerUrl()}/api/workspaces/${workspaceId}/chat/sessions/${sessionId}`)
  if (!res.ok) return null
  const data = await res.json()
  return {
    id: data.id,
    workspaceId: data.workspaceId,
    title: data.title ?? null,
    isActive: data.isActive ?? true,
    messages: data.messages ?? [],
    createdAt: data.createdAt ?? new Date().toISOString(),
    updatedAt: data.updatedAt ?? new Date().toISOString(),
  }
}

export async function generateSessionTitle(
  workspaceId: string,
  sessionId: string
): Promise<string | null> {
  const res = await apiFetch(`${getServerUrl()}/api/workspaces/${workspaceId}/chat/sessions/${sessionId}/generate-title`, {
    method: "POST",
  })
  if (!res.ok) return null
  const data = await res.json()
  return data.title ?? null
}

// ============ Swarm Stats ============

export async function fetchSwarmStats(workspaceId: string, params?: { from?: string; to?: string }) {
  const searchParams = new URLSearchParams()
  if (params?.from) searchParams.set("from", params.from)
  if (params?.to) searchParams.set("to", params.to)
  const qs = searchParams.toString()
  const url = `${getServerUrl()}/api/workspaces/${workspaceId}/analytics/swarm-stats${qs ? `?${qs}` : ""}`
  return handleResponse(await apiFetch(url))
}

// ============ Resource Management ============

export const resourceApi = {
  list: async (type?: string): Promise<ResourceListResponse> => {
    const url = new URL(`${getServerUrl()}/api/resources`)
    if (type && type !== "all") url.searchParams.set("type", type)
    return handleResponse(await apiFetch(url.toString()))
  },

  detail: async (type: string, name: string): Promise<Resource> => {
    return handleResponse(
      await apiFetch(`${getServerUrl()}/api/resources/${encodeURIComponent(type)}/${encodeURIComponent(name)}`)
    )
  },

  search: async (q: string): Promise<ResourceSearchResult> => {
    return handleResponse(
      await apiFetch(`${getServerUrl()}/api/resources/search?q=${encodeURIComponent(q)}`)
    )
  },

  install: async (names: string[], confirmed = false): Promise<{ installId: string }> => {
    return handleResponse(
      await apiFetch(`${getServerUrl()}/api/resources/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names, confirmed }),
      })
    )
  },

  uninstall: async (names: string[]): Promise<{ success: boolean; uninstalled: string[] }> => {
    return handleResponse(
      await apiFetch(`${getServerUrl()}/api/resources/uninstall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names }),
      })
    )
  },

  update: async (names?: string[]): Promise<{ success: boolean; updated: string[]; details: Array<{ name: string; from: string; to: string }> }> => {
    return handleResponse(
      await apiFetch(`${getServerUrl()}/api/resources/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names }),
      })
    )
  },

  outdated: async (): Promise<{ outdated: OutdatedEntry[]; total: number }> => {
    return handleResponse(
      await apiFetch(`${getServerUrl()}/api/resources/outdated`)
    )
  },

  audit: async (params?: { action?: string; resource?: string; last?: number }): Promise<AuditListResponse> => {
    const url = new URL(`${getServerUrl()}/api/resources/audit`)
    if (params?.action) url.searchParams.set("action", params.action)
    if (params?.resource) url.searchParams.set("resource", params.resource)
    if (params?.last) url.searchParams.set("last", String(params.last))
    return handleResponse(await apiFetch(url.toString()))
  },

  listTrust: async (): Promise<TrustListResponse> => {
    return handleResponse(
      await apiFetch(`${getServerUrl()}/api/resources/trust`)
    )
  },

  addTrust: async (protocol: string, pkg: string): Promise<{ success: boolean }> => {
    return handleResponse(
      await apiFetch(`${getServerUrl()}/api/resources/trust`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ protocol, package: pkg }),
      })
    )
  },

  removeTrust: async (protocol: string, pkg: string): Promise<{ success: boolean }> => {
    return handleResponse(
      await apiFetch(`${getServerUrl()}/api/resources/trust`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ protocol, package: pkg }),
      })
    )
  },

  addBlock: async (protocol: string, pkg: string, reason?: string): Promise<{ success: boolean }> => {
    return handleResponse(
      await apiFetch(`${getServerUrl()}/api/resources/trust/block`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ protocol, package: pkg, reason }),
      })
    )
  },

  removeBlock: async (protocol: string, pkg: string): Promise<{ success: boolean }> => {
    return handleResponse(
      await apiFetch(`${getServerUrl()}/api/resources/trust/block`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ protocol, package: pkg }),
      })
    )
  },

  sync: async (fix = false): Promise<SyncResponse> => {
    return handleResponse(
      await apiFetch(`${getServerUrl()}/api/resources/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fix }),
      })
    )
  },

  gc: async (dryRun = false): Promise<GcResponse> => {
    return handleResponse(
      await apiFetch(`${getServerUrl()}/api/resources/gc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun }),
      })
    )
  },

  doctor: async (): Promise<DoctorResponse> => {
    return handleResponse(
      await apiFetch(`${getServerUrl()}/api/resources/doctor`)
    )
  },

  getInstallSSEUrl: (installId: string): string => {
    return `${getServerUrl()}/api/resources/install/${encodeURIComponent(installId)}/stream`
  },
}