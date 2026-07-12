import { getServerUrl } from "@/lib/server-config"
import { apiFetch, handleResponse } from "@/lib/api-client"
import type {
  ResourceEntry,
  ResourceListResponse,
  ResourceAuditRecord,
  InstallResponse,
  UninstallResponse,
  VerifyResult,
  ListQuery,
} from "./types"

function base() {
  return `${getServerUrl()}/api/resources`
}

function joinQs(...parts: string[]): string {
  return parts.filter(Boolean).join("&")
}

// ============ Resources ============

export async function listResources(opts?: ListQuery): Promise<ResourceListResponse> {
  const params: string[] = []
  if (opts?.type) params.push(`type=${opts.type}`)
  if (opts?.query) params.push(`query=${encodeURIComponent(opts.query)}`)
  if (opts?.installed !== undefined) params.push(`installed=${opts.installed}`)
  const qs = params.join("&")
  const url = qs ? `${base()}?${qs}` : base()
  const res = await apiFetch(url)
  return handleResponse<ResourceListResponse>(res)
}

export async function getResourceStats(): Promise<{
  total: number; installed: number; unverified: number;
  byType: Record<string, number>; bySource: Record<string, number>
}> {
  const res = await apiFetch(`${base()}/stats`)
  return handleResponse(res)
}

export async function getResource(type: string, name: string): Promise<ResourceEntry> {
  const res = await apiFetch(`${base()}/${encodeURIComponent(type)}/${encodeURIComponent(name)}`)
  return handleResponse<ResourceEntry>(res)
}

export async function getResourceVerify(type: string, name: string): Promise<{
  name: string; type: string; verify: VerifyResult
}> {
  const res = await apiFetch(`${base()}/${encodeURIComponent(type)}/${encodeURIComponent(name)}/verify`)
  return handleResponse(res)
}

export async function getResourceFiles(type: string, name: string, filePath?: string): Promise<{
  name: string; type: string; files: Array<{ path: string; size: number }>
} | { path: string; content: string; size: number }> {
  const qs = filePath ? `path=${encodeURIComponent(filePath)}` : ""
  const url = qs ? `${base()}/${encodeURIComponent(type)}/${encodeURIComponent(name)}/files?${qs}` : `${base()}/${encodeURIComponent(type)}/${encodeURIComponent(name)}/files`
  const res = await apiFetch(url)
  return handleResponse(res)
}

export async function installResource(ref: string): Promise<InstallResponse> {
  const res = await apiFetch(`${base()}/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref, scope: "org", caller: "ui" }),
  })
  return handleResponse<InstallResponse>(res)
}

export async function uninstallResource(name: string, type: string): Promise<UninstallResponse> {
  const res = await apiFetch(`${base()}/uninstall`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, type, caller: "ui" }),
  })
  return handleResponse<UninstallResponse>(res)
}

// ============ Builtin ============

export async function listBuiltin(): Promise<{
  resources: Array<{ name: string; type: string; description: string; installed: boolean }>;
  total: number
}> {
  const res = await apiFetch(`${base()}/builtin`)
  return handleResponse(res)
}

// ============ Audit ============

export async function getAuditLog(opts?: { last?: number; action?: string }): Promise<{
  records: ResourceAuditRecord[]; total: number
}> {
  const params: string[] = []
  if (opts?.last) params.push(`last=${opts.last}`)
  if (opts?.action) params.push(`action=${opts.action}`)
  const qs = params.join("&")
  const url = qs ? `${base()}/audit?${qs}` : `${base()}/audit`
  const res = await apiFetch(url)
  return handleResponse(res)
}

// ============ Sources ============

export async function listSources(): Promise<{
  sources: Array<{
    name: string; url: string; branch: string
    resourceCount: { skills: number; agents: number; workflows: number }
    addedAt: string; lastUpdated: string; cachePath: string; trusted: boolean
  }>; total: number
}> {
  const res = await apiFetch(`${base()}/source/list`)
  return handleResponse(res)
}

export async function getSource(name: string): Promise<{
  name: string; url: string; branch: string
  resourceCount: { skills: number; agents: number; workflows: number }
  addedAt: string; lastUpdated: string; cachePath: string; trusted: boolean
}> {
  const res = await apiFetch(`${base()}/source/${encodeURIComponent(name)}`)
  return handleResponse(res)
}

export async function addSource(url: string, name?: string, branch?: string): Promise<{
  name: string; url: string; branch: string
  resourceCount: { skills: number; agents: number; workflows: number }
  addedAt: string; trusted: boolean
}> {
  const res = await apiFetch(`${base()}/source/add`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, name, branch: branch ?? "main", caller: "ui" }),
  })
  return handleResponse(res)
}

export async function updateSource(name: string): Promise<{
  name: string; url: string; branch: string
  resourceCount: { skills: number; agents: number; workflows: number }
  addedAt: string; trusted: boolean
}> {
  const res = await apiFetch(`${base()}/source/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, caller: "ui" }),
  })
  return handleResponse(res)
}

export async function removeSource(name: string): Promise<{ name: string; status: string }> {
  const res = await apiFetch(`${base()}/source/${encodeURIComponent(name)}`, {
    method: "DELETE",
  })
  return handleResponse(res)
}

export async function analyzeSource(url: string): Promise<{
  resources: Array<{ name: string; type: string; path: string }>
}> {
  const res = await apiFetch(`${base()}/source/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  })
  return handleResponse(res)
}

export async function installFromSource(req: {
  sourceName: string; group?: string; all?: boolean
  resources?: Array<{ type: string; name: string; path: string }>
}): Promise<{ installed: number; skipped: number }> {
  const res = await apiFetch(`${base()}/source/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...req, caller: "ui" }),
  })
  return handleResponse(res)
}

export async function syncSource(sourceName: string): Promise<{
  sourceName: string; updated: number; added: number; removed: number; unchanged: number
}> {
  const res = await apiFetch(`${base()}/source/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceName, caller: "ui" }),
  })
  return handleResponse(res)
}
