"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { searchKc, type KcSearchHit, type KcTree, type KcTreeEntry } from "@/lib/knowledge/knowledge-center-api"

/**
 * Ctrl+K 检索命令条 — 票11 AC3（骨架参考 components/command-palette.tsx 先例：
 * 输入 → 分组结果 → 点选跳转；Cmdk 依赖 radix portal，jsdom 无先例，这里用同构的
 * 轻量弹层实现，开合逻辑与 useGlobalCommandPalette 同律在页面侧）。
 * 匹配面：页面名/路径（树内本地匹配）+ 锚点/全文（search API：FTS5 主检索 + LIKE 降级在服务端）。
 * 别名（front-matter aliases）当前不在 DB 索引层，别名进正文/摘要后由 FTS 覆盖——见票报告遗留项。
 */

const DEBOUNCE_MS = 300

interface KcSearchPaletteProps {
  open: boolean
  onClose: () => void
  tree: KcTree | null
  onHit: (id: string, anchor?: string) => void
}

export function KcSearchPalette({ open, onClose, tree, onHit }: KcSearchPaletteProps) {
  const [q, setQ] = useState("")
  const [hits, setHits] = useState<KcSearchHit[] | null>(null)
  const [mode, setMode] = useState<"fts" | "like">("fts")
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Esc 关闭；打开即聚焦
  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])

  const runSearch = useCallback((query: string) => {
    setSearching(true)
    setSearchError(null)
    searchKc(query)
      .then(r => { setHits(r.results); setMode(r.mode); setSearchError(null) })
      .catch((err: unknown) => { setHits(null); setSearchError(err instanceof Error ? err.message : String(err)) })
      .finally(() => setSearching(false))
  }, [])

  // 防抖走服务端全文检索（FTS5 + LIKE 降级在服务端收口）
  useEffect(() => {
    if (!open) return
    const query = q.trim()
    if (query === "") { setHits(null); setSearchError(null); return }
    const t = setTimeout(() => runSearch(query), DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [q, open, runSearch])

  const lower = q.trim().toLowerCase()
  const allEntries: KcTreeEntry[] = tree?.domains.flatMap(d => d.entries) ?? []
  const localPages = lower.length === 0 ? [] : allEntries.filter(e =>
    e.title.toLowerCase().includes(lower) ||
    e.path.toLowerCase().includes(lower) ||
    e.id.toLowerCase().includes(lower)
  ).slice(0, 8)

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-label="知识检索"
      data-testid="kc-palette"
      className="fixed inset-0 z-[70] flex items-start justify-center bg-pop-bg/80 p-8"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="mt-16 w-full max-w-2xl rounded-xl border-[1.5px] border-pop-bd bg-pop-paper shadow-xl">
        <input
          ref={inputRef}
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="检索页面名/别名/锚点/全文（FTS5）… 如: Promise 超时"
          aria-label="检索页面名与全文"
          data-testid="kc-palette-input"
          className="h-11 w-full rounded-t-xl border-b-[1.5px] border-pop-bd bg-pop-inset px-4 text-sm text-pop-ink placeholder:text-pop-dim focus:outline-none"
        />

        {searchError && (
          <div data-testid="kc-search-error" className="border-b-[1.5px] border-pop-bd px-4 py-2 text-xs font-bold text-pop-red">
            检索失败：{searchError}
          </div>
        )}

        <div className="max-h-[60vh] overflow-y-auto p-3">
          {lower.length === 0 && (
            <div className="px-2 py-6 text-center text-xs text-pop-dim">输入即检索：页面名本地匹配 + FTS5 全文（LIKE 降级在服务端）</div>
          )}

          {localPages.length > 0 && (
            <div className="mb-3">
              <div className="px-2 py-1 text-[10px] font-black uppercase tracking-wider text-pop-dim">页面名匹配</div>
              {localPages.map(e => (
                <button
                  key={`p-${e.id}`}
                  type="button"
                  data-testid="kc-palette-page"
                  onClick={() => { onHit(e.id); onClose() }}
                  className="mb-1 block w-full rounded-md bg-pop-inset px-2 py-1.5 text-left hover:bg-accent"
                >
                  <span className="text-xs font-bold text-pop-ink">{e.title}</span>
                  <span className="ml-2 text-[10px] text-pop-dim">{e.path}</span>
                </button>
              ))}
            </div>
          )}

          {hits !== null && (
            <div data-testid="kc-search-results">
              <div className="px-2 py-1 text-[10px] font-black uppercase tracking-wider text-pop-dim">
                全文命中 {hits.length} 条 · {mode === "fts" ? "FTS5 全文" : "LIKE 降级匹配"}
              </div>
              {hits.map(hit => (
                <button
                  key={`h-${hit.id}-${hit.snippet}`}
                  type="button"
                  data-testid="kc-search-hit"
                  onClick={() => { onHit(hit.id, hit.anchors[0]); onClose() }}
                  className="mb-1 block w-full rounded-md bg-pop-inset px-2 py-1.5 text-left hover:bg-accent"
                >
                  <span className="text-xs font-bold text-pop-ink">{hit.title}</span>
                  <span className="ml-2 text-[10px] text-pop-dim">{hit.domain}</span>
                  <div className="mt-0.5 text-[11px] text-pop-dim">
                    {hit.snippet}
                    {hit.anchors.map(a => (
                      <span key={a} data-anchor-hit={a} className="ml-2 rounded bg-pop-pink-soft px-1 font-mono text-[10px] text-pop-pink">{a}</span>
                    ))}
                  </div>
                </button>
              ))}
              {hits.length === 0 && !searching && (
                <div className="px-2 py-4 text-center text-xs text-pop-dim">无命中（{mode === "fts" ? "FTS5" : "LIKE 降级后"} 都没有）</div>
              )}
            </div>
          )}
          {searching && hits === null && !searchError && (
            <div className="px-2 py-4 text-center text-xs text-pop-dim">检索中…</div>
          )}
        </div>
      </div>
    </div>
  )
}
