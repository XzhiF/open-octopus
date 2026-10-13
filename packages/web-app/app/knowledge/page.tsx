"use client"

import { useCallback, useEffect, useState } from "react"
import {
  getKcArticle,
  getKcHealth,
  getKcPreference,
  getKcRawFile,
  getKcTree,
  type KcArticle,
  type KcHealth,
  type KcPreference,
  type KcRawSource,
  type KcTree,
} from "@/lib/knowledge/knowledge-center-api"
import { HealthBar } from "@/components/knowledge-center/health-bar"
import { KcKnowledgeTree } from "@/components/knowledge-center/knowledge-tree"
import { WikiPageView } from "@/components/knowledge-center/wiki-page-view"
import { RawView } from "@/components/knowledge-center/raw-view"
import { PreferenceView } from "@/components/knowledge-center/preference-view"
import { cn } from "@/lib/utils"

/**
 * /knowledge — 知识中心（票11 读面；spec §知识中心 UI / 原型 Tab④）。
 * 布局：左对话列（票12 实装，本票=占位抽屉）+ 右栏 wiki 视图（本票=浏览模式全宽可用）
 * + 顶部健康条（无「待审核」）+ Ctrl+K 检索命令条。
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

  useEffect(() => {
    let cancelled = false
    getKcTree()
      .then(t => { if (!cancelled) { setTree(t); setTreeError(null) } })
      .catch((err: unknown) => { if (!cancelled) setTreeError(err instanceof Error ? err.message : String(err)) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    getKcHealth()
      .then(h => { if (!cancelled) { setHealth(h); setHealthError(null) } })
      .catch((err: unknown) => { if (!cancelled) setHealthError(err instanceof Error ? err.message : String(err)) })
    return () => { cancelled = true }
  }, [])

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
    }
    return () => { cancelled = true }
  }, [view])

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

      {/* 工具行（原型 Tab④ 浏览模式 kbar）：检索命令条入口 + 对话抽屉开关 */}
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
          onClick={() => setChatOpen(v => !v)}
          className="h-8 shrink-0 rounded-lg border-[1.5px] border-pop-bd bg-pop-paper px-3 text-xs font-bold text-pop-dim hover:bg-accent hover:text-pop-ink"
        >
          对话抽屉 {chatOpen ? "▶" : "◀"}
        </button>
      </div>

      {/* 浏览区：对话列（票12 实装）可展开；右栏 = 树 + 视图（本票浏览模式全宽可用） */}
      <div className={cn("grid min-h-0 flex-1", chatOpen ? "grid-cols-[320px_240px_1fr]" : "grid-cols-[240px_1fr]")}>
        {chatOpen && (
          <aside data-testid="kc-chat-placeholder" className="min-h-0 overflow-y-auto border-r-[1.5px] border-pop-bd bg-pop-idle p-3">
            <div className="text-xs font-black text-pop-dim">与策展人的对话</div>
            <div className="mt-2 text-[11px] text-pop-dim">
              对话列（archive 分身会话通道复用）属票12 实装；本票为占位。
            </div>
          </aside>
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
          {view?.kind === "log" && (
            <div className="flex items-center justify-center py-16 text-sm text-pop-dim">LOG 时间线（W5）</div>
          )}
        </section>
      </div>

      {paletteOpen && (
        <div role="dialog" aria-label="知识检索" data-testid="kc-palette" className="fixed inset-0 z-50 flex items-start justify-center bg-pop-bg/80 p-8">
          <div className="mt-16 w-full max-w-2xl rounded-xl border-[1.5px] border-pop-bd bg-pop-paper p-3">
            <div className="text-xs text-pop-dim">检索（FTS5 全文 + 页面名匹配）—— W4 实装</div>
          </div>
        </div>
      )}
    </div>
  )
}
