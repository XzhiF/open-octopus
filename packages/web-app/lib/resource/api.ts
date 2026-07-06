import { getServerUrl } from "@/lib/server-config"

// ── Types (matching API contract) ──

export type ResourceType = "skill" | "agent" | "workflow"

export interface SourceRef {
  type: "builtin" | "local"
  name?: string
  subpath?: string
  path?: string
}

export interface RegistryEntry {
  name: string
  type: ResourceType
  version: string
  source: SourceRef
  installed: boolean
  installPath?: string
  contentHash?: string
  dependencies: string[]
  createdAt: string
  updatedAt: string
  description?: string
  tags?: string[]
}

export interface AuditEntry {
  timestamp: string
  action: "install" | "uninstall" | "register" | "gc" | "sync" | "doctor"
  resource: string
  type: ResourceType
  status: "success" | "failed"
  caller?: string
  detail?: string
  prevHash?: string
}

export interface DriftItem {
  resource: string
  type: ResourceType
  issue: "MISSING" | "MODIFIED" | "EXTRA"
  expected?: string
  actual?: string
  fixed: boolean
}

export interface DoctorCheck {
  name: string
  healthy: boolean
  detail?: string
  fixApplied?: boolean
}

export interface DepNode {
  name: string
  type: ResourceType
  version: string
  depth?: number
}

export interface ResourceError {
  code: string
  message: string
  hint?: string
}

// ── Error class ──

export class ResourceApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
    public hint?: string,
  ) {
    super(message)
    this.name = "ResourceApiError"
  }
}

// ── Fetch helpers ──

function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, credentials: "include" })
}

async function handleResponse<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = body.error as ResourceError | undefined
    throw new ResourceApiError(
      err?.message ?? `HTTP ${res.status}`,
      err?.code ?? "UNKNOWN",
      res.status,
      err?.hint,
    )
  }
  return body as T
}

// ── API functions ──

export interface ListResourcesParams {
  type?: ResourceType
  query?: string
  installed?: boolean
  tag?: string
}

export async function listResources(params?: ListResourcesParams) {
  const sp = new URLSearchParams()
  if (params?.type) sp.set("type", params.type)
  if (params?.query) sp.set("query", params.query)
  if (params?.installed !== undefined) sp.set("installed", String(params.installed))
  if (params?.tag) sp.set("tag", params.tag)
  const qs = sp.toString()
  const res = await apiFetch(`${getServerUrl()}/api/resources${qs ? `?${qs}` : ""}`)
  return handleResponse<{ data: RegistryEntry[]; meta: { total: number; returned: number } }>(res)
}

export async function getResource(type: ResourceType, name: string) {
  const res = await apiFetch(`${getServerUrl()}/api/resources/${type}/${encodeURIComponent(name)}`)
  return handleResponse<{ data: RegistryEntry }>(res)
}

export async function getResourceDeps(type: ResourceType, name: string) {
  const res = await apiFetch(`${getServerUrl()}/api/resources/${type}/${encodeURIComponent(name)}/deps`)
  return handleResponse<{ data: { forward: DepNode[]; reverse: DepNode[] } }>(res)
}

export async function installResource(ref: string) {
  const res = await apiFetch(`${getServerUrl()}/api/resources/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref }),
  })
  return handleResponse<{ data: { name: string; type: ResourceType; version: string; installPath: string } }>(res)
}

export async function uninstallResource(name: string, type: ResourceType) {
  const res = await apiFetch(`${getServerUrl()}/api/resources/uninstall`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, type }),
  })
  return handleResponse<{ data: { name: string; uninstalled: boolean } }>(res)
}

export async function gcResources(dryRun = false) {
  const res = await apiFetch(`${getServerUrl()}/api/resources/gc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dryRun }),
  })
  return handleResponse<{ data: { removed: string[]; freedBytes: number; freedHuman: string } }>(res)
}

export async function syncResources(fix = false, targets?: string[]) {
  const res = await apiFetch(`${getServerUrl()}/api/resources/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fix, targets }),
  })
  return handleResponse<{ data: { drifts: DriftItem[]; totalDrifts: number } }>(res)
}

export interface ListAuditParams {
  last?: number
  action?: string
  resource?: string
}

export async function listAudit(params?: ListAuditParams) {
  const sp = new URLSearchParams()
  if (params?.last) sp.set("last", String(params.last))
  if (params?.action) sp.set("action", params.action)
  if (params?.resource) sp.set("resource", params.resource)
  const qs = sp.toString()
  const res = await apiFetch(`${getServerUrl()}/api/resources/audit${qs ? `?${qs}` : ""}`)
  return handleResponse<{ data: AuditEntry[]; meta: { total: number; returned: number } }>(res)
}

export function getAuditExportUrl(since?: string): string {
  const sp = new URLSearchParams()
  if (since) sp.set("since", since)
  const qs = sp.toString()
  return `${getServerUrl()}/api/resources/audit/export${qs ? `?${qs}` : ""}`
}

export async function runDoctor() {
  const res = await apiFetch(`${getServerUrl()}/api/resources/doctor`)
  return handleResponse<{ data: { checks: DoctorCheck[]; healthy: boolean } }>(res)
}
