"use client"

import { useEffect, useState } from "react"
import { listKcRawSources, type KcRawSource } from "@/lib/knowledge/knowledge-center-api"

/**
 * 原料库视图 — 知识中心改版（ADR-0033）：raw 不可变层的盘点大门，
 * GET /api/knowledge/raw（S2 契约测试钉形端点）的首个 importer。
 * 平铺清单（路径/标题/来源/日期/字节/hash）+ 现打过滤；点行 → 正文区 RawView
 * （拍板 Q6：第一版不打断式浮层）。编译态标注（孤 raw/失败）随反链倒排第二波。
 * 只读纪律：raw=source of truth，零编辑入口；取数失败显形不伪造空态。
 */
const originGlyph = (origin: string | null): string =>
  origin?.startsWith("url") ? "🌐" : origin?.startsWith("file") ? "📁" : "📥"

export function RawLibView({ onSelectRaw }: { onSelectRaw: (pointerPath: string) => void }) {
  const [rows, setRows] = useState<KcRawSource[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState("")

  useEffect(() => {
    let alive = true
    listKcRawSources()
      .then(r => { if (alive) setRows(r) })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)) })
    return () => { alive = false }
  }, [])

  const filtered = (rows ?? []).filter(r =>
    !q || (r.path + (r.title ?? "") + (r.origin ?? "")).toLowerCase().includes(q.toLowerCase()),
  )

  return (
    <div data-testid="kc-raw-lib" className="mx-auto w-full max-w-[820px] p-6">
      <h1 className="mb-1 text-lg font-black text-pop-ink">📥 原料库 · raw <span className="ml-1 align-middle rounded-full bg-pop-idle px-2 py-0.5 text-[11px] font-bold text-pop-dim">{rows ? `${rows.length} 个文件` : "…"}</span></h1>
      <p className="mb-3 text-[11px] font-bold text-pop-dim">不可变层 · 红线2：编译永不改写 raw（落盘即 hash 冻结）——此处盘点，触达页的引用链照旧走页内 sources chips</p>
      {err ? (
        <div data-testid="kc-raw-lib-error" className="text-sm font-bold text-pop-red">原料库加载失败：{err}</div>
      ) : (
        <>
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="过滤 路径 / 标题 / 来源…"
            className="mb-2 h-8 w-full rounded-lg border-[1.5px] border-pop-bd bg-pop-inset px-3 text-xs text-pop-ink outline-none focus:border-pop-pink"
          />
          <div className="overflow-hidden rounded-lg border-[1.5px] border-pop-bd">
            {filtered.map(r => (
              <button
                key={r.path}
                type="button"
                data-testid="kc-raw-row"
                onClick={() => onSelectRaw(r.path)}
                className="flex w-full items-center gap-3 border-b-[1px] border-pop-bd bg-pop-paper px-3 py-2 text-left text-xs hover:bg-accent last:border-b-0"
              >
                <span>{originGlyph(r.origin)}</span>
                <span className="w-[180px] shrink-0 truncate font-bold text-pop-ink">{r.title ?? r.path.split("/").pop()}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-pop-dim">{r.path}</span>
                <span className="shrink-0 text-[10px] text-pop-dim">{(r.ingestedAt ?? "").slice(0, 10) || "—"}</span>
                <span className="w-[64px] shrink-0 text-right text-[10px] text-pop-dim">{r.bytes < 1024 ? `${r.bytes}B` : `${(r.bytes / 1024).toFixed(1)}K`}</span>
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="px-3 py-4 text-xs text-pop-dim">{rows === null ? "加载中…" : "无匹配（raw 层为空或关键词过滤）"}</div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
