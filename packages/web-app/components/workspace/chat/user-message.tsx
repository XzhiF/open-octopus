"use client"

import type { ChatMessage } from "@/lib/types"

interface UserMessageProps {
  message: ChatMessage
}

export function UserMessage({ message }: UserMessageProps) {
  return (
    <div className="flex justify-end mb-4">
      <div className="bg-primary text-primary-foreground rounded-xl rounded-br-sm px-4 py-2.5 max-w-[80%] text-sm leading-relaxed break-words overflow-wrap-anywhere">
        {message.content}
      </div>
    </div>
  )
}