"use client"

import { memo } from "react"
import type { ChatMessage } from "@/lib/types"
import { UserMessage } from "./user-message"
import { ThinkingBlock } from "./thinking-block"
import { ToolCard } from "./tool-card"
import { QuestionCard } from "./question-card"
import { AskUserQuestionCard } from "./ask-user-question-card"
import { AssistantMessage } from "./assistant-message"

interface MessageBubbleProps {
  message: ChatMessage
  isStreaming?: boolean
  isSessionStreaming?: boolean
  onAnswer?: (content: string) => void
}

export const MessageBubble = memo(function MessageBubble({ message, isStreaming, isSessionStreaming, onAnswer }: MessageBubbleProps) {
  // AskUserQuestion tool calls use QuestionCard for smooth morphing
  // isSessionStreaming is the raw session streaming state — QuestionCard must stay disabled
  // until the stream fully completes (green "完成" status bar appears)
  if (message.toolName === "AskUserQuestion") {
    return <QuestionCard message={message} onAnswer={onAnswer ?? (() => {})} disabled={isSessionStreaming ?? false} />
  }

  switch (message.displayType) {
    case "user":
      return <UserMessage message={message} />
    case "thinking":
      return <ThinkingBlock message={message} />
    case "tool_call":
      return <ToolCard message={message} />
    case "ask_user_question":
      return <QuestionCard message={message} onAnswer={onAnswer ?? (() => {})} disabled={isSessionStreaming ?? false} />
    case "text":
      return <AssistantMessage message={message} isStreaming={isStreaming} />
    case "error":
      return <AssistantMessage message={message} />
    case "file":
      return <AssistantMessage message={message} />
    default:
      return null
  }
}, (prev, next) => {
  if (prev.message.id !== next.message.id) return false
  if (prev.message.displayType !== next.message.displayType) return false
  if (prev.message.toolStatus !== next.message.toolStatus) return false
  if (prev.message.content !== next.message.content) return false
  if (prev.message.thinkingContent !== next.message.thinkingContent) return false
  if (prev.message.thinkingDone !== next.message.thinkingDone) return false
  if (prev.isSessionStreaming !== next.isSessionStreaming) return false
  if (prev.isStreaming !== next.isStreaming) return false
  // Re-render when toolInput arrives (needed for QuestionCard preview)
  if (prev.message.toolInput !== next.message.toolInput) return false
  return true
})