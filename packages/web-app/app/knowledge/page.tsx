"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  getKcArticle,
  getKcFs,
  getKcFsFile,
  getKcHealth,
  getKcLog,
  getKcRawFile,
  getKcTree,
  type FsNode,
  type KcArticle,
  type KcHealth,
  type KcLogLine,
  type KcRawSource,
  type KcTree,
} from "@/lib/knowledge/knowledge-center-api"
import { KcHeaderHealth } from "@/components/knowledge-center/kc-header-health"
import { KcKnowledgeTree } from "@/components/knowledge-center/knowledge-tree"
import { WikiPageView } from "@/components/knowledge-center/wiki-page-view"
import { WikiRail } from "@/components/knowledge-center/wiki-rail"
import { RawView } from "@/components/knowledge-center/raw-view"
import { RawLibView } from "@/components/knowledge-center/raw-lib-view"
import { IndexView } from "@/components/knowledge-center/index-view"
import { DocView } from "@/components/knowledge-center/doc-view"
import { KcSearchPalette } from "@/components/knowledge-center/search-palette"
import { LogTimeline, type KcLogFilter } from "@/components/knowledge-center/log-timeline"
import { CuratorDrawer } from "@/components/knowledge-center/curator-drawer"
import { resolveKcPageTarget } from "@/components/knowledge-center/page-target"
import { cn } from "@/lib/utils"

/**
 * /knowledge — 知识中心（知识中心改版 · ADR-0033：wiki 主场 + 策展人抽屉）。
 * 布局**恒定**：左栏 = 知识根 `.octopus/knowledge` **真实目录树**（改版 20261016：
 * GET /api/knowledge/fs 投影，INDEX.md/LOG.md/raw 三入口收进树；wiki 叶经
 * "wiki/"+entry.path 全路径精确配开页，其余 .md 走 DocView 只读；右缘把手拖宽
 * 200~560px，localStorage 记忆）+ 中正文（max-w
 * 阅读线）+ 右栏三件套（目录/反链/实效账）；策展人 = 右侧 overlay 抽屉（多会话
 * tab/历史/拖宽，开合与调宽**永不重排主场**——取代已废除的「对话模式/浏览模式」
 * 两套 grid 切换）。
 * 交互契约 v2：卡片引用页 ⇒ 页头「引用药丸」，点击才跳转；**右栏永不自动跟随**
 * （原「跟随/钉住」语义废除）。健康条瘦身页头三槽，点开弹层收全量指标 + ranked
 * findings。人工偏好视图已随概念删除（ADR-0033）。
 * 数据面钉 global（D6①，界面零 org 切换，故事 18）。暗色 TUI 主题沿用 globals.css
 * pop-* token。取数失败一律显形错误条，不伪造空态（CODING_STANDARDS #2）。
 */

/** 主场正文区视图态：页 / INDEX 总览 / LOG 时间线 / 原料库清单 / raw 单文件 / 通用 .md 只读。 */
export type KcView =
  | { kind: "page"; id: string; anchor?: string }
  | { kind: "index" }
  | { kind: "log" }
  | { kind: "rawlib" }
  | { kind: "raw"; pointerPath: string }
  | { kind: "doc"; path: string }

/** 引用药丸态（卡引用页 → 页头亮丸，点击才渲染；永不自动跳转=负断言对象）。 */
interface KcCite { pageId: string; title: string; cardId: string }

/** 左树调宽（抽屉拖宽同制式：随拖随存 localStorage，纯视图态）。 */
const TREE_W_KEY = "***"
const TREE_W_DEFAULT = 260
const TREE_W_MIN = 200
const TREE_W_MAX = 560

export default function KnowledgePage() {
  const [tree, setTree] = useState<KcTree | null>(null)
  const [treeError, setTreeError] = useState<string | null>(null)
  /** 知识根真实目录树（左栏数据面；缺席/失败显形，不伪造空树） */
  const [fs, setFs] = useState<FsNode[] | null>(null)
  const [fsError, setFsError] = useState<string | null>(null)
  const [health, setHealth] = useState<KcHealth | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)

  const [paletteOpen, setPaletteOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [cite, setCite] = useState<KcCite | null>(null)
  /** 库面变更计数（编译/回滚落定 ⇒ 当前视图重取，卡/栏/盘同步——票12 同律） */
  const [wikiEpoch, setWikiEpoch] = useState(0)

  // ── 主场阅读史栈（页头 ←→ + 浏览器前进/后退共用同一栈）：[[链接]]/卡/药丸/树点选
  //  每次跳转 push 一条 (KcView|null) 并进浏览器历史；**popstate 是唯一回退提交点**
  //  （页头箭头只是 history.go(±1) 的代理，杜绝 React 态与浏览器历史双态漂移）。
  //  栈含 null 初始态 ⇒ 能一路退回「选择页面查看内容」空态。──
  const histRef = useRef<{ stack: (KcView | null)[]; idx: number }>({ stack: [null], idx: 0 })
  const [hist, setHist] = useState(histRef.current)
  const navTo = useCallback((v: KcView | null) => {
    const h = histRef.current
    const stack = [...h.stack.slice(0, h.idx + 1), v]
    const next = { stack, idx: stack.length - 1 }
    histRef.current = next
    setHist(next)
    window.history.pushState({ ...window.history.state, kcNav: next.idx }, "")
  }, [])
  useEffect(() => {
    window.history.replaceState({ ...window.history.state, kcNav: 0 }, "")
    const onPop = (e: PopStateEvent) => {
      const s = e.state as { kcNav?: number } | null
      if (typeof s?.kcNav !== "number") return // 非本域历史条目（离开 /knowledge 由路由接管）
      const h = histRef.current
      if (s.kcNav < 0 || s.kcNav >= h.stack.length) return // 刷新后栈已复位：不伪造
      const next = { stack: h.stack, idx: s.kcNav }
      histRef.current = next
      setHist(next)
    }
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])
  const view = hist.stack[hist.idx] ?? null
  const canBack = hist.idx > 0
  const canFwd = hist.idx < hist.stack.length - 1

  // ── 左树宽（CuratorDrawer 拖宽同制式：随拖随存，纯视图态）。
  //  记忆走挂载后 effect 回填，不在 useState init 读——SSR 恒渲默认宽，
  //  init 里读 localStorage 会造成 hydration style 不匹配且不回填（e2e 抓到刷新回弹）──
  const [treeW, setTreeW] = useState(TREE_W_DEFAULT)
  useEffect(() => {
    try {
      const n = Number(window.localStorage.getItem(TREE_W_KEY))
      if (Number.isFinite(n) && n >= TREE_W_MIN && n <= TREE_W_MAX) setTreeW(n)
    } catch { /* 无痕静默：用默认宽 */ }
  }, [])
  const treeDragRef = useRef<{ x: number; w: number } | null>(null)
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = treeDragRef.current
      if (!d) return
      const max = Math.min(TREE_W_MAX, Math.round(window.innerWidth * 0.45))
      const next = Math.max(TREE_W_MIN, Math.min(max, d.w + (e.clientX - d.x)))
      setTreeW(next)
      try { window.localStorage.setItem(TREE_W_KEY, String(next)) } catch { /* 无痕/配额静默 */ }
    }
    const up = () => { treeDragRef.current = null }
    window.addEventListener("mousemove", move)
    window.addEventListener("mouseup", up)
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up) }
  }, [])

  // 视图数据（各态独立 loading/error；失败保留旧值+显形错误位由渲染层二选一）
  const [article, setArticle] = useState<KcArticle | null>(null)
  const [articleLoading, setArticleLoading] = useState(false)
  const [articleError, setArticleError] = useState<string | null>(null)
  const [rawFile, setRawFile] = useState<(KcRawSource & { content: string }) | null>(null)
  const [rawLoading, setRawLoading] = useState(false)
  const [rawError, setRawError] = useState<string | null>(null)
  const [docFile, setDocFile] = useState<{ path: string; content: string; bytes: number } | null>(null)
  const [docLoading, setDocLoading] = useState(false)
  const [docError, setDocError] = useState<string | null>(null)
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
  const loadFs = useCallback(async () => {
    try {
      const f = await getKcFs()
      setFs(f.tree)
      setFsError(null)
    } catch (err: unknown) {
      setFsError(err instanceof Error ? err.message : String(err))
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

  useEffect(() => { void loadTree(); void loadFs() }, [loadTree, loadFs])
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
    } else if (view.kind === "doc") {
      setDocLoading(true)
      setDocError(null)
      getKcFsFile(view.path)
        .then(d => { if (!cancelled) { setDocFile(d); setDocError(null) } })
        .catch((err: unknown) => { if (!cancelled) { setDocFile(null); setDocError(err instanceof Error ? err.message : String(err)) } })
        .finally(() => { if (!cancelled) setDocLoading(false) })
    }
    return () => { cancelled = true }
  }, [view, wikiEpoch])

  /** 主场渲染一页（唯一设页态通道：[[链接]]/卡引用/药丸点击/树点选/检索命中皆经此）。 */
  const goPage = useCallback((id: string, anchor?: string) => {
    navTo({ kind: "page", id, anchor })
    setCite(null) // 药丸即点即消（含手动打开被引页；显式导航同样清残留丸）
  }, [navTo])

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

  /** 史栈条目标签（←/→ tooltip：给「返回将去哪」的确定性预告） */
  const viewLabel = useCallback((v: KcView | null): string => {
    if (!v) return "空态"
    if (v.kind === "page") return tree?.domains.flatMap(d => d.entries).find(e => e.id === v.id)?.title ?? v.id
    if (v.kind === "raw") return v.pointerPath
    if (v.kind === "doc") return v.path
    return v.kind === "index" ? "INDEX 总览" : v.kind === "log" ? "LOG 时间线" : "原料库"
  }, [tree])

  /** 当前视图 → 树目标节点 fs path（高亮唯一落点；page 经 entry.path 换算 wiki/ 前缀）。 */
  const selectedPath: string | null = (() => {
    if (!view) return null
    if (view.kind === "index") return "wiki/INDEX.md"
    if (view.kind === "log") return "wiki/LOG.md"
    if (view.kind === "rawlib") return "raw"
    if (view.kind === "raw") return view.pointerPath
    if (view.kind === "doc") return view.path
    const entry = tree?.domains.flatMap(d => d.entries).find(e => e.id === view.id)
    return entry ? `wiki/${entry.path}` : null
  })()

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 页头（恒定一条，不再有两套工具行/模式钮）。z-[60] 保留：其下弹出的
          健康件/药丸浮层压过主场与抽屉；抽屉本体已改锚定在主场上（absolute，
          顶边=页头下沿），与页头结构上不再重叠（bug-fix 20261016） */}
      <div data-testid="kc-page-header" className="relative z-[60] flex shrink-0 items-center gap-2 border-b-[1.5px] border-pop-bd bg-pop-paper px-3 py-2">
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
        {/* 阅读史导航（浏览器同款语义，贴搜索框右手边）：←/→ 即 history.go(±1)，
            与浏览器前进/后退共栈；到头/到尾置灰，tooltip 预告去向 */}
        <button
          type="button"
          data-testid="kc-nav-back"
          aria-label="后退"
          disabled={!canBack}
          onClick={() => window.history.go(-1)}
          title={canBack ? `后退：${viewLabel(hist.stack[hist.idx - 1])}` : "没有可后退的页面"}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border-[1.5px] border-pop-bd text-[13px] font-black text-pop-dim transition-colors enabled:hover:bg-accent enabled:hover:text-pop-ink disabled:cursor-default disabled:opacity-35"
        >
          ←
        </button>
        <button
          type="button"
          data-testid="kc-nav-forward"
          aria-label="前进"
          disabled={!canFwd}
          onClick={() => window.history.go(1)}
          title={canFwd ? `前进：${viewLabel(hist.stack[hist.idx + 1])}` : "没有可前进的页面"}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border-[1.5px] border-pop-bd text-[13px] font-black text-pop-dim transition-colors enabled:hover:bg-accent enabled:hover:text-pop-ink disabled:cursor-default disabled:opacity-35"
        >
          →
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

      {/* 主场：树 + 正文（max-w 阅读线）+ 右栏三件套（页态才有）。
          relative+overflow-hidden = 策展人抽屉的锚定框：抽屉 absolute 于此，
          顶边天然落在页头下沿，收起时平移出界被裁掉（不产生横向滚动条） */}
      <div className="relative grid min-h-0 flex-1 overflow-hidden" style={{ gridTemplateColumns: `${treeW}px minmax(0,1fr)` }}>
        <aside data-testid="kc-tree-pane" className="min-h-0 overflow-y-auto border-r-[1.5px] border-pop-bd bg-pop-idle p-2">
          {fsError && <div data-testid="kc-fs-error" className="p-2 text-xs text-pop-red">目录树加载失败：{fsError}</div>}
          {treeError && <div data-testid="kc-tree-error" className="p-2 text-xs text-pop-red">页元数据加载失败：{treeError}（wiki 页将以原文视图打开）</div>}
          {!fs && !fsError && <div className="p-2 text-xs text-pop-dim">加载中…</div>}
          {fs && (
            <div data-testid="kc-tree-ready">
              <KcKnowledgeTree
                fs={fs}
                tree={tree}
                selectedPath={selectedPath}
                onSelectPage={openPage}
                onSelectIndex={() => navTo({ kind: "index" })}
                onSelectLog={() => navTo({ kind: "log" })}
                onSelectRawLib={() => navTo({ kind: "rawlib" })}
                onOpenRaw={pointerPath => navTo({ kind: "raw", pointerPath })}
                onOpenDoc={path => navTo({ kind: "doc", path })}
              />
            </div>
          )}
        </aside>

        {/* 左树调宽把手（骑在分界线上，抽屉把手同款） */}
        <div
          data-testid="kc-tree-resize"
          title="拖动调宽"
          onMouseDown={e => { treeDragRef.current = { x: e.clientX, w: treeW }; e.preventDefault() }}
          className="absolute bottom-0 top-0 z-10 w-[7px] -translate-x-1/2 cursor-ew-resize hover:bg-pop-pink/40"
          style={{ left: treeW }}
        />

        <section data-testid="kc-stage" className="flex min-h-0 overflow-hidden bg-pop-bg">
          <div className="min-w-0 flex-1 overflow-y-auto">
            {view === null && (
              <div data-testid="kc-empty-state" className="flex items-center justify-center py-16 text-sm text-pop-dim">
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
                  onOpenRaw={pointerPath => navTo({ kind: "raw", pointerPath })}
                />
              </div>
            ) : null)}
            {view?.kind === "index" && <IndexView content={tree?.index ?? null} />}
            {view?.kind === "rawlib" && (
              <RawLibView onSelectRaw={pointerPath => navTo({ kind: "raw", pointerPath })} />
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
            {view?.kind === "doc" && (docLoading ? (
              <div className="flex items-center justify-center py-16 text-sm text-pop-dim">加载中…</div>
            ) : docError ? (
              <div data-testid="kc-doc-error" className="p-6 text-sm font-bold text-pop-red">文件加载失败：{docError}</div>
            ) : docFile ? (
              <DocView path={docFile.path} content={docFile.content} />
            ) : null)}
          </div>

          {view?.kind === "page" && article && tree && (
            <div className="hidden min-h-0 overflow-y-auto xl:block">
              <WikiRail article={article} tree={tree} onOpenPage={openPage} />
            </div>
          )}
        </section>

        <CuratorDrawer
          tree={tree}
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          onCite={handleCite}
          onOpenPage={openPage}
          onOpenRaw={pointerPath => navTo({ kind: "raw", pointerPath })}
          onWikiChanged={() => { void loadTree(); void loadFs(); void loadHealth(); setWikiEpoch(v => v + 1) }}
        />
      </div>

      <KcSearchPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        tree={tree}
        onHit={(id, anchor) => goPage(id, anchor)}
      />
    </div>
  )
}
