"use client"

import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { rehypeSanitize, defaultSchema } from "rehype-sanitize"
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
