"use client"

import type { ChatMessage } from "@/lib/types"

interface UserMessageProps {
  message: ChatMessage
}

export function UserMessage({ message }: UserMessageProps) {
  return (
    <div className="mb-4 rounded-md bg-pop-paper px-3 py-1.5 shadow-[inset_0_0_0_1px_var(--pop-bd)]">
      <span className="font-bold text-pop-pink">❯ </span>
      <span className="break-words whitespace-pre-wrap">{message.content}</span>
    </div>
  )
}