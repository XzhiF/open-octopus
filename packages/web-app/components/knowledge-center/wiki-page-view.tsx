"use client"

import { useEffect, useRef, useState } from "react"
import { MarkdownPreview } from "@/components/resource/MarkdownPreview"
import { cn } from "@/lib/utils"
import type { KcArticle } from "@/lib/knowledge/knowledge-center-api"

/**
 * v3 页渲染 — 票11（原型 Tab④ wmain：标题 + front-matter chips + 正文 + 页尾折叠区）。
 * MarkdownPreview 复用（sanitize 链不动）；本模块只做**呈现前变换**：
 *   - `[[target]]` / `[[target|label]]` → `[label](#kc:target)`（容器 onClick 拦截跳页；
 *     `#kc:` 片段链接走默认 sanitizer 白名单，不改 sanitizeSchema）
 *   - `<!--#oct-NNN-->` 锚点注释 → 可见 `` `#oct-NNN` `` 标记（原型 .rule .rid「#oct-008」同形）
 * 页尾折叠区：sources 溯源 / git 近史（原型行 554）。
 */

export function kcTransformBody(body: string): string {
  return body
    .replace(/<!--#([A-Za-z0-9_-]+)-->/g, " `$#$1`")
    .replace(/\[\[([^\]|#]+)\|([^\]#]+)\]\]/g, "[$2](#kc:$1)")
    .replace(/\[\[([^\]|#]+)\]\]/g, "[$1](#kc:$1)")
}

interface WikiPageViewProps {
  article: KcArticle
  /** 检索命中跳转的规则锚点（定位高亮用；无则 undefined）。 */
  activeAnchor?: string
  onOpenLink: (target: string) => void
  onOpenRaw: (pointerPath: string) => void
}

export function WikiPageView({ article, activeAnchor, onOpenLink, onOpenRaw }: WikiPageViewProps) {
  const [historyOpen, setHistoryOpen] = useState(false)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  // 锚点定位：把命中的规则行滚进视野并描黄（尽力而为；jsdom 无 scrollIntoView 时静默跳过）
  useEffect(() => {
    if (!activeAnchor) return
    const el = bodyRef.current?.querySelector(`[data-anchor-hit="${activeAnchor}"]`)
    if (!el) return
    el.classList.add("bg-pop-yellow", "text-pop-bg")
    if (typeof el.scrollIntoView === "function") {
      try { el.scrollIntoView({ block: "center" }) } catch { /* jsdom */ }
    }
  }, [activeAnchor, article.id])

  const handleBodyClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a")
    const href = a?.getAttribute("href")
    if (href?.startsWith("#kc:")) {
      e.preventDefault()
      onOpenLink(decodeURIComponent(href.slice(4)))
    }
  }

  const type = article.page?.type ?? article.domain
  const anchorLine = activeAnchor
    ? article.body.split(/\r?\n/).find(l => l.includes(`<!--#${activeAnchor}-->`))
    : undefined

  return (
    <div className="p-6">
      <h1 data-testid="kc-page-title" className="mb-2 text-2xl font-black text-pop-ink">{article.title}</h1>

      {/* front-matter chips（原型行 550：type / aliases / 编译于 / confidence + sources） */}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] font-bold">
        <span data-testid="kc-chip-type" className="rounded-full border-[1.5px] border-pop-cyan px-2 py-0.5 text-pop-cyan">{type}</span>
        {article.page?.entityKind && (
          <span className="rounded-full bg-pop-idle px-2 py-0.5 text-pop-dim">{article.page.entityKind}</span>
        )}
        <span data-testid="kc-chip-aliases" className="contents">
          {(article.page?.aliases ?? []).map(a => (
            <span key={a} className="rounded-full bg-pop-idle px-2 py-0.5 text-pop-dim">aliases: {a}</span>
          ))}
        </span>
        <span className={cn("rounded-full px-2 py-0.5",
          article.stability === "stable" ? "bg-pop-green-soft text-pop-green" : "bg-pop-amber-soft text-pop-amber")}>
          {article.stability}
        </span>
        <span className="rounded-full bg-pop-cyan-soft px-2 py-0.5 text-pop-cyan">confidence {article.confidence}</span>
        <span className="rounded-full bg-pop-idle px-2 py-0.5 text-pop-dim">编译于 {article.lastCompiled}</span>
      </div>

      {/* links chips（front-matter links = [[链接]] 集，可点跳页） */}
      {(article.page?.links.length ?? 0) > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-[11px] font-bold">
          <span className="text-[10px] font-black uppercase tracking-wider text-pop-dim">links</span>
          {(article.page?.links ?? []).map(l => (
            <button
              key={l}
              type="button"
              data-testid="kc-link-chip"
              title={`跳转 ${l}`}
              onClick={() => onOpenLink(l)}
              className="rounded-full border-[1.5px] border-pop-pink px-2 py-0.5 text-pop-pink hover:bg-pop-pink-soft"
            >
              {l}
            </button>
          ))}
        </div>
      )}

      {/* sources chips：raw 指针可点开不可变源只读视图；非 raw 形态只展示 */}
      {article.sources.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-[11px] font-bold">
          <span className="text-[10px] font-black uppercase tracking-wider text-pop-dim">sources</span>
          {article.sources.map(s => (
            s.startsWith("raw/") ? (
              <button
                key={s}
                type="button"
                data-testid="kc-source-chip"
                title="查看不可变 raw 源"
                onClick={() => onOpenRaw(s)}
                className="max-w-[280px] truncate rounded-full border-[1.5px] border-pop-green px-2 py-0.5 font-mono text-[10px] text-pop-green hover:bg-pop-green-soft"
              >
                {s}
              </button>
            ) : (
              <span key={s} className="max-w-[280px] truncate rounded-full bg-pop-inset px-2 py-0.5 font-mono text-[10px] text-pop-dim">{s}</span>
            )
          ))}
        </div>
      )}

      {/* 锚点定位条（检索命中带锚点进入时显形） */}
      {activeAnchor && (
        <div data-testid="kc-anchor-focus" data-anchor-hit={activeAnchor} className="mb-4 rounded-md border-[1.5px] border-pop-yellow bg-pop-paper px-3 py-2 text-xs font-bold text-pop-ink">
          ⚓ 锚点 #{activeAnchor}
          {anchorLine && <div data-anchor-hit={activeAnchor} className="mt-1 font-mono text-[11px] font-normal text-pop-dim">{anchorLine.replace(/<!--#[A-Za-z0-9_-]+-->/, "").trim()}</div>}
        </div>
      )}

      <div ref={bodyRef} onClick={handleBodyClick}>
        <MarkdownPreview content={kcTransformBody(article.body)} />
      </div>

      {/* 页尾折叠区：git 近史 / sources 溯源（原型行 554「收进页尾折叠区」） */}
      <div className="mt-6 border-t-[1.5px] border-pop-bd pt-3">
        <button
          type="button"
          data-testid="kc-git-history-toggle"
          onClick={() => setHistoryOpen(v => !v)}
          className="mb-1 text-[10px] font-black uppercase tracking-wider text-pop-dim hover:text-pop-ink"
        >
          {historyOpen ? "▾" : "▸"} Git 近史（{article.gitHistory.length}）
        </button>
        {historyOpen && (
          <ul data-testid="kc-git-history" className="mb-3 space-y-1">
            {article.gitHistory.map(g => (
              <li key={g.hash} className="rounded-md bg-pop-inset px-2 py-1 text-xs">
                <span className="font-mono text-[10px] text-pop-cyan">{g.hash}</span>{" "}
                <span className="text-[10px] text-pop-dim">{g.date}</span>
                <div className="break-all text-[11px] text-pop-ink">{g.message}</div>
              </li>
            ))}
            {article.gitHistory.length === 0 && <li className="text-[11px] text-pop-dim">—（非 git 仓或无提交记录）</li>}
          </ul>
        )}
        <button
          type="button"
          data-testid="kc-sources-toggle"
          onClick={() => setSourcesOpen(v => !v)}
          className="mb-1 text-[10px] font-black uppercase tracking-wider text-pop-dim hover:text-pop-ink"
        >
          {sourcesOpen ? "▾" : "▸"} Sources 溯源（{article.sources.length}）
        </button>
        {sourcesOpen && (
          <ul data-testid="kc-sources-list" className="space-y-1">
            {article.sources.map(s => (
              <li key={s} className="break-all rounded-md bg-pop-inset px-2 py-1 font-mono text-[10px] text-pop-ink">{s}</li>
            ))}
            {article.sources.length === 0 && <li className="text-[11px] text-pop-dim">—</li>}
          </ul>
        )}
      </div>
    </div>
  )
}
