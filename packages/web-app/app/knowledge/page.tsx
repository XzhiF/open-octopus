"use client"

import { useCallback, useEffect, useState } from "react"
import {
  getKcArticle,
  getKcHealth,
  getKcLog,
  getKcRawFile,
  getKcTree,
  type KcArticle,
  type KcHealth,
  type KcLogLine,
  type KcRawSource,
  type KcTree,
} from "@/lib/knowledge/knowledge-center-api"
import { KcHeaderHealth } from "@/components/knowledge-center/kc-header-health"
import { KcKnowledgeTree, type KcSpecialView } from "@/components/knowledge-center/knowledge-tree"
import { WikiPageView } from "@/components/knowledge-center/wiki-page-view"
import { WikiRail } from "@/components/knowledge-center/wiki-rail"
import { RawView } from "@/components/knowledge-center/raw-view"
import { RawLibView } from "@/components/knowledge-center/raw-lib-view"
import { IndexView } from "@/components/knowledge-center/index-view"
import { KcSearchPalette } from "@/components/knowledge-center/search-palette"
import { LogTimeline, type KcLogFilter } from "@/components/knowledge-center/log-timeline"
import { CuratorDrawer } from "@/components/knowledge-center/curator-drawer"
import { resolveKcPageTarget } from "@/components/knowledge-center/page-target"
import { cn } from "@/lib/utils"

/**
 * /knowledge — 知识中心（知识中心改版 · ADR-0033：wiki 主场 + 策展人抽屉）。
 * 布局**恒定**：左导航树（五类 + System：INDEX 总览/LOG/原料库）+ 中正文（max-w
 * 阅读线）+ 右栏三件套（目录/反链/实效账）；策展人 = 右侧 overlay 抽屉（多会话
 * tab/历史/拖宽，开合与调宽**永不重排主场**——取代已废除的「对话模式/浏览模式」
 * 两套 grid 切换）。
 * 交互契约 v2：卡片引用页 ⇒ 页头「引用药丸」，点击才跳转；**右栏永不自动跟随**
 * （原「跟随/钉住」语义废除）。健康条瘦身页头三槽，点开弹层收全量指标 + ranked
 * findings。人工偏好视图已随概念删除（ADR-0033）。
 * 数据面钉 global（D6①，界面零 org 切换，故事 18）。暗色 TUI 主题沿用 globals.css
 * pop-* token。取数失败一律显形错误条，不伪造空态（CODING_STANDARDS #2）。
 */

/** 主场正文区视图态：页 / INDEX 总览 / LOG 时间线 / 原料库清单 / raw 单文件。 */
export type KcView =
  | { kind: "page"; id: string; anchor?: string }
  | { kind: "index" }
  | { kind: "log" }
  | { kind: "rawlib" }
  | { kind: "raw"; pointerPath: string }

/** 引用药丸态（卡引用页 → 页头亮丸，点击才渲染；永不自动跳转=负断言对象）。 */
interface KcCite { pageId: string; title: string; cardId: string }

export default function KnowledgePage() {
  const [tree, setTree] = useState<KcTree | null>(null)
  const [treeError, setTreeError] = useState<string | null>(null)
  const [health, setHealth] = useState<KcHealth | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)

  const [paletteOpen, setPaletteOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [view, setView] = useState<KcView | null>(null)
  const [cite, setCite] = useState<KcCite | null>(null)
  /** 库面变更计数（编译/回滚落定 ⇒ 当前视图重取，卡/栏/盘同步——票12 同律） */
  const [wikiEpoch, setWikiEpoch] = useState(0)

  // 视图数据（各态独立 loading/error；失败保留旧值+显形错误位由渲染层二选一）
  const [article, setArticle] = useState<KcArticle | null>(null)
  const [articleLoading, setArticleLoading] = useState(false)
  const [articleError, setArticleError] = useState<string | null>(null)
  const [rawFile, setRawFile] = useState<(KcRawSource & { content: string }) | null>(null)
  const [rawLoading, setRawLoading] = useState(false)
  const [rawError, setRawError] = useState<string | null>(null)
  const [log, setLog] = useState<KcLogLine[] | null>(null)
  const [logLoading, setLogLoading] = useState(false)
  const [logError, setLogError] = useState<string | null>(null)
  const [logFilter, setLogFilter] = useState<KcLogFilter>("all")

  // 树/健康条取数（编译/回滚落定后 onWikiChanged 重取——卡片态与库面同步）
  const loadTree = useCallback(async () => {
    try {
      const t = await getKcTree()
      setTree(t)
      setTreeError(null)
    } catch (err: unknown) {
      setTreeError(err instanceof Error ? err.message : String(err))
    }
  }, [])
  const loadHealth = useCallback(async () => {
    try {
      const h = await getKcHealth()
      setHealth(h)
      setHealthError(null)
    } catch (err: unknown) {
      setHealthError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => { void loadTree() }, [loadTree])
  useEffect(() => { void loadHealth() }, [loadHealth])

  // Ctrl/⌘+K 开合检索命令条（useGlobalCommandPalette 先例同律）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault()
        setPaletteOpen(prev => !prev)
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [])

  // 视图态 ⇒ 取数（page/raw/log 各一路；INDEX 随 tree 响应零额外请求）
  useEffect(() => {
    if (!view) return
    let cancelled = false
    if (view.kind === "page") {
      setArticleLoading(true)
      setArticleError(null)
      getKcArticle(view.id)
        .then(a => { if (!cancelled) { setArticle(a); setArticleError(null) } })
        .catch((err: unknown) => { if (!cancelled) { setArticle(null); setArticleError(err instanceof Error ? err.message : String(err)) } })
        .finally(() => { if (!cancelled) setArticleLoading(false) })
    } else if (view.kind === "raw") {
      setRawLoading(true)
      setRawError(null)
      getKcRawFile(view.pointerPath)
        .then(f => { if (!cancelled) { setRawFile(f); setRawError(null) } })
        .catch((err: unknown) => { if (!cancelled) { setRawFile(null); setRawError(err instanceof Error ? err.message : String(err)) } })
        .finally(() => { if (!cancelled) setRawLoading(false) })
    } else if (view.kind === "log") {
      setLogLoading(true)
      setLogError(null)
      getKcLog()
        .then(ls => { if (!cancelled) { setLog(ls); setLogError(null) } })
        .catch((err: unknown) => { if (!cancelled) setLogError(err instanceof Error ? err.message : String(err)) })
        .finally(() => { if (!cancelled) setLogLoading(false) })
    }
    return () => { cancelled = true }
  }, [view, wikiEpoch])

  /** 主场渲染一页（唯一设页态通道：[[链接]]/卡引用/药丸点击/树点选/检索命中皆经此）。 */
  const goPage = useCallback((id: string, anchor?: string) => {
    setView({ kind: "page", id, anchor })
    setCite(null) // 药丸即点即消（含手动打开被引页；显式导航同样清残留丸）
  }, [])

  // 页目标解析走单源件（page-target：id→path→剥缀→尾段配，抽屉卡引用共用——code-review S1 防分叉）
  const openLink = useCallback((target: string) => {
    const id = resolveKcPageTarget(tree, target)
    if (id) goPage(id)
  }, [tree, goPage])

  const openPage = useCallback((id: string) => goPage(id), [goPage])

  /** 抽屉卡引用 → 药丸（标题从树现取；无命中不上丸）。首见去重由抽屉侧 cardId 保证。 */
  const handleCite = useCallback((pageId: string, cardId: string) => {
    const entries = tree?.domains.flatMap(d => d.entries) ?? []
    const title = entries.find(e => e.id === pageId)?.title ?? pageId
    setCite({ pageId, title, cardId })
  }, [tree])

  const selectedPageId = view?.kind === "page" ? view.id : null
  const selectedSpecial: KcSpecialView =
    view?.kind === "index" ? "index" : view?.kind === "log" ? "log" : view?.kind === "rawlib" ? "rawlib" : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 页头（恒定一条，不再有两套工具行/模式钮）——z-[60] 压过抽屉 overlay(z-50)，
          保证抽屉开着时引用药丸/健康件/💬钮始终可点（改版 code-review S5） */}
      <div className="relative z-[60] flex shrink-0 items-center gap-2 border-b-[1.5px] border-pop-bd bg-pop-paper px-3 py-2">
        <span className="text-[13px] font-black text-pop-ink">🐙 知识中心</span>
        <span className="rounded-full border-[1.5px] border-pop-cyan px-2 py-0.5 text-[10px] font-bold text-pop-cyan">global wiki</span>
        <button
          type="button"
          data-testid="kc-search-open"
          onClick={() => setPaletteOpen(true)}
          className="ml-2 flex h-8 w-[300px] items-center gap-2 rounded-lg border-[1.5px] border-pop-bd bg-pop-inset px-3 text-left text-xs font-bold text-pop-dim hover:bg-accent hover:text-pop-ink"
        >
          🔍 搜索或问策展人… <span className="ml-auto text-[10px] font-normal">Ctrl+K</span>
        </button>
        <div className="ml-auto flex items-center gap-2">
          {cite && (
            <button
              type="button"
              data-testid="kc-cite-pill"
              onClick={() => openPage(cite.pageId)}
              className="flex items-center gap-2 rounded-full border-[1.5px] border-pop-green bg-pop-green-soft px-3 py-1 text-[11px] font-bold text-pop-green hover:brightness-110"
              title="策展人的卡片引用了这一页——点开查看（正文永不自动跳转）"
            >
              ◉ 策展人刚动了「{cite.title}」— 点开
            </button>
          )}
          <KcHeaderHealth health={health} error={healthError} />
          <button
            type="button"
            data-testid="kc-drawer-toggle"
            onClick={() => setDrawerOpen(v => !v)}
            className={cn(
              "h-8 shrink-0 rounded-lg border-[1.5px] px-3 text-xs font-bold",
              drawerOpen
                ? "border-pop-green bg-pop-green-soft text-pop-green"
                : "border-pop-bd bg-pop-paper text-pop-dim hover:bg-accent hover:text-pop-ink",
            )}
          >
            💬 策展人{drawerOpen ? " ▸" : ""}
          </button>
        </div>
      </div>

      {/* 主场：树 + 正文（max-w 阅读线）+ 右栏三件套（页态才有） */}
      <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)]">
        <aside className="min-h-0 overflow-y-auto border-r-[1.5px] border-pop-bd bg-pop-idle p-2">
          {treeError && <div data-testid="kc-tree-error" className="p-2 text-xs text-pop-red">加载失败：{treeError}</div>}
          {!tree && !treeError && <div className="p-2 text-xs text-pop-dim">加载中…</div>}
          {tree && (
            <div data-testid="kc-tree-ready">
              <KcKnowledgeTree
                tree={tree}
                selectedPageId={selectedPageId}
                selectedView={selectedSpecial}
                onSelectPage={openPage}
                onSelectIndex={() => setView({ kind: "index" })}
                onSelectLog={() => setView({ kind: "log" })}
                onSelectRawLib={() => setView({ kind: "rawlib" })}
              />
            </div>
          )}
        </aside>

        <section className="flex min-h-0 overflow-hidden bg-pop-bg">
          <div className="min-w-0 flex-1 overflow-y-auto">
            {view === null && (
              <div className="flex items-center justify-center py-16 text-sm text-pop-dim">
                选择页面查看内容 —— 或 <kbd className="mx-1 rounded border border-pop-bd px-1">Ctrl</kbd>+<kbd className="mr-1 rounded border border-pop-bd px-1">K</kbd> 检索，💬 问策展人
              </div>
            )}
            {view?.kind === "page" && (articleLoading ? (
              <div className="flex items-center justify-center py-16 text-sm text-pop-dim">加载中…</div>
            ) : articleError ? (
              <div data-testid="kc-page-error" className="p-6 text-sm font-bold text-pop-red">页面加载失败：{articleError}</div>
            ) : article ? (
              <div className="mx-auto w-full max-w-[820px]">
                <WikiPageView
                  article={article}
                  activeAnchor={view.anchor}
                  onOpenLink={openLink}
                  onOpenRaw={pointerPath => setView({ kind: "raw", pointerPath })}
                />
              </div>
            ) : null)}
            {view?.kind === "index" && <IndexView content={tree?.index ?? null} />}
            {view?.kind === "rawlib" && (
              <RawLibView onSelectRaw={pointerPath => setView({ kind: "raw", pointerPath })} />
            )}
            {view?.kind === "raw" && (rawLoading ? (
              <div className="flex items-center justify-center py-16 text-sm text-pop-dim">加载中…</div>
            ) : rawError ? (
              <div data-testid="kc-raw-error" className="p-6 text-sm font-bold text-pop-red">raw 源加载失败：{rawError}</div>
            ) : rawFile ? (
              <div className="mx-auto w-full max-w-[820px]"><RawView source={rawFile} /></div>
            ) : null)}
            {view?.kind === "log" && (logLoading && log === null ? (
              <div className="flex items-center justify-center py-16 text-sm text-pop-dim">加载中…</div>
            ) : logError ? (
              <div data-testid="kc-log-error" className="p-6 text-sm font-bold text-pop-red">LOG 加载失败：{logError}</div>
            ) : log ? (
              <div className="mx-auto w-full max-w-[820px]"><LogTimeline lines={log} filter={logFilter} onFilter={setLogFilter} /></div>
            ) : null)}
          </div>

          {view?.kind === "page" && article && tree && (
            <div className="hidden min-h-0 overflow-y-auto xl:block">
              <WikiRail article={article} tree={tree} onOpenPage={openPage} />
            </div>
          )}
        </section>
      </div>

      <KcSearchPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        tree={tree}
        onHit={(id, anchor) => goPage(id, anchor)}
      />

      <CuratorDrawer
        tree={tree}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onCite={handleCite}
        onOpenPage={openPage}
        onOpenRaw={pointerPath => setView({ kind: "raw", pointerPath })}
        onWikiChanged={() => { void loadTree(); void loadHealth(); setWikiEpoch(v => v + 1) }}
      />
    </div>
  )
}
