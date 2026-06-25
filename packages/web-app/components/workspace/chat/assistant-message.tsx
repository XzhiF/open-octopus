"use client"

import type { ChatMessage } from "@/lib/types"

interface AssistantMessageProps {
  message: ChatMessage
  isStreaming?: boolean
}

export function AssistantMessage({ message, isStreaming }: AssistantMessageProps) {
  return (
    <div className="mb-4">
      <div className="bg-secondary rounded-xl px-4 py-3 text-sm leading-relaxed break-words overflow-wrap-anywhere max-w-[90%]">
        <div
          className="prose prose-sm dark:prose-invert max-w-none [&_pre]:overflow-x-auto [&_pre]:text-xs [&_code]:text-xs"
          dangerouslySetInnerHTML={{
            __html: formatContent(message.content),
          }}
        />
        {isStreaming && (
          <span className="inline-block w-2 h-4 bg-foreground/60 ml-0.5 animate-pulse align-text-bottom" />
        )}
      </div>
    </div>
  )
}

function formatContent(content: string): string {
  let formatted = content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")

  formatted = formatted.replace(
    /```(\w*)\n?([\s\S]*?)```/g,
    (_match: string, lang: string, code: string) => {
      return `<pre class="bg-muted rounded-md p-3 my-2 overflow-x-auto"><code class="language-${lang || 'plaintext'}">${code.trim()}</code></pre>`
    }
  )

  formatted = formatted.replace(
    /`([^`]+)`/g,
    "<code class=\"bg-muted px-1 py-0.5 rounded text-xs\">$1</code>"
  )

  formatted = formatted.replace(/\n/g, "<br>")

  return formatted
}