"use client"

import { useCallback, useEffect, useState } from "react"
import {
  getKcArticle,
  getKcHealth,
  getKcLog,
  getKcPreference,
  getKcRawFile,
  getKcTree,
  type KcArticle,
  type KcHealth,
  type KcLogLine,
  type KcPreference,
  type KcRawSource,
  type KcTree,
} from "@/lib/knowledge/knowledge-center-api"
import { HealthBar } from "@/components/knowledge-center/health-bar"
import { KcKnowledgeTree } from "@/components/knowledge-center/knowledge-tree"
import { WikiPageView } from "@/components/knowledge-center/wiki-page-view"
import { RawView } from "@/components/knowledge-center/raw-view"
import { PreferenceView } from "@/components/knowledge-center/preference-view"
import { KcSearchPalette } from "@/components/knowledge-center/search-palette"
import { LogTimeline, type KcLogFilter } from "@/components/knowledge-center/log-timeline"
import { ChatColumn } from "@/components/knowledge-center/chat-column"
import { cn } from "@/lib/utils"

/**
 * /knowledge — 知识中心（票11 读面 + 票12 对话即管理；spec §知识中心 UI / 原型 Tab④）。
 * 布局：左对话列（票12：archive 分身会话通道复用 + 卡片协议 + 投喂/回滚）+
 * 右栏 wiki 视图（跟随对话渲染/钉住/浏览模式全宽）+ 顶部健康条（无「待审核」）+
 * Ctrl+K 检索命令条。
 * 暗色 TUI 主题沿用 globals.css pop-* token；数据面钉 global（D6①，界面零 org 切换，故事 18）。
 * 取数失败一律显形错误条，不伪造空态（CODING_STANDARDS #2）。
 */

/** 右栏浏览区视图态：页 / LOG 时间线 / user_preference（人工文件）/ raw 源文件。 */
export type KcView =
  | { kind: "page"; id: string; anchor?: string }
  | { kind: "log" }
  | { kind: "preference" }
  | { kind: "raw"; pointerPath: string }

export default function KnowledgePage() {
  const [tree, setTree] = useState<KcTree | null>(null)
  const [treeError, setTreeError] = useState<string | null>(null)
  const [health, setHealth] = useState<KcHealth | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)

  const [paletteOpen, setPaletteOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [view, setView] = useState<KcView | null>(null)
  /** 右栏钉住态（票12 AC4：钉住=停跟随，对话卡仍渲染在流里）。 */
  const [pinned, setPinned] = useState(false)
  /** 库面变更计数（票12：编译/回滚落定 ⇒ 当前视图重取，卡/栏/盘同步） */
  const [wikiEpoch, setWikiEpoch] = useState(0)

  // 视图数据（各态独立 loading/error；失败保留旧值+显形错误位由渲染层二选一）
  const [article, setArticle] = useState<KcArticle | null>(null)
  const [articleLoading, setArticleLoading] = useState(false)
  const [articleError, setArticleError] = useState<string | null>(null)
  const [pref, setPref] = useState<KcPreference | null>(null)
  const [prefLoading, setPrefLoading] = useState(false)
  const [prefError, setPrefError] = useState<string | null>(null)
  const [rawFile, setRawFile] = useState<(KcRawSource & { content: string }) | null>(null)
  const [rawLoading, setRawLoading] = useState(false)
  const [rawError, setRawError] = useState<string | null>(null)
  const [log, setLog] = useState<KcLogLine[] | null>(null)
  const [logLoading, setLogLoading] = useState(false)
  const [logError, setLogError] = useState<string | null>(null)
  const [logFilter, setLogFilter] = useState<KcLogFilter>("all")

  // 树/健康条取数（票12：编译/回滚落定后 onWikiChanged 重取——卡片态与库面同步）
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

  // 视图态 ⇒ 取数（page/raw/preference 各一路；log 属 W5 数据源）
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
    } else if (view.kind === "preference") {
      setPrefLoading(true)
      setPrefError(null)
      getKcPreference()
        .then(p => { if (!cancelled) { setPref(p); setPrefError(null) } })
        .catch((err: unknown) => { if (!cancelled) setPrefError(err instanceof Error ? err.message : String(err)) })
        .finally(() => { if (!cancelled) setPrefLoading(false) })
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

  /** [[链接]] 目标解析：id 直配 → path 直配 → path 去 .md 配；配不上=断链不跳（渲染层已显形）。 */
  const resolveLink = useCallback((target: string): string | null => {
    const entries = tree?.domains.flatMap(d => d.entries) ?? []
    const hit =
      entries.find(e => e.id === target) ??
      entries.find(e => e.path === target || e.path === `${target}.md` || e.path.endsWith(`/${target}`) || e.path.endsWith(`/${target}.md`))
    return hit?.id ?? null
  }, [tree])

  const openLink = useCallback((target: string) => {
    const id = resolveLink(target)
    if (id) setView({ kind: "page", id })
  }, [resolveLink])

  const selectedPageId = view?.kind === "page" ? view.id : null
  const selectedSpecial = view?.kind === "log" ? "log" : view?.kind === "preference" ? "preference" : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <HealthBar health={health} error={healthError} />

      {/* 工具行（原型 Tab④ 浏览模式 kbar）：检索命令条入口 + 右栏钉住 + 对话抽屉开关 */}
      <div className="flex items-center gap-2 border-b-[1.5px] border-pop-bd bg-pop-bg px-4 py-2">
        <button
          type="button"
          data-testid="kc-search-open"
          onClick={() => setPaletteOpen(true)}
          className="flex h-8 flex-1 items-center gap-2 rounded-lg border-[1.5px] border-pop-bd bg-pop-inset px-3 text-left text-xs font-bold text-pop-dim hover:bg-accent hover:text-pop-ink"
        >
          🔍 检索命令条（Ctrl+K）：页名/别名/锚点/全文 FTS5…
        </button>
        <button
          type="button"
          data-testid="kc-pin-toggle"
          onClick={() => setPinned(v => !v)}
          className={cn(
            "h-8 shrink-0 rounded-lg border-[1.5px] border-pop-bd px-3 text-xs font-bold",
            pinned ? "bg-pop-amber text-pop-bg" : "bg-pop-paper text-pop-dim hover:bg-accent hover:text-pop-ink",
          )}
        >
          右栏 {pinned ? "📌 已钉住（停跟随）" : "跟随对话"}
        </button>
        <button
          type="button"
          onClick={() => setChatOpen(v => !v)}
          className="h-8 shrink-0 rounded-lg border-[1.5px] border-pop-bd bg-pop-paper px-3 text-xs font-bold text-pop-dim hover:bg-accent hover:text-pop-ink"
        >
          {chatOpen ? "浏览模式" : "对话模式"}（对话抽屉 {chatOpen ? "▶" : "◀"}）
        </button>
      </div>

      {/* 对话模式：左对话列（票12 实装，clone-session 通道复用）| 树 | 右栏跟随；
          浏览模式（抽屉收起）：树 + 视图全宽（票11 形态） */}
      <div className={cn("grid min-h-0 flex-1", chatOpen ? "grid-cols-[3fr_240px_2fr]" : "grid-cols-[240px_1fr]")}>
        {chatOpen && (
          <ChatColumn
            tree={tree}
            pinned={pinned}
            onOpenPage={id => setView({ kind: "page", id })}
            onOpenFullPage={id => { setChatOpen(false); setView({ kind: "page", id }) }}
            onOpenRaw={pointerPath => setView({ kind: "raw", pointerPath })}
            onWikiChanged={() => { void loadTree(); void loadHealth(); setWikiEpoch(v => v + 1) }}
          />
        )}

        <aside className="min-h-0 overflow-y-auto border-r-[1.5px] border-pop-bd bg-pop-idle p-2">
          {treeError && <div data-testid="kc-tree-error" className="p-2 text-xs text-pop-red">加载失败：{treeError}</div>}
          {!tree && !treeError && <div className="p-2 text-xs text-pop-dim">加载中…</div>}
          {tree && (
            <div data-testid="kc-tree-ready">
              <KcKnowledgeTree
                tree={tree}
                selectedPageId={selectedPageId}
                selectedView={selectedSpecial}
                onSelectPage={id => setView({ kind: "page", id })}
                onSelectPreference={() => setView({ kind: "preference" })}
                onSelectLog={() => setView({ kind: "log" })}
              />
            </div>
          )}
        </aside>

        <section className="min-h-0 overflow-y-auto bg-pop-bg">
          {view === null && (
            <div className="flex items-center justify-center py-16 text-sm text-pop-dim">选择页面查看内容</div>
          )}
          {view?.kind === "page" && (articleLoading ? (
            <div className="flex items-center justify-center py-16 text-sm text-pop-dim">加载中…</div>
          ) : articleError ? (
            <div data-testid="kc-page-error" className="p-6 text-sm font-bold text-pop-red">页面加载失败：{articleError}</div>
          ) : article ? (
            <WikiPageView
              article={article}
              activeAnchor={view.anchor}
              onOpenLink={openLink}
              onOpenRaw={pointerPath => setView({ kind: "raw", pointerPath })}
            />
          ) : null)}
          {view?.kind === "preference" && (prefLoading ? (
            <div className="flex items-center justify-center py-16 text-sm text-pop-dim">加载中…</div>
          ) : prefError ? (
            <div data-testid="kc-preference-error" className="p-6 text-sm font-bold text-pop-red">偏好文件加载失败：{prefError}</div>
          ) : pref ? (
            <PreferenceView content={pref.content ?? ""} />
          ) : null)}
          {view?.kind === "raw" && (rawLoading ? (
            <div className="flex items-center justify-center py-16 text-sm text-pop-dim">加载中…</div>
          ) : rawError ? (
            <div data-testid="kc-raw-error" className="p-6 text-sm font-bold text-pop-red">raw 源加载失败：{rawError}</div>
          ) : rawFile ? (
            <RawView source={rawFile} />
          ) : null)}
          {view?.kind === "log" && (logLoading && log === null ? (
            <div className="flex items-center justify-center py-16 text-sm text-pop-dim">加载中…</div>
          ) : logError ? (
            <div data-testid="kc-log-error" className="p-6 text-sm font-bold text-pop-red">LOG 加载失败：{logError}</div>
          ) : log ? (
            <LogTimeline lines={log} filter={logFilter} onFilter={setLogFilter} />
          ) : null)}
        </section>
      </div>

      <KcSearchPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        tree={tree}
        onHit={(id, anchor) => setView({ kind: "page", id, anchor })}
      />
    </div>
  )
}
