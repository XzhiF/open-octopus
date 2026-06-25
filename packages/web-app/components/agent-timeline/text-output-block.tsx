"use client"

import { MessageSquare } from "lucide-react"

interface TextOutputBlockProps {
  content: string
}

export function TextOutputBlock({ content }: TextOutputBlockProps) {
  if (!content) return null

  return (
    <div className="rounded-md border bg-blue-500/5">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-blue-600 dark:text-blue-400">
        <MessageSquare className="h-3.5 w-3.5" />
        <span className="font-medium">输出</span>
      </div>
      <div className="border-t border-blue-500/10 px-3 py-2">
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
          {content}
        </p>
      </div>
    </div>
  )
}
