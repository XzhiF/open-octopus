"use client"

import { MarkdownPreview } from "@/components/resource/MarkdownPreview"
import type { KcRawSource } from "@/lib/knowledge/knowledge-center-api"

/**
 * raw 源只读视图 — 票11（页 sources 溯源 chip → 不可变源现形）。
 * front-matter 冻结头（origin/bytes/hash）剥出为头部字段，正文进 MarkdownPreview。
 * 只读纪律：零编辑控件（raw = source of truth，策展人亦只读，spec 质控六道②）。
 */
export function RawView({ source }: { source: KcRawSource & { content: string } }) {
  const body = source.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, "")
  return (
    <div data-testid="kc-raw-view" className="p-6">
      <h1 className="mb-2 text-lg font-black text-pop-ink">📥 不可变 raw 源（只读）</h1>
      <div className="mb-4 space-y-1 text-[11px] font-bold">
        <div className="break-all rounded-md bg-pop-inset px-2 py-1 font-mono text-pop-ink">{source.path}</div>
        <div className="flex flex-wrap gap-2">
          <span className="rounded-full bg-pop-green-soft px-2 py-0.5 text-pop-green">{source.bytes} bytes</span>
          <span className="rounded-full bg-pop-cyan-soft px-2 py-0.5 font-mono text-[10px] text-pop-cyan">hash {source.hash.slice(0, 12)}</span>
          {source.origin && <span className="max-w-[360px] truncate rounded-full bg-pop-idle px-2 py-0.5 font-mono text-[10px] text-pop-dim" title={source.origin}>{source.origin}</span>}
          {source.ingestedAt && <span className="rounded-full bg-pop-idle px-2 py-0.5 text-pop-dim">ingest {source.ingestedAt.slice(0, 10)}</span>}
        </div>
        {source.title && <div className="text-pop-dim">标题：{source.title}</div>}
      </div>
      <MarkdownPreview content={body} />
    </div>
  )
}
