"use client"

import { MarkdownPreview } from "@/components/resource/MarkdownPreview"

/**
 * 通用 .md 只读视图 — 知识中心左栏真实目录树改版（20261016）。
 * 承载 wiki 页/raw 之外的一切可读物：SCHEMA.md、drafts/**、_archive/**、
 * wiki/_retired 与未编散页（数据面 = GET /api/knowledge/fs/file?path=，
 * page.tsx 取数与 loading/error 纪律镜像 raw 三件套）。
 * 与 IndexView 同制式（纯呈现，文本由宿主喂入）；front-matter 原样呈现——
 * 不加第二套剥离解析（诚实源文，避免制造第二个 front-matter 单源）。
 */
export function DocView({ path, content }: { path: string; content: string }) {
  return (
    <div data-testid="kc-doc-view" className="mx-auto w-full max-w-[820px] p-6">
      <h1 className="mb-1 text-lg font-black text-pop-ink">📄 {path.split("/").pop()}</h1>
      <p className="mb-4 font-mono text-[11px] font-bold text-pop-dim" title="知识根相对路径（只读投影）">
        {path} · 只读
      </p>
      <MarkdownPreview content={content} />
    </div>
  )
}
