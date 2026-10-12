import { getServerUrl } from "@/lib/server-config"
import { apiFetch, handleResponse } from "@/lib/api-client"

// ============ Wiki 只读 API（票03）============
// 写法照本目录 api.ts（GET + URLSearchParams 传 org）；数据面 = 票01 的
// /api/knowledge/wiki/{tree,article} + 票03 search（FTS5 主检索 + LIKE 降级）。

export interface WikiTreeEntry {
  id: string
  path: string
  title: string
  summary: string
  stability: string
  ruleCount: number
}

export interface WikiTreeDomain {
  name: string
  label: string
  count: number
  entries: WikiTreeEntry[]
}

export interface WikiStats {
  entries: number
  cases: number
  rules: number
  lastCompiled: string
  pendingReview: number
}

export interface WikiTree {
  org: string
  domains: WikiTreeDomain[]
  stats: WikiStats
  /** LOG.md 全文（策展日志表格视图数据源）；wiki 根缺失/不可读时 null。 */
  log: string | null
}

export interface WikiGitCommit {
  hash: string
  date: string
  message: string
}

export interface WikiArticle {
  id: string
  org: string
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
  /** 词条路径的 git 近史；非 git 仓/无提交时 []。 */
  gitHistory: WikiGitCommit[]
}

export interface WikiSearchHit {
  id: string
  domain: string
  title: string
  summary: string
  path: string
  snippet: string
  /** 命中行上的规则锚点 id（跳转词条后据此高亮）。 */
  anchors: string[]
}

export interface WikiSearchResult {
  org: string
  query: string
  /** fts = FTS5 MATCH 主检索；like = LIKE 降级（CJK 子串/坏语法）。 */
  mode: "fts" | "like"
  results: WikiSearchHit[]
}

export async function getWikiTree(org: string): Promise<WikiTree> {
  const params = new URLSearchParams({ org })
  const res = await apiFetch(`${getServerUrl()}/api/knowledge/wiki/tree?${params.toString()}`)
  return handleResponse<WikiTree>(res)
}

export async function getWikiArticle(id: string, org: string): Promise<WikiArticle> {
  const params = new URLSearchParams({ org })
  const res = await apiFetch(
    `${getServerUrl()}/api/knowledge/wiki/article/${encodeURIComponent(id)}?${params.toString()}`
  )
  return handleResponse<WikiArticle>(res)
}

export async function searchWiki(opts: {
  q: string
  org: string
  topK?: number
  domain?: string
}): Promise<WikiSearchResult> {
  const params = new URLSearchParams({ q: opts.q, org: opts.org })
  if (opts.topK) params.set("topK", String(opts.topK))
  if (opts.domain) params.set("domain", opts.domain)
  const res = await apiFetch(`${getServerUrl()}/api/knowledge/wiki/search?${params.toString()}`)
  return handleResponse<WikiSearchResult>(res)
}
