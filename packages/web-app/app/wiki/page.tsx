"use client"

import { useCallback, useEffect, useState } from "react"
import { getWikiArticle, getWikiTree, searchWiki, type WikiArticle, type WikiSearchResult, type WikiTree } from "@/lib/knowledge/wiki-api"
import { MarkdownPreview } from "@/components/resource/MarkdownPreview"
import { cn } from "@/lib/utils"

/**
 * /wiki — LLM-WIKI 知识词条只读页（票03，原型 Tab⑤ 三栏 mockup 照抄）。
 * 左 = 域树（各域计数 + System 组 LOG.md），中 = 词条渲染 + chips，
 * 右 = 元数据面板（sources 溯源 / git 近史 / LOG 摘录）。
 * 本期只读——无任何编辑/审核操作入口；既有 /experience KnowledgeTab 不动。
 * 暗色 TUI 主题走 globals.css 既有 --pop-* token，不新增配色。
 */

/** LOG.md markdown 表格行提取（原型 Tab③ 行格式；摘录进右栏）。 */
function logRows(md: string | null): string[] {
  if (!md) return []
  return md.split("\n").filter(l => l.trim().startsWith("|") && !l.includes("|---") && !l.includes("日期"))
}

export default function WikiPage() {
  // 知识中心票14（D6① wiki 全局唯一）：org 钉死 'global'（server 端本就忽略
  // 此参、恒按 GLOBAL_WIKI_ORG 读；票09 删旧路由后本页整体退役）。
  const org = "global"
  const [tree, setTree] = useState<WikiTree | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showLog, setShowLog] = useState(false)
  const [article, setArticle] = useState<WikiArticle | null>(null)
  const [articleLoading, setArticleLoading] = useState(false)
  /** 词条/检索加载失败显形（CODING_STANDARDS #2：错误 ≠ 空态，不许 setNull 吞掉）。 */
  const [articleError, setArticleError] = useState<string | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  // 顶部检索（FTS5 主检索 + LIKE 降级在服务端收口）
  const [searchQ, setSearchQ] = useState("")
  const [search, setSearch] = useState<WikiSearchResult | null>(null)
  const [searching, setSearching] = useState(false)
  /** 点击检索命中后带进词条视图的规则锚点（高亮定位用）。 */
  const [hitAnchors, setHitAnchors] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    getWikiTree(org)
      .then(t => { if (!cancelled) setTree(t) })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)) })
    return () => { cancelled = true }
  }, [org])

  const selectEntry = useCallback((id: string, anchors: string[] = []) => {
    setShowLog(false)
    setSelectedId(id)
    setHitAnchors(anchors)
    setArticleLoading(true)
    setArticleError(null)
    getWikiArticle(id, org)
      .then(a => { setArticle(a); setArticleError(null) })
      .catch((err: unknown) => {
        setArticle(null)
        setArticleError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setArticleLoading(false))
  }, [org])

  const runSearch = useCallback(() => {
    const q = searchQ.trim()
    if (!q) return
    setSearching(true)
    setSearchError(null)
    searchWiki({ q, org, topK: 8 })
      .then(r => { setSearch(r); setSearchError(null) })
      .catch((err: unknown) => {
        setSearch(null)
        setSearchError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setSearching(false))
  }, [searchQ, org])

  const jumpToHit = useCallback((id: string, anchors: string[]) => {
    selectEntry(id, anchors)
  }, [selectEntry])

  /** 票04 顺藤：判例 rule_ref → 检索该锚点所在规则词条并跳转高亮（"沿 rule_ref 顺藤读规则"）。 */
  const followRuleRef = useCallback((ref: string) => {
    searchWiki({ q: ref, org, topK: 5 })
      .then(r => {
        const hit = r.results.find(h => h.anchors.includes(ref)) ?? r.results[0]
        if (hit) selectEntry(hit.id, hit.anchors)
      })
      .catch(() => { /* 顺藤失败不打断浏览 */ })
  }, [org, selectEntry])

  const excerptRows = logRows(tree?.log)
  const logForEntry = article ? excerptRows.filter(r => r.includes(article.path)) : []

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 健康概览条（故事 32：词条/规则/案例/最近编译/待审核） */}
      {tree && (
        <div
          data-testid="wiki-health-bar"
          className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b-[1.5px] border-pop-bd bg-pop-paper px-4 py-2 text-xs font-bold text-pop-dim"
        >
          <span className="text-pop-ink">LLM-WIKI · {tree.org}</span>
          <span>词条 {tree.stats.entries}</span>
          <span>规则 {tree.stats.rules}</span>
          <span>案例 {tree.stats.cases}</span>
          <span>最近编译 {tree.stats.lastCompiled || "—"}</span>
          <span>待审核 {tree.stats.pendingReview}</span>
          <span className="ml-auto text-[10px]">只读浏览 · 写入仅策展通道</span>
        </div>
      )}

      {/* 顶部检索条（原型 Tab⑤ 工具条：FTS5 全文，命中规则锚点级） */}
      <form
        className="flex items-center gap-2 border-b-[1.5px] border-pop-bd bg-pop-bg px-4 py-2"
        onSubmit={e => { e.preventDefault(); runSearch() }}
      >
        <input
          value={searchQ}
          onChange={e => setSearchQ(e.target.value)}
          placeholder="搜索词条/规则（FTS5）… 如: Promise 超时"
          aria-label="检索词条/规则"
          className="h-8 flex-1 rounded-lg border-[1.5px] border-pop-bd bg-pop-inset px-3 text-xs text-pop-ink placeholder:text-pop-dim focus:outline-none focus:ring-1 focus:ring-pop-pink"
        />
        <button
          type="submit"
          className="h-8 rounded-lg border-[1.5px] border-pop-bd bg-pop-cyan-soft px-3 text-xs font-black text-pop-cyan hover:brightness-110"
        >
          {searching ? "检索中…" : "检索"}
        </button>
        {search && (
          <button
            type="button"
            onClick={() => setSearch(null)}
            className="h-8 rounded-lg px-2 text-xs font-bold text-pop-dim hover:bg-accent"
          >
            清除
          </button>
        )}
      </form>

      {/* 检索失败显形（错误 ≠ 无结果假空态） */}
      {searchError && (
        <div data-testid="wiki-search-error" className="border-b-[1.5px] border-pop-bd bg-pop-paper px-4 py-2 text-xs font-bold text-pop-red">
          检索失败：{searchError}
        </div>
      )}

      {/* 检索结果浮层：命中片段 + 锚点定位，点击跳转词条 */}
      {search && (
        <div data-testid="wiki-search-results" className="border-b-[1.5px] border-pop-bd bg-pop-paper px-4 py-2">
          <div className="mb-1 text-[10px] font-black uppercase tracking-wider text-pop-dim">
            命中 {search.results.length} 条 · {search.mode === "fts" ? "FTS5 全文" : "LIKE 降级匹配"}
          </div>
          {search.results.map(hit => (
            <button
              key={hit.id}
              type="button"
              onClick={() => jumpToHit(hit.id, hit.anchors)}
              className="mb-1 block w-full rounded-md bg-pop-inset px-2 py-1.5 text-left hover:bg-accent"
            >
              <span className="text-xs font-bold text-pop-ink">{hit.title}</span>
              <span className="ml-2 text-[10px] text-pop-dim">{hit.domain}</span>
              <div className="mt-0.5 text-[11px] text-pop-dim">
                <mark className="bg-transparent font-bold text-pop-cyan">{hit.snippet}</mark>
                {hit.anchors.map(a => (
                  <span key={a} data-anchor-hit={a} className="ml-2 rounded bg-pop-pink-soft px-1 font-mono text-[10px] text-pop-pink">{a}</span>
                ))}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* 三栏：220px / 1fr / 250px（原型 .wlayout 同构） */}
      <div className="grid min-h-0 flex-1 grid-cols-[220px_1fr_250px]">
        {/* 左：域树 + System 组 */}
        <aside className="min-h-0 overflow-y-auto border-r-[1.5px] border-pop-bd bg-pop-idle p-2">
          {error && <div className="p-2 text-xs text-pop-red">加载失败：{error}</div>}
          {!tree && !error && <div className="p-2 text-xs text-pop-dim">加载中…</div>}
          {tree?.domains.map(d => (
            <div key={d.name} className="mb-3">
              <div className="flex items-center justify-between px-2 py-1 text-[10px] font-black uppercase tracking-wider text-pop-dim">
                <span>{d.label}</span>
                <span>{d.count}</span>
              </div>
              {d.entries.map(e => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => selectEntry(e.id)}
                  className={cn(
                    "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs font-bold text-pop-ink hover:bg-accent",
                    !showLog && selectedId === e.id && "bg-pop-pink-soft",
                  )}
                  title={e.path}
                >
                  <span className="truncate flex-1">{e.title}</span>
                  {e.ruleCount > 0 && <span className="shrink-0 text-[9px] text-pop-dim">{e.ruleCount}</span>}
                </button>
              ))}
            </div>
          ))}
          {/* System 组：LOG.md 策展日志（渲染视图）+ 健康概览入口 */}
          {tree && (
            <div>
              <div className="px-2 py-1 text-[10px] font-black uppercase tracking-wider text-pop-dim">System</div>
              <button
                type="button"
                onClick={() => { setShowLog(true); setSelectedId(null) }}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs font-bold text-pop-ink hover:bg-accent",
                  showLog && "bg-pop-pink-soft",
                )}
              >
                📜 LOG.md 策展日志
              </button>
              <div className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs text-pop-dim">
                🩺 词条 {tree.stats.entries} · 规则 {tree.stats.rules} · 待审核 {tree.stats.pendingReview}
              </div>
            </div>
          )}
        </aside>

        {/* 中：词条渲染区（MarkdownPreview = react-markdown + remark-gfm + rehype-sanitize） */}
        <section className="min-h-0 overflow-y-auto bg-pop-bg">
          {showLog ? (
            <div className="p-6">
              <h1 className="mb-4 text-2xl font-black text-pop-ink">📜 Curation Log（策展日志）</h1>
              {tree?.log
                ? <MarkdownPreview content={tree.log} />
                : <div className="text-sm text-pop-dim">wiki 根尚无 LOG.md（首编译后出现）</div>}
            </div>
          ) : articleLoading ? (
            <div className="flex items-center justify-center py-16 text-sm text-pop-dim">加载中…</div>
          ) : articleError ? (
            // 错误显形（CODING_STANDARDS #2）：fetch 失败不得伪装成「未选中词条」假空态
            <div data-testid="wiki-article-error" className="p-6 text-sm font-bold text-pop-red">
              词条加载失败：{articleError}
            </div>
          ) : article ? (
            <div className="p-6">
              <h1 data-testid="wiki-entry-title" className="mb-2 text-2xl font-black text-pop-ink">{article.title}</h1>
              {/* 元数据 chips（原型 Tab⑤：primary 描边域 / 绿稳定 / 青 confidence / muted 编译日与 id） */}
              <div className="mb-4 flex flex-wrap items-center gap-2 text-[11px] font-bold">
                <span className="rounded-full border-[1.5px] border-pop-pink px-2 py-0.5 text-pop-pink">{article.domain}</span>
                {article.case ? (
                  <>
                    {/* 票04 判例状态 chips：open|distilled|superseded + severity + ×occurrences + rule_ref 顺藤 */}
                    <span data-testid="wiki-case-status" className={cn("rounded-full px-2 py-0.5",
                      article.case.status === "distilled" ? "bg-pop-green-soft text-pop-green"
                        : article.case.status === "superseded" ? "bg-pop-idle text-pop-dim"
                          : "bg-pop-amber-soft text-pop-amber")}>
                      {article.case.status}
                    </span>
                    <span className="rounded-full bg-pop-pink-soft px-2 py-0.5 text-pop-pink">{article.case.severity}</span>
                    <span className="rounded-full bg-pop-cyan-soft px-2 py-0.5 text-pop-cyan">×{article.case.occurrences}</span>
                    {article.case.ruleRef && (
                      <button
                        type="button"
                        data-testid="wiki-rule-ref"
                        title="沿 rule_ref 顺藤读规则"
                        onClick={() => followRuleRef(article.case!.ruleRef!)}
                        className="rounded-full border-[1.5px] border-pop-cyan px-2 py-0.5 font-mono text-pop-cyan hover:bg-pop-cyan-soft"
                      >
                        → {article.case.ruleRef}
                      </button>
                    )}
                    {article.case.tags.map(t => (
                      <span key={t} className="rounded-full bg-pop-idle px-2 py-0.5 text-pop-dim">#{t}</span>
                    ))}
                  </>
                ) : (
                  <>
                    <span className={cn("rounded-full px-2 py-0.5",
                      article.stability === "stable" ? "bg-pop-green-soft text-pop-green" : "bg-pop-amber-soft text-pop-amber")}>
                      {article.stability}
                    </span>
                    <span className="rounded-full bg-pop-cyan-soft px-2 py-0.5 text-pop-cyan">confidence {article.confidence}</span>
                    <span className="rounded-full bg-pop-idle px-2 py-0.5 text-pop-dim">编译于 {article.lastCompiled}</span>
                    <span className="rounded-full bg-pop-idle px-2 py-0.5 text-pop-dim">{article.id}</span>
                  </>
                )}
              </div>
              <MarkdownPreview content={article.body} />
            </div>
          ) : (
            <div className="flex items-center justify-center py-16 text-sm text-pop-dim">选择词条查看内容</div>
          )}
        </section>

        {/* 右：元数据面板（sources 溯源 / git 近史 / LOG 摘录） */}
        <aside className="min-h-0 overflow-y-auto border-l-[1.5px] border-pop-bd bg-pop-idle p-3 text-xs text-pop-dim">
          {article ? (
            <>
              <div className="mb-1 text-[10px] font-black uppercase tracking-wider text-pop-dim">Sources（溯源）</div>
              <ul className="mb-4 space-y-1">
                {article.sources.map(s => (
                  <li key={s} className="break-all rounded-md bg-pop-inset px-2 py-1 font-mono text-[10px] text-pop-ink">{s}</li>
                ))}
              </ul>
              <div className="mb-1 text-[10px] font-black uppercase tracking-wider text-pop-dim">Git History（近史）</div>
              <ul className="mb-4 space-y-1">
                {article.gitHistory.map(g => (
                  <li key={g.hash} className="rounded-md bg-pop-inset px-2 py-1">
                    <span className="font-mono text-[10px] text-pop-cyan">{g.hash}</span>{" "}
                    <span className="text-[10px]">{g.date}</span>
                    <div className="break-all text-[10px] text-pop-ink">{g.message}</div>
                  </li>
                ))}
                {article.gitHistory.length === 0 && <li className="text-[10px]">—</li>}
              </ul>
              <div className="mb-1 text-[10px] font-black uppercase tracking-wider text-pop-dim">LOG 摘录</div>
              <ul className="space-y-1">
                {logForEntry.slice(0, 3).map(r => (
                  <li key={r} className="break-all rounded-md bg-pop-inset px-2 py-1 font-mono text-[10px]">{r}</li>
                ))}
                {logForEntry.length === 0 && <li className="text-[10px]">—</li>}
              </ul>
            </>
          ) : (
            <div>选择词条后显示 sources 溯源 / git 近史 / LOG 摘录</div>
          )}
        </aside>
      </div>
    </div>
  )
}
