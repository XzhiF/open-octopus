import { getServerUrl } from "@/lib/server-config"
import { apiFetch, handleResponse } from "@/lib/api-client"
import type { SkillGrantReceipt } from "@/lib/knowledge-center/card-protocol"

// ============ 知识中心读面 API（票11）============
// 写法照全站 apiFetch + handleResponse 模式（lib/api-client）；差异：**数据面钉 global**——
// 知识中心没有 org 概念（spec D6① 全局唯一 wiki，故事 18 界面零 org 切换），
// 所以本模块函数签名一律不带 org 参数，org=global 在此收口。
// （历史注：原写法样板为本目录 wiki-api.ts——那个模块归 /wiki 旧页，
//   票09 已连页删除；本模块归 /knowledge，是唯一知识 API 客户端。）

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
  /** 链目标（front-matter ∪ 正文 [[…]]，服务端 links 列单源；右栏反链倒排数据面） */
  links?: string[]
  /** 反链：哪些活页的链接指向本页（linkPointsToPage 判据与服务端退役面单源） */
  backlinks?: string[]
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
  /** INDEX.md 文本（log 同律：缺席=诚实 null；树顶「INDEX 总览」视图消费） */
  index?: string | null
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
  /**
   * P4 票07 页元数据实效实时段（DB 账目 rollup=页键行∪锚点行，**非** front-matter
   * 快照列；与 confidence 快照值并存展示是特性——夜巡 sync 未跑时 owner 看得见差）。
   * measured=false ⇒ confidence 为编译期初值（样本不足不抖动闸）；helpfulRate 无闸
   * 直显现账。未接账目 DAO（旧服务端）⇒ null 诚实缺席。
   */
  effectiveness: KcEffectiveness | null
}

/** 票07 实效实时段（server routes/wiki.ts effectivenessViewFor 同形）。 */
export interface KcEffectiveness {
  citedCount: number
  helpfulCount: number
  notHelpfulCount: number
  helpfulRate: number | null
  confidence: number
  measured: boolean
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

/** 健康条聚合（无「待审核」字段；queueDepth/openFindings 票06/13 接位；
 *  avgConfidence=P4 票07 全库平均置信——已测行口径，全未测/未装配诚实 null；
 *  score=P4 票08 health score 0-100（公式单源服务端 health-score.ts；
 *  空库/未装配巡检 ⇒ null 诚实不可评，不伪造满分——只换值不换形同律）。 */
export interface KcHealth {
  org: string
  pages: { total: number; entity: number; concept: number; topic: number; source: number; case: number }
  rawSources: number
  ingestedThisWeek: number
  openFindings: number
  queueDepth: number
  avgConfidence: number | null
  score: number | null
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
 */
export async function getKcRawFile(pointerPath: string): Promise<KcRawSource & { content: string }> {
  const rel = pointerPath.replace(/^raw\//, "")
  const res = await apiFetch(`${getServerUrl()}/api/knowledge/raw/${rel.split("/").map(encodeURIComponent).join("/")}`)
  return handleResponse<KcRawSource & { content: string }>(res)
}

/**
 * raw 全清单（原料库视图数据面；GET /api/knowledge/raw 由 S2 契约测试钉形，
 * 知识中心改版·原料库为其首个 importer——孤 raw 从此可见可盘点）。
 */
export async function listKcRawSources(): Promise<KcRawSource[]> {
  const res = await apiFetch(`${getServerUrl()}/api/knowledge/raw?org=${KC_ORG}`)
  return handleResponse<{ org: string; sources: KcRawSource[] }>(res).then(d => d.sources)
}

// 原 /api/knowledge/preference 读包装已删（ADR-0033：偏好概念整体清除）。

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

/**
 * 重试编译（D-kc15-1 票07）：failed 任务再触发 = POST /api/knowledge/wiki/compile
 * 同 rawPath——复用既有 ingest-compile 全局串行队列通道（红线2 禁直写 wiki；
 * 失败编译经写闸全量回滚无回执页，重投必走真编译不被 dedup 吞）。
 */
export interface KcCompileAck {
  taskId: string
  rawPath: string
  status: string
}

export async function kcCompileRetry(rawPath: string): Promise<KcCompileAck> {
  const res = await apiFetch(`${getServerUrl()}/api/knowledge/wiki/compile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: rawPath }),
  })
  return handleResponse<KcCompileAck>(res)
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

// ============ 票08 页退役面 API（对话退役意图 → 队列 page-retire）============

/** POST /api/knowledge/wiki/retire 回执（票08 · 故事32）。 */
export interface KcRetireAck {
  taskId: string
  path: string
  status: string
}

export async function kcRetire(input: { path?: string; pageId?: string; reason?: string }): Promise<KcRetireAck> {
  const res = await apiFetch(`${getServerUrl()}/api/knowledge/wiki/retire`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  return handleResponse<KcRetireAck>(res)
}

/** GET /api/knowledge/wiki/retire/task/:id 的 task 视图（票08 PageRetireTaskRecord）。 */
export interface KcRetireTask {
  id: string
  path: string
  status: "queued" | "running" | "committed" | "failed"
  result?: { retiredPath: string; retireCommit: string; pageId: string }
  error?: { code: string; message: string }
}

export async function kcGetRetireTask(taskId: string): Promise<KcRetireTask | null> {
  const res = await apiFetch(`${getServerUrl()}/api/knowledge/wiki/retire/task/${encodeURIComponent(taskId)}`)
  if (res.status === 404) return null
  const data = await handleResponse<{ task: KcRetireTask }>(res)
  return data.task
}

// ============ 票09 页恢复面 API（对话「恢复 oct-XXX」→ 队列 page-restore）============

/** POST /api/knowledge/wiki/restore 回执（票09 · 故事17；口令三形态 anchor>path>pageId）。 */
export interface KcRestoreAck {
  taskId: string
  path: string
  status: string
}

export async function kcRestore(input: { anchor?: string; path?: string; pageId?: string; reason?: string }): Promise<KcRestoreAck> {
  const res = await apiFetch(`${getServerUrl()}/api/knowledge/wiki/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  return handleResponse<KcRestoreAck>(res)
}

/** GET /api/knowledge/wiki/restore/task/:id 的 task 视图（票09 PageRestoreTaskRecord）。 */
export interface KcRestoreTask {
  id: string
  path: string
  anchor?: string
  status: "queued" | "running" | "committed" | "failed"
  result?: { fromRetired: string; restoreCommit: string; pageId: string; inboundRestored: string[]; warnings: string[] }
  error?: { code: string; message: string }
}

export async function kcGetRestoreTask(taskId: string): Promise<KcRestoreTask | null> {
  const res = await apiFetch(`${getServerUrl()}/api/knowledge/wiki/restore/task/${encodeURIComponent(taskId)}`)
  if (res.status === 404) return null
  const data = await handleResponse<{ task: KcRestoreTask }>(res)
  return data.task
}

// ============ 票13 findings 面 API（列表/裁决/即时体检/回填）============

/** GET /api/knowledge/findings 的视图（routes/findings.ts findingView 单源形状；
 *  severity=P4 票08 派生键（kind→三档映射单源服务端 health-score.ts），ranked 分组视图消费）。 */
export interface KcFindingView {
  id: string
  kind: string
  severity: "critical" | "major" | "minor"
  status: "open" | "resolved" | "ignored"
  title: string
  detail: Record<string, unknown>
  pages: string[]
  rawRef: string
  source: string
  createdAt: string
  updatedAt: string
}

export async function kcListFindings(status?: "open" | "resolved" | "ignored"): Promise<KcFindingView[]> {
  const url = status
    ? `${getServerUrl()}/api/knowledge/findings?status=${status}`
    : `${getServerUrl()}/api/knowledge/findings`
  const res = await apiFetch(url)
  const data = await handleResponse<{ org: string; findings: KcFindingView[] }>(res)
  return data.findings
}

export interface KcAdoptAck {
  findingId: string
  taskId: string
  status: string
}

/** [采纳修订]：POST 202（修订稿经全局队列 finding-fix 编译）。 */
export async function kcAdoptFinding(findingId: string): Promise<KcAdoptAck> {
  const res = await apiFetch(`${getServerUrl()}/api/knowledge/findings/${encodeURIComponent(findingId)}/adopt`, { method: "POST" })
  return handleResponse<KcAdoptAck>(res)
}

/** [忽略]：记录在案（同步）。 */
export async function kcIgnoreFinding(findingId: string): Promise<{ findingId: string; status: string }> {
  const res = await apiFetch(`${getServerUrl()}/api/knowledge/findings/${encodeURIComponent(findingId)}/ignore`, { method: "POST" })
  return handleResponse<{ findingId: string; status: string }>(res)
}

export interface KcFixTask {
  id: string
  findingId: string
  kind: string
  status: "queued" | "running" | "committed" | "failed"
  result?: { commit: string | null; changed: boolean; touched: Array<{ path: string; type: string; created: boolean }>; warnings: string[] }
  error?: { code: string; message: string }
}

export async function kcGetFixTask(taskId: string): Promise<KcFixTask | null> {
  const res = await apiFetch(`${getServerUrl()}/api/knowledge/findings/fix/task/${encodeURIComponent(taskId)}`)
  if (res.status === 404) return null
  const data = await handleResponse<{ task: KcFixTask }>(res)
  return data.task
}

/** POST /api/knowledge/patrol — 「体检一下」即时触发的服务面。 */
export interface KcPatrolReport {
  scanned: { pages: number; executions: number }
  findings: Array<{ id: string; kind: string; title: string; pages: string[]; action: string; target?: string; hosts?: string[] }>
  counts: Record<string, number>
  newFindings: Array<{ id: string; kind: string; title: string }>
  warnings: string[]
}

export async function kcPatrol(): Promise<KcPatrolReport> {
  const res = await apiFetch(`${getServerUrl()}/api/knowledge/patrol`, { method: "POST" })
  return handleResponse<KcPatrolReport>(res)
}

export interface KcBackfillAck {
  mode: "backfill"
  deduped: boolean
  raw: { path: string; hash: string; origin: string; bytes: number }
  compileTask: { taskId: string; status: string } | null
}

/** [编进 wiki]：对话摘录落 raw（冻结）+ 编译投递回执。 */
export async function kcBackfill(input: { text: string; title?: string; sessionId?: string }): Promise<KcBackfillAck> {
  const res = await apiFetch(`${getServerUrl()}/api/knowledge/backfill`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  return handleResponse<KcBackfillAck>(res)
}

// ============ P3 票02 素材包面（pack 读 + 剔除/焦点重编译）============
// 端点契约见 server routes/wiki-pack.ts；重编译队列位次复用 kcGetQueueTask（票06 单源）。

export interface KcPackItemView {
  kind: string
  name: string
  path: string
  bytes: number
  sha256: string
  excluded: boolean
}

export interface KcPackView {
  taskId: string
  legacy?: boolean
  rawPath?: string
  packPath?: string
  manifestPath?: string
  digest?: string
  createdAt?: string
  items: KcPackItemView[]
  recompiles: Array<{ at: string; excludePath?: string | null; focus?: string | null; queueTaskId: string }>
}

export async function kcGetPack(taskId: string): Promise<KcPackView | null> {
  const res = await apiFetch(`${getServerUrl()}/api/knowledge/wiki/pack/${encodeURIComponent(taskId)}`)
  if (res.status === 404) return null
  return handleResponse<KcPackView>(res)
}

export interface KcRecompileAck {
  queueTaskId: string
  excludedPath: string | null
  focus: string | null
  manifestHash: string
  opKind: string
}

/** 剔除某件→重编译 / 焦点重编译：经全局串行队列（archive-compile，禁直写 wiki）。 */
export async function kcRecompilePack(taskId: string, input: { excludePath?: string; focus?: string }): Promise<KcRecompileAck> {
  const res = await apiFetch(`${getServerUrl()}/api/knowledge/wiki/pack/${encodeURIComponent(taskId)}/recompile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  return handleResponse<KcRecompileAck>(res)
}

// ============ P3 票03 判例面（退役钮执行口）============
// 端点契约见 server routes/wiki-case.ts；队列位次复用 kcGetQueueTask（票06 单源）。
// 红线2：判例一切写（含退役 superseded）经 case-archive opKind 入全局串行队列——
// 本函数只是回执形状的前端投影，写通道不在前端。

export interface KcCaseRetireAck {
  caseId: string
  queueTaskId: string
  casePath: string
}

/** [退役]：POST /wiki/case/retire ⇒ 202 {caseId, queueTaskId, casePath}（异步经队列生效）。 */
export async function kcRetireCase(caseId: string): Promise<KcCaseRetireAck> {
  const res = await apiFetch(`${getServerUrl()}/api/knowledge/wiki/case/retire`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ caseId }),
  })
  return handleResponse<KcCaseRetireAck>(res)
}

// ============ P3 票05 授予/撤销机械链 API（草案卡钮的执行面）============
// 端点契约见 server `routes/wiki-draft.ts`：POST /api/knowledge/drafts/:name/
// grant|revoke {cloneName}。错误分流需要 code（GRANT_NAME_CLASH 等），故不走
// handleResponse 的 message-only 抛法——自读 {error:{code,message}} 抛 `${code}:
// ${message}`（卡面错误行按 code 显形，不伪造 granted）。

/** 授予（cloneName='*' =「授给所有分身」落共享技能层，ADR-0005）。 */
export async function kcGrantDraft(name: string, cloneName: string): Promise<SkillGrantReceipt> {
  const res = await apiFetch(`${getServerUrl()}/api/knowledge/drafts/${encodeURIComponent(name)}/grant`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cloneName }),
  })
  const body = (await res.json().catch(() => null)) as ({ error?: { code?: string; message?: string } } & SkillGrantReceipt) | null
  if (!res.ok) {
    throw new Error(`${body?.error?.code ?? `HTTP_${res.status}`}: ${body?.error?.message ?? "授予失败"}`)
  }
  return body as SkillGrantReceipt
}

/** 撤销（逆链=技能目录移除+预置源逆同步+版本回退；对同一 cloneName）。 */
export async function kcRevokeDraft(name: string, cloneName: string): Promise<SkillGrantReceipt> {
  const res = await apiFetch(`${getServerUrl()}/api/knowledge/drafts/${encodeURIComponent(name)}/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cloneName }),
  })
  const body = (await res.json().catch(() => null)) as ({ error?: { code?: string; message?: string } } & SkillGrantReceipt) | null
  if (!res.ok) {
    throw new Error(`${body?.error?.code ?? `HTTP_${res.status}`}: ${body?.error?.message ?? "撤销失败"}`)
  }
  return body as SkillGrantReceipt
}
