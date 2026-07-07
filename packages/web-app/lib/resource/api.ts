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

function orgParam(org: string): string {
  return `org=${encodeURIComponent(org)}`
}

function joinQs(...parts: string[]): string {
  return parts.filter(Boolean).join("&")
}

// ============ Resources ============

export async function listResources(org: string, opts?: ListQuery): Promise<ResourceListResponse> {
  const params: string[] = [orgParam(org)]
  if (opts?.type) params.push(`type=${opts.type}`)
  if (opts?.query) params.push(`query=${encodeURIComponent(opts.query)}`)
  if (opts?.installed !== undefined) params.push(`installed=${opts.installed}`)
  const qs = params.join("&")
  const res = await apiFetch(`${base()}?${qs}`)
  return handleResponse<ResourceListResponse>(res)
}

export async function getResourceStats(org: string): Promise<{
  total: number; installed: number; unverified: number;
  byType: Record<string, number>; bySource: Record<string, number>
}> {
  const res = await apiFetch(`${base()}/stats?${orgParam(org)}`)
  return handleResponse(res)
}

export async function getResource(org: string, type: string, name: string): Promise<ResourceEntry> {
  const res = await apiFetch(`${base()}/${encodeURIComponent(type)}/${encodeURIComponent(name)}?${orgParam(org)}`)
  return handleResponse<ResourceEntry>(res)
}

export async function getResourceVerify(org: string, type: string, name: string): Promise<{
  name: string; type: string; verify: VerifyResult
}> {
  const res = await apiFetch(`${base()}/${encodeURIComponent(type)}/${encodeURIComponent(name)}/verify?${orgParam(org)}`)
  return handleResponse(res)
}

export async function getResourceFiles(org: string, type: string, name: string, filePath?: string): Promise<{
  name: string; type: string; files: Array<{ path: string; size: number }>
} | { path: string; content: string; size: number }> {
  const qs = joinQs(orgParam(org), filePath ? `path=${encodeURIComponent(filePath)}` : "")
  const res = await apiFetch(`${base()}/${encodeURIComponent(type)}/${encodeURIComponent(name)}/files?${qs}`)
  return handleResponse(res)
}

export async function installResource(org: string, ref: string): Promise<InstallResponse> {
  const res = await apiFetch(`${base()}/install?${orgParam(org)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref, scope: "org", caller: "ui" }),
  })
  return handleResponse<InstallResponse>(res)
}

export async function uninstallResource(org: string, name: string, type: string): Promise<UninstallResponse> {
  const res = await apiFetch(`${base()}/uninstall?${orgParam(org)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, type, caller: "ui" }),
  })
  return handleResponse<UninstallResponse>(res)
}

// ============ Builtin ============

export async function listBuiltin(org: string): Promise<{
  resources: Array<{ name: string; type: string; description: string; installed: boolean }>;
  total: number
}> {
  const res = await apiFetch(`${base()}/builtin?${orgParam(org)}`)
  return handleResponse(res)
}

// ============ Audit ============

export async function getAuditLog(org: string, opts?: { last?: number; action?: string }): Promise<{
  records: ResourceAuditRecord[]; total: number
}> {
  const params: string[] = [orgParam(org)]
  if (opts?.last) params.push(`last=${opts.last}`)
  if (opts?.action) params.push(`action=${opts.action}`)
  const qs = params.join("&")
  const res = await apiFetch(`${base()}/audit?${qs}`)
  return handleResponse(res)
}

// ============ Sources ============

export async function listSources(org: string): Promise<{
  sources: Array<{
    name: string; url: string; branch: string
    resourceCount: { skills: number; agents: number; workflows: number }
    addedAt: string; lastUpdated: string; cachePath: string; trusted: boolean
  }>; total: number
}> {
  const res = await apiFetch(`${base()}/source/list?${orgParam(org)}`)
  return handleResponse(res)
}

export async function getSource(org: string, name: string): Promise<{
  name: string; url: string; branch: string
  resourceCount: { skills: number; agents: number; workflows: number }
  addedAt: string; lastUpdated: string; cachePath: string; trusted: boolean
}> {
  const res = await apiFetch(`${base()}/source/${encodeURIComponent(name)}?${orgParam(org)}`)
  return handleResponse(res)
}

export async function addSource(org: string, url: string, name?: string, branch?: string): Promise<{
  name: string; url: string; branch: string
  resourceCount: { skills: number; agents: number; workflows: number }
  addedAt: string; trusted: boolean
}> {
  const res = await apiFetch(`${base()}/source/add?${orgParam(org)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, name, branch: branch ?? "main", caller: "ui" }),
  })
  return handleResponse(res)
}

export async function updateSource(org: string, name: string): Promise<{
  name: string; url: string; branch: string
  resourceCount: { skills: number; agents: number; workflows: number }
  addedAt: string; trusted: boolean
}> {
  const res = await apiFetch(`${base()}/source/update?${orgParam(org)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, caller: "ui" }),
  })
  return handleResponse(res)
}

export async function removeSource(org: string, name: string): Promise<{ name: string; status: string }> {
  const res = await apiFetch(`${base()}/source/${encodeURIComponent(name)}?${orgParam(org)}`, {
    method: "DELETE",
  })
  return handleResponse(res)
}

export async function analyzeSource(org: string, url: string): Promise<{
  resources: Array<{ name: string; type: string; path: string }>
}> {
  const res = await apiFetch(`${base()}/source/analyze?${orgParam(org)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  })
  return handleResponse(res)
}
