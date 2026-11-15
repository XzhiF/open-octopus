// packages/web-app/lib/cabin-api.ts
//
// Thin client for the `/api/cabins` domain (Cabin P1). Mirrors the tasks-api
// pattern: pure fetch wrapper, types from @octopus/shared, server is the single
// source of truth for response shapes. Derived fields (attention/health/
// job status) arrive pre-computed in CabinView — the client never re-derives
// them (K3).

import { getServerUrl } from "@/lib/server-config"
import type {
  CabinDTO,
  CabinView,
  CabinStatus,
  CabinInitState,
  CabinJob,
  CabinJobEvent,
  CabinJobKind,
  CabinMandate,
  CabinAttentionItem,
  CabinHealth,
} from "@octopus/shared"

/** Wire DTO = shared CabinDTO + the UI-prefs JSON the route parses out. */
export type CabinDetail = CabinDTO & {
  cockpit_prefs?: Record<string, unknown> | null
}

/** 并行 worktree 实例（同一项目多条分支并行）。 */
export interface CabinRepoWorktree {
  path: string
  branch: string
  instance: string
  created_at?: string
}

/** 舱籍项目视图（2026-11-15 契约）：ORG / 本地 / 外部同表不同源。
 *  `git` 由 route 富化，目标 = worktree_path ?? main_path（没有工作树也有分支）。 */
export interface CabinRepoEntry {
  key: string
  name: string
  source: 'org' | 'local'
  org: string | null
  group: string | null
  repoName: string | null
  main_path: string | null
  local_path: string | null
  external: boolean
  mainline_branch: string | null
  worktree_path: string | null
  branch: string | null
  worktrees: CabinRepoWorktree[]
  git?: {
    branch: string; detached: boolean; commit: string
    msg?: string; at?: string; remote?: string | null
  } | null
}

/** 建舱/扫描候选（相对扫描根）。 */
export interface LocalProjectCandidate {
  name: string
  local_path: string
  branch: string | null
  dirty: boolean
  remote: string | null
}

export interface CabinWorktreeGroup {
  repo: string
  worktrees: Array<{ path: string; head: string; branch: string | null }>
}

export class CabinApiError extends Error {
  public status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = "CabinApiError"
    this.status = status
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new CabinApiError(body.error ?? `HTTP ${res.status}`, res.status)
  }
  return res.json()
}

const BASE = "/api/cabins"

function url(path: string): string {
  return `${getServerUrl()}${BASE}${path}`
}

const JSON_HEADERS = { "Content-Type": "application/json" }

// ============ CRUD ============

export async function listCabins(status?: CabinStatus, signal?: AbortSignal): Promise<CabinDetail[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : ""
  const res = await fetch(url(qs), { signal })
  const body = await handleResponse<{ cabins: CabinDetail[] }>(res)
  return body.cabins
}

export interface CreateCabinInput {
  /** v5：可选。不填 → 服务端先落「未命名舱」，init 开头按需求取名。 */
  name?: string
  /** 省略 = 新建工作空间（服务端生成 ~/.octopus/workspaces/cabin-…）。 */
  path?: string
  requirements?: string
  org?: string | null
  /** 老调用方：单 org + 仓库名列表。 */
  repos?: string[]
  /** 项目关联（优先于 org+repos）：ORG / 舱内本地 / 舱外显式登记。 */
  projects?: Array<{
    source?: 'org' | 'local'
    org?: string
    repo: string
    localPath?: string
    absolutePath?: string
    external?: boolean
  }>
}

/** POST /api/cabins 的完整结果：`created:false` = 目录已经是一个舱（一目录一舱）。 */
export interface CreateCabinResult {
  cabin: CabinDetail
  created: boolean
}

export async function createCabinWithResult(input: CreateCabinInput): Promise<CreateCabinResult> {
  const res = await fetch(url(""), {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  })
  const body = await handleResponse<{ cabin: CabinDetail; created?: boolean }>(res)
  // 老服务端没有 created 字段 → 视为新建（保持兼容）。
  return { cabin: body.cabin, created: body.created !== false }
}

export async function createCabin(input: CreateCabinInput): Promise<CabinDetail> {
  return (await createCabinWithResult(input)).cabin
}

/** Reuse an existing cabin directory (.cabin/manifest.json restore). */
export async function attachCabin(path: string, name?: string): Promise<CabinDetail> {
  const res = await fetch(url("/attach"), {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ path, ...(name ? { name } : {}) }),
  })
  const body = await handleResponse<{ cabin: CabinDetail }>(res)
  return body.cabin
}

/** GET /:id — DTO + derived cockpit view (attention/health). */
export async function getCabin(id: string, signal?: AbortSignal): Promise<{ cabin: CabinDetail; view: CabinView }> {
  const res = await fetch(url(`/${id}`), { signal })
  return handleResponse<{ cabin: CabinDetail; view: CabinView }>(res)
}

export interface PatchCabinInput {
  name?: string
  requirements?: string
  mainline_strategy?: "clean-main" | "pin"
  org?: string | null
  cockpit_prefs?: Record<string, unknown>
}

export async function patchCabin(id: string, version: number, fields: PatchCabinInput): Promise<CabinDetail> {
  const res = await fetch(url(`/${id}`), {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ version, ...fields }),
  })
  const body = await handleResponse<{ cabin: CabinDetail }>(res)
  return body.cabin
}

/** 删舱 = 软删除（2026-11-15 用户口径：平台计费，账不能删）。行留在库里，
 *  计费 / Trace / 验收历史都还能追；列表与接口从此看不见它。
 *  `deleteFiles: true` = 确认弹框里勾了「同时删除本地文件」，连舱目录一起删。 */
export interface DeleteCabinOptions {
  deleteFiles?: boolean
}

export interface DeleteCabinResult {
  ok: true
  /** 目录真的删掉了才 true（未勾选 / 路径受保护 / 删失败都是 false）。 */
  deleted_files: boolean
}

export async function deleteCabin(id: string, opts: DeleteCabinOptions = {}): Promise<DeleteCabinResult> {
  const query = opts.deleteFiles ? '?delete_files=1' : ''
  const res = await fetch(url(`/${id}${query}`), { method: "DELETE" })
  return handleResponse<DeleteCabinResult>(res)
}

// ============ Init gate ============

export async function initCabin(id: string): Promise<CabinDetail> {
  const res = await fetch(url(`/${id}/init`), { method: "POST" })
  const body = await handleResponse<{ cabin: CabinDetail }>(res)
  return body.cabin
}

export async function getCabinInit(id: string): Promise<{ status: CabinStatus; state: CabinInitState }> {
  const res = await fetch(url(`/${id}/init`))
  return handleResponse<{ status: CabinStatus; state: CabinInitState }>(res)
}

export async function retryCabinInit(id: string): Promise<{ ok: true; status: string }> {
  const res = await fetch(url(`/${id}/init/retry`), { method: "POST" })
  return handleResponse<{ ok: true; status: string }>(res)
}

// ============ Lifecycle ============

export async function wakeCabin(id: string): Promise<CabinDetail> {
  const res = await fetch(url(`/${id}/wake`), { method: "POST" })
  const body = await handleResponse<{ cabin: CabinDetail }>(res)
  return body.cabin
}

/** 「人来了」心跳：进舱 / 键鼠 / 点汐音都算。dormant 会被静默叫醒，active 刷新计时。
 *  幂等；客户端按分钟级节流，不做请求风暴。`at` 是事件发生的客户端时刻 ——
 *  服务端用它避开「刚点完打盹、旧心跳晚到又把人叫醒」的竞态。 */
export async function pingCabinActivity(id: string, at?: number): Promise<CabinDetail> {
  const res = await fetch(url(`/${id}/activity`), {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ at: at ?? Date.now() }),
  })
  const body = await handleResponse<{ cabin: CabinDetail }>(res)
  return body.cabin
}

export async function archiveCabin(id: string): Promise<CabinDetail> {
  const res = await fetch(url(`/${id}/archive`), { method: "POST" })
  const body = await handleResponse<{ cabin: CabinDetail }>(res)
  return body.cabin
}

export async function reopenCabin(id: string): Promise<CabinDetail> {
  const res = await fetch(url(`/${id}/reopen`), { method: "POST" })
  const body = await handleResponse<{ cabin: CabinDetail }>(res)
  return body.cabin
}

export async function dormantCabin(id: string): Promise<CabinDetail> {
  const res = await fetch(url(`/${id}/dormant`), { method: "POST" })
  const body = await handleResponse<{ cabin: CabinDetail }>(res)
  return body.cabin
}

export async function setCabinRequirements(id: string, version: number, requirements: string): Promise<CabinDetail> {
  const res = await fetch(url(`/${id}/requirements`), {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ version, requirements }),
  })
  const body = await handleResponse<{ cabin: CabinDetail }>(res)
  return body.cabin
}

// ============ Attention ============

export async function getCabinAttention(id: string): Promise<{ attention: CabinAttentionItem[]; health: CabinHealth }> {
  const res = await fetch(url(`/${id}/attention`))
  return handleResponse<{ attention: CabinAttentionItem[]; health: CabinHealth }>(res)
}

// ============ Repos / worktrees ============

export async function fetchCabinRepos(
  id: string, opts: { enrich?: boolean } = {},
): Promise<CabinRepoEntry[]> {
  const qs = opts.enrich === false ? '?enrich=0' : ''
  const res = await fetch(url(`/${encodeURIComponent(id)}/repos${qs}`))
  const body = await handleResponse<{ repos: CabinRepoEntry[] }>(res)
  return body.repos
}

/** 扫描一个绝对目录下的 git 仓库（建舱 / 绑定面板用；只读）。 */
export async function scanLocalProjects(path: string): Promise<LocalProjectCandidate[]> {
  const res = await fetch(url(`/local-projects?path=${encodeURIComponent(path)}`))
  const body = await handleResponse<{ projects: LocalProjectCandidate[] }>(res)
  return body.projects
}

export interface AddCabinRepoInput {
  source?: 'org' | 'local'
  name: string
  org?: string
  localPath?: string
  absolutePath?: string
  external?: boolean
}

export async function addCabinRepo(
  id: string, input: string | AddCabinRepoInput,
): Promise<CabinRepoEntry> {
  const body = typeof input === 'string' ? { name: input } : input
  const res = await fetch(url(`/${encodeURIComponent(id)}/repos`), {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  })
  return (await handleResponse<{ repo: CabinRepoEntry }>(res)).repo
}

export async function removeCabinRepo(id: string, name: string): Promise<{ removed: boolean }> {
  const res = await fetch(url(`/${encodeURIComponent(id)}/repos/${encodeURIComponent(name)}`), {
    method: 'DELETE',
  })
  return handleResponse<{ removed: boolean }>(res)
}

/** 显式开工作树；同分支已开 → 409（调用方按 CabinApiError.status 区分）。 */
export async function createRepoWorktree(
  id: string, name: string, opts: { branch?: string; instance?: string } = {},
): Promise<CabinRepoEntry> {
  const res = await fetch(url(`/${encodeURIComponent(id)}/repos/${encodeURIComponent(name)}/worktree`), {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(opts),
  })
  return (await handleResponse<{ repo: CabinRepoEntry }>(res)).repo
}

export async function listCabinRepos(id: string): Promise<CabinRepoEntry[]> {
  const res = await fetch(url(`/${id}/repos`))
  const body = await handleResponse<{ repos: CabinRepoEntry[] }>(res)
  return body.repos
}

export async function listCabinWorktrees(id: string): Promise<CabinWorktreeGroup[]> {
  const res = await fetch(url(`/${id}/worktrees`))
  const body = await handleResponse<{ worktrees: CabinWorktreeGroup[] }>(res)
  return body.worktrees
}

// ============ Jobs / trace (C2/C6/C8) ============

/** P3：作业 status/transport 派生自底层实体（K3）。 */
export type CabinJobView = CabinJob & {
  /** 作业的项目锚点（空 = 未归属；不猜）。 */
  status: string
  transport: string
  /** 项目锚点（空/缺省 = 未归属；老服务端没有该字段）。 */
  project_keys?: string[]
}

export async function listCabinJobs(id: string, signal?: AbortSignal): Promise<CabinJobView[]> {
  const res = await fetch(url(`/${id}/jobs`), { signal })
  const body = await handleResponse<{ jobs: CabinJobView[] }>(res)
  return body.jobs
}

export interface DispatchCabinJobInput {
  kind: CabinJobKind
  ref_id?: string | null
  session_id?: string | null
  title: string
  mandate?: CabinMandate
  prompt?: string | null
  priority?: number
}

export async function dispatchCabinJob(id: string, input: DispatchCabinJobInput): Promise<CabinJob> {
  const res = await fetch(url(`/${id}/jobs`), {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  })
  const body = await handleResponse<{ job: CabinJob }>(res)
  return body.job
}

export async function getCabinJob(
  id: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<{ job: CabinJob; events: CabinJobEvent[] }> {
  // signal 必须真的传进 fetch：预算到点时 abort 能取消**排队中/半开连接上**的
  // 请求，浏览器才会丢弃坏掉的 keep-alive socket、下一条请求换新连接。
  // 只 reject 不 abort 的话，那条请求会一直占着连接（2026-11-14 用户：详情
  // 永远停在「载入作业…」）。
  const res = await fetch(url(`/${id}/jobs/${jobId}`), { signal })
  return handleResponse<{ job: CabinJob; events: CabinJobEvent[] }>(res)
}

export async function setCabinJobPriority(id: string, jobId: string, priority: number): Promise<{ ok: true }> {
  const res = await fetch(url(`/${id}/jobs/${jobId}`), {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ priority }),
  })
  return handleResponse<{ ok: true }>(res)
}

export async function getCabinJobTrace(id: string, jobId: string): Promise<CabinJobEvent[]> {
  const res = await fetch(url(`/${id}/jobs/${jobId}/trace`))
  const body = await handleResponse<{ events: CabinJobEvent[] }>(res)
  return body.events
}

export async function getCabinTrace(id: string): Promise<CabinJobEvent[]> {
  const res = await fetch(url(`/${id}/trace`))
  const body = await handleResponse<{ events: CabinJobEvent[] }>(res)
  return body.events
}

// ============ Comm protocol (C9/D6) ============

export async function noteCabinJob(id: string, jobId: string, text: string): Promise<CabinJobEvent> {
  const res = await fetch(url(`/${id}/jobs/${jobId}/note`), {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ text, actor: "human" }),
  })
  const body = await handleResponse<{ event: CabinJobEvent }>(res)
  return body.event
}

export async function resumeCabinJob(id: string, jobId: string): Promise<CabinJobEvent> {
  const res = await fetch(url(`/${id}/jobs/${jobId}/resume`), { method: "POST" })
  const body = await handleResponse<{ event: CabinJobEvent }>(res)
  return body.event
}

// ============ Changes / pull (P3) ============

export interface CabinChangesSummary {
  totals: { commits: number; additions: number; dels: number; files: number }
  repos: Array<{ name: string; tasks: number; commits: number }>
  tasks: Array<{
    id: string; name: string; status: string
    commits: number; additions: number; dels: number; files: number; available: boolean
  }>
}

export async function getCabinChanges(id: string): Promise<CabinChangesSummary> {
  const res = await fetch(url(`/${id}/changes`))
  return handleResponse<CabinChangesSummary>(res)
}

export async function pullCabinRepo(id: string, name: string): Promise<{ branch: string; commit: string }> {
  const res = await fetch(url(`/${id}/repos/${encodeURIComponent(name)}/pull`), { method: "POST" })
  return handleResponse<{ branch: string; commit: string }>(res)
}

// ============ Knowledge (S7 / G4) / Usage (C7) ============

/** G4 读时 scoping 后的 findings（与全局 findingView 同形）。裁决复用全局
 *  /api/knowledge/findings/:id/adopt|ignore（kcAdoptFinding/kcIgnoreFinding）。 */
export async function getCabinFindings(
  id: string,
  status?: "open" | "resolved" | "ignored",
): Promise<import("@/lib/knowledge/knowledge-center-api").KcFindingView[]> {
  const qs = status ? `?status=${status}` : ""
  const res = await fetch(url(`/${id}/findings${qs}`))
  const body = await handleResponse<{ findings: import("@/lib/knowledge/knowledge-center-api").KcFindingView[] }>(res)
  return body.findings
}

/** C7 舱级消耗（llm_calls_costed 派生 + 子代理单列防双算）。 */
export interface CabinUsageJob {
  /** 项目锚点（chat / 未归属为空/缺省）。 */
  project_keys?: string[]
  job_id: string | null
  kind: "chat" | "task" | "workflow"
  label: string
  ref_id: string | null
  totalCalls: number
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }
  totals: { tokens: number; cost: { usd: number | null; complete: boolean }; cacheHitRate: number | null }
}

export interface CabinUsageSubagent {
  id: string
  job_id: string | null
  label: string
  status: string
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }
  tokens: number
  cost: { usd: number | null; complete: boolean }
}

export interface CabinUsagePayload {
  summary: {
    totalCalls: number
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }
    totals: { tokens: number; cost: { usd: number | null; complete: boolean }; cacheHitRate: number | null }
    modelBreakdown?: Record<string, { calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; costUsd: number | null }>
  }
  byJob: CabinUsageJob[]
  subagents: {
    count: number
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }
    tokens: number
    cost: { usd: number | null; complete: boolean }
    runs: CabinUsageSubagent[]
  }
  grand: {
    totalCalls: number
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }
    totals: { tokens: number; cost: { usd: number | null; complete: boolean }; cacheHitRate: number | null }
  }
  timing: { duration_ms: number }
}

export async function getCabinUsage(id: string, signal?: AbortSignal): Promise<CabinUsagePayload> {
  const res = await fetch(url(`/${id}/usage`), { cache: "no-store", signal })
  return handleResponse<CabinUsagePayload>(res)
}

// ============ Focus (C8) ============

export async function setCabinFocus(id: string, version: number, jobId: string | null): Promise<CabinDetail> {
  const res = await fetch(url(`/${id}/focus`), {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ version, job_id: jobId }),
  })
  const body = await handleResponse<{ cabin: CabinDetail }>(res)
  return body.cabin
}

export async function clearCabinFocus(id: string, version: number): Promise<CabinDetail> {
  const res = await fetch(url(`/${id}/focus?version=${version}`), { method: "DELETE" })
  const body = await handleResponse<{ cabin: CabinDetail }>(res)
  return body.cabin
}

// ============ SSE ============

/** Shared SSE endpoint for the cabin channel (`cabin:<id>`): cabin_status /
 *  cabin_init_progress / heartbeat. Consume via subscribeSSE (sse-manager). */
export function cabinEventsUrl(id: string): string {
  return url(`/${id}/events`)
}