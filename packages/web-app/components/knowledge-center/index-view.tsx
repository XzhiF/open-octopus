"use client"

import { MarkdownPreview } from "@/components/resource/MarkdownPreview"

/**
 * INDEX 总览视图 — 知识中心改版（ADR-0033）：在盘导航层只读呈现。
 * 数据=tree 响应捎带的 index 文本（log 同律；缺席=诚实空态，不伪造）。
 * 与左树的分工：树是交互地图（点击即达），INDEX 是策展文本（含摘要与 ←N 源
 * 计数，读协议「先读索引」的第一跳在界面上成立）。
 */
export function IndexView({ content }: { content: string | null }) {
  return (
    <div data-testid="kc-index-view" className="mx-auto w-full max-w-[820px] p-6">
      <h1 className="mb-1 text-lg font-black text-pop-ink">🗂 INDEX.md — 知识总览</h1>
      <p className="mb-4 text-[11px] font-bold text-pop-dim">
        编译管线程序化重建的导航层（只读 · 永不经 LLM/人手写 · 详情看 git show）
      </p>
      {content == null ? (
        <div className="py-10 text-center text-sm text-pop-dim">（在盘尚无 INDEX.md —— 首编后出现）</div>
      ) : (
        <MarkdownPreview content={content} />
      )}
    </div>
  )
}
