import { getServerUrl } from "@/lib/server-config"
import { apiFetch, handleResponse } from "@/lib/api-client"

// ============ 知识中心读面 API（票11）============
// 写法照本目录 wiki-api.ts（apiFetch + handleResponse）；差异：**数据面钉 global**——
// 知识中心没有 org 概念（spec D6① 全局唯一 wiki，故事 18 界面零 org 切换），
// 所以本模块函数签名一律不带 org 参数，org=global 在此收口。
// 独立于 wiki-api.ts 文件：那个模块归 /wiki 旧页（票09 连页删除），本模块归 /knowledge。

/** 全局 wiki 的 org 钉值（server 端 GLOBAL_WIKI_ORG 同语义，客户端仅用于请求参数）。 */
const KC_ORG = "global"

// ── 树 / 页（沿用 /api/knowledge/wiki/* 端点，票03 语义钉 global）──

export interface KcTreeEntry {
  id: string
  path: string
  title: string
  summary: string
  stability: string
  ruleCount: number
}

export interface KcTreeDomain {
  name: string
  label: string
  count: number
  entries: KcTreeEntry[]
}

export interface KcTree {
  org: string
  domains: KcTreeDomain[]
  stats: { entries: number; cases: number; rules: number; lastCompiled: string }
  log: string | null
}

export interface KcGitCommit {
  hash: string
  date: string
  message: string
}

/** v3 页 front-matter 现形（票11 补口：type/aliases/links chips 渲染源）；v2/判例 null。 */
export interface KcPageFields {
  type: string
  entityKind: string | null
  aliases: string[]
  links: string[]
}

export interface KcCaseFields {
  symptom: string
  tags: string[]
  severity: string
  occurrences: number
  ruleRef: string | null
  status: string
}

export interface KcArticle {
  id: string
  domain: string
  title: string
  summary: string
  topics: string[]
  stability: string
  lastCompiled: string
  sources: string[]
  confidence: number
  path: string
  updatedAt: string
  body: string
  anchors: string[]
  gitHistory: KcGitCommit[]
  case: KcCaseFields | null
  page: KcPageFields | null
}

export interface KcSearchHit {
  id: string
  domain: string
  title: string
  summary: string
  path: string
  snippet: string
  anchors: string[]
}

export interface KcSearchResult {
  query: string
  mode: "fts" | "like"
  results: KcSearchHit[]
}

export async function getKcTree(): Promise<KcTree> {
  const res = await apiFetch(`${getServerUrl()}/api/knowledge/wiki/tree?org=${KC_ORG}`)
  return handleResponse<KcTree>(res)
}

export async function getKcArticle(id: string): Promise<KcArticle> {
  const res = await apiFetch(
    `${getServerUrl()}/api/knowledge/wiki/article/${encodeURIComponent(id)}?org=${KC_ORG}`,
  )
  return handleResponse<KcArticle>(res)
}

export async function searchKc(q: string, topK = 10): Promise<KcSearchResult> {
  const params = new URLSearchParams({ q, org: KC_ORG, topK: String(topK) })
  const res = await apiFetch(`${getServerUrl()}/api/knowledge/wiki/search?${params.toString()}`)
  return handleResponse<KcSearchResult>(res)
}

// ── 票11 新读端点 ──

/** 健康条聚合（无「待审核」字段；queueDepth/openFindings 票06/13 接位）。 */
export interface KcHealth {
  org: string
  pages: { total: number; entity: number; concept: number; topic: number; source: number; case: number }
  rawSources: number
  ingestedThisWeek: number
  openFindings: number
  queueDepth: number
  lastCompiled: string
  gitHead: string | null
}

export interface KcLogLine {
  date: string
  op: string
  title: string
  result: string
}

export interface KcRawSource {
  path: string
  bytes: number
  hash: string
  origin: string | null
  title: string | null
  ingestedAt: string | null
}

export interface KcPreference {
  content: string
  scope: string
  filePath: string
}

export async function getKcHealth(): Promise<KcHealth> {
  const res = await apiFetch(`${getServerUrl()}/api/knowledge/health`)
  return handleResponse<KcHealth>(res)
}

/** LOG 时间线；op 为服务端过滤参数（UI 默认全量拉取后前端过滤，深链场景可带 op）。 */
export async function getKcLog(op?: string): Promise<KcLogLine[]> {
  const url = op
    ? `${getServerUrl()}/api/knowledge/log?op=${encodeURIComponent(op)}`
    : `${getServerUrl()}/api/knowledge/log`
  const res = await apiFetch(url)
  return handleResponse<{ lines: KcLogLine[] }>(res).then(d => d.lines)
}

/**
 * 单文件读。入参 = RawPointer.path（知识根相对，如 `raw/inbox/x.md`）；
 * 端点收 raw 根相对段（`inbox/x.md`），前缀在此剥除。
 * （raw 列表端点 GET /api/knowledge/raw 已就位并由 S2 契约测试钉形——本模块暂不加
 *   无 importer 的包装；票12 抓取卡「看 raw 原文」入口用时再补。）
 */
export async function getKcRawFile(pointerPath: string): Promise<KcRawSource & { content: string }> {
  const rel = pointerPath.replace(/^raw\//, "")
  const res = await apiFetch(`${getServerUrl()}/api/knowledge/raw/${rel.split("/").map(encodeURIComponent).join("/")}`)
  return handleResponse<KcRawSource & { content: string }>(res)
}

/** user_preference.md（知识根人工文件区；旧 /api/knowledge/preference 端点，scope=global）。 */
export async function getKcPreference(): Promise<KcPreference> {
  const res = await apiFetch(`${getServerUrl()}/api/knowledge/preference?scope=${KC_ORG}`)
  return handleResponse<KcPreference>(res)
}

// ============ 票12 写面 API（ingest/编译任务/队列位次/revert）============
// 端点面票02/05/06/12 已就位；本段只做形状收口客户端，语义注释指向路由文件。
// 错误处理沿用 handleResponse（{error:{code,message}} 抛 Error(message)——需要 code
// 的调用方走 kcRequestRaw 自行分流）。

/** POST /api/knowledge/ingest 响应（票02 形状 + 票05 compileTask 回执）。 */
export interface KcIngestResult {
  mode: string
  dir: string
  title: string
  deduped: boolean
  raw: KcRawSource
  compileTask?: { taskId: string; status: string }
}

export interface KcIngestInput {
  mode: "url" | "text" | "file"
  url?: string
  text?: string
  path?: string
  title?: string
}

/** 投喂并投递编译（?compile=true 常开——对话投喂的语义就是入库即编）。 */
export async function kcIngest(input: KcIngestInput): Promise<KcIngestResult> {
  const res = await apiFetch(`${getServerUrl()}/api/knowledge/ingest?compile=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  return handleResponse<KcIngestResult>(res)
}

/** GET /api/knowledge/wiki/compile/task/:id 的 task 视图（票05 CompileTaskRecord）。 */
export interface KcCompileTask {
  id: string
  rawPath: string
  status: "queued" | "compiling" | "committed" | "failed"
  createdAt?: string
  finishedAt?: string
  result?: {
    rawPath: string
    rawHash: string
    rawTitle: string
    touched: { path: string; type: string; created: boolean }[]
    created: number
    updated: number
    contradictions: number
    commit: string | null
    changed: boolean
    deduped: boolean
    warnings: string[]
  }
  error?: { code: string; message: string }
}

export async function kcGetCompileTask(taskId: string): Promise<KcCompileTask | null> {
  const res = await apiFetch(`${getServerUrl()}/api/knowledge/wiki/compile/task/${encodeURIComponent(taskId)}`)
  if (res.status === 404) return null
  const data = await handleResponse<{ task: KcCompileTask }>(res)
  return data.task
}

/** GET /api/knowledge/wiki/queue/task/:id 的 task 视图（票06 QueueTaskView：位次 #N 单源）。 */
export interface KcQueueTask {
  id: string
  opKind: string
  label?: string
  state: "queued" | "running" | "committed" | "failed"
  position: number | null
  error?: { code: string; message: string }
}

export async function kcGetQueueTask(taskId: string): Promise<KcQueueTask | null> {
  const res = await apiFetch(`${getServerUrl()}/api/knowledge/wiki/queue/task/${encodeURIComponent(taskId)}`)
  if (res.status === 404) return null
  const data = await handleResponse<{ task: KcQueueTask }>(res)
  return data.task
}

/** POST /api/knowledge/wiki/revert 回执（票12）。 */
export interface KcRevertAck {
  taskId: string
  commit: string
  status: string
}

export async function kcRevert(commit: string): Promise<KcRevertAck> {
  const res = await apiFetch(`${getServerUrl()}/api/knowledge/wiki/revert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commit }),
  })
  return handleResponse<KcRevertAck>(res)
}

/** GET /api/knowledge/wiki/revert/task/:id 的 task 视图（票12 RevertTaskRecord）。 */
export interface KcRevertTask {
  id: string
  commit: string
  status: "queued" | "running" | "committed" | "failed"
  result?: {
    target: string
    revertCommit: string
    touched: { path: string; action: "removed" | "readded" | "restored" }[]
    ftsWarnings: string[]
  }
  error?: { code: string; message: string }
}

export async function kcGetRevertTask(taskId: string): Promise<KcRevertTask | null> {
  const res = await apiFetch(`${getServerUrl()}/api/knowledge/wiki/revert/task/${encodeURIComponent(taskId)}`)
  if (res.status === 404) return null
  const data = await handleResponse<{ task: KcRevertTask }>(res)
  return data.task
}
