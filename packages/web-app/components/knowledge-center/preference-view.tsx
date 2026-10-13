"use client"

import { MarkdownPreview } from "@/components/resource/MarkdownPreview"

/**
 * user_preference 只读视图 — 票11 AC6（spec 故事 16）。
 * 显著标注「人工文件，直接编辑」；**零编辑控件**（对比旧 PreferenceEditor——不复用不重开；
 * 写入面属人工，AI 侧只有策展人建议文本，spec 质控六道⑥）。
 */
export function PreferenceView({ content }: { content: string }) {
  return (
    <div data-testid="kc-preference-view" className="p-6">
      <div
        data-testid="kc-preference-banner"
        className="mb-4 rounded-md border-[1.5px] border-pop-amber bg-pop-amber-soft px-3 py-2 text-xs font-black text-pop-amber"
      >
        ⚙ user_preference.md — 人工文件，直接编辑（AI 永不自动改写；本视图只读）
      </div>
      <h1 className="mb-3 text-lg font-black text-pop-ink">owner 偏好</h1>
      {content.trim() === "" ? (
        <div className="text-sm text-pop-dim">（知识根尚无 user_preference.md——人工落笔后出现）</div>
      ) : (
        <MarkdownPreview content={content} />
      )}
    </div>
  )
}
