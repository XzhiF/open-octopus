"use client"

import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeSanitize from "rehype-sanitize"
import { cn } from "@/lib/utils"

interface MarkdownPreviewProps {
  content: string
  className?: string
}

const MAX_CHARS = 10000

export function MarkdownPreview({ content, className }: MarkdownPreviewProps) {
  const truncated = content.length > MAX_CHARS
  const displayContent = truncated
    ? content.slice(0, MAX_CHARS) + "\n\n...(内容已截断)"
    : content

  return (
    <div className={cn("prose prose-sm dark:prose-invert max-w-none", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          a: ({ href, children, ...props }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              {...props}
            >
              {children}
            </a>
          ),
        }}
      >
        {displayContent}
      </ReactMarkdown>
    </div>
  )
}
