"use client"

import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeSanitize, { defaultSchema } from "rehype-sanitize"
import { cn } from "@/lib/utils"

/**
 * MarkdownPreview — renders markdown with XSS protection via rehype-sanitize.
 * HC1 fix: sanitization prevents script injection in resource SKILL.md content.
 */

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames || []), "input"],
  attributes: {
    ...defaultSchema.attributes,
    input: [["type", "checkbox"], ["checked", "checked"], ["disabled", "disabled"]],
  },
}

interface MarkdownPreviewProps {
  content: string
  className?: string
}

/** 产物窗 / 验收弹窗共用的 TUI 排版（项目未装 typography 插件，用任意变体钉住）。
 *  2026-10-30：从 artifacts-tab 提出来 —— 验收台里点开的 .md 也要和产物窗同款观感。 */
export const MARKDOWN_TUI_CLASS = [
  "text-[11.5px] leading-relaxed",
  "[&_h1]:mb-2 [&_h1]:text-[13px] [&_h1]:font-bold [&_h1]:text-pop-ink",
  "[&_h2]:mb-1 [&_h2]:mt-3 [&_h2]:text-[12px] [&_h2]:font-bold [&_h2]:text-pop-purple",
  "[&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:text-[11.5px] [&_h3]:font-bold",
  "[&_p]:mb-1.5 [&_p]:text-pop-ink/85",
  "[&_ul]:mb-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:mb-1.5 [&_ol]:list-decimal [&_ol]:pl-5",
  "[&_li]:mb-0.5 [&_li]:text-pop-ink/85",
  "[&_code]:rounded-[3px] [&_code]:bg-pop-bd/50 [&_code]:px-1 [&_code]:text-pop-green",
  "[&_pre]:mb-1.5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-pop-bd [&_pre]:bg-pop-inset [&_pre]:p-2",
  "[&_table]:mb-2 [&_table]:w-full [&_table]:border-collapse",
  "[&_th]:border [&_th]:border-pop-bd [&_th]:px-1.5 [&_th]:py-0.5 [&_th]:text-left",
  "[&_td]:border [&_td]:border-pop-bd [&_td]:px-1.5 [&_td]:py-0.5",
  "[&_a]:text-pop-cyan [&_a]:underline",
  "[&_blockquote]:border-l-2 [&_blockquote]:border-pop-bd [&_blockquote]:pl-2 [&_blockquote]:text-pop-dim",
].join(" ")

export function MarkdownPreview({ content, className }: MarkdownPreviewProps) {
  return (
    <div className={cn("prose prose-sm dark:prose-invert max-w-none", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[
          [rehypeSanitize, sanitizeSchema],
        ]}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
