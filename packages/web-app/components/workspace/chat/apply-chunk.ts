// packages/web-app/components/workspace/chat/apply-chunk.ts
//
// Shared SSE chunk → ChatMessage[] reducer.
// Used by both useChatStream and useInteractionStream.

import type { ChatMessage } from "@/lib/types"

/**
 * Apply a single SSE chunk to a message array, returning a new array.
 * Pure function — no side effects.
 */
export function applyChunkToMessages(prev: ChatMessage[], chunk: Record<string, unknown>): ChatMessage[] {
  const type = chunk.type as string | undefined

  switch (type) {
    case "message_start": {
      const msgId = chunk.messageId as string
      if (prev.some(m => m.id === msgId && m.displayType !== "thinking")) return prev

      const resolved = prev.map(m => m.id === msgId && m.displayType === "thinking" && !m.thinkingDone
        ? { ...m, thinkingDone: true }
        : m
      )

      return [...resolved, {
        id: msgId,
        sessionId: chunk.sessionId as string,
        role: "assistant" as const,
        displayType: "thinking" as const,
        content: "",
        timestamp: new Date().toISOString(),
      }]
    }

    case "text_delta": {
      const msgId = chunk.messageId as string
      const content = chunk.content as string

      const thinkingIdx = prev.findIndex(m => m.id === msgId && m.displayType === "thinking" && !m.thinkingDone)
      if (thinkingIdx !== -1) {
        const resolvedThinking = prev.map((m, i) => i === thinkingIdx
          ? { ...m, thinkingDone: true }
          : m
        )
        const existingTextIdx = resolvedThinking.findIndex(m => m.id === msgId && m.displayType === "text")
        if (existingTextIdx !== -1) {
          return resolvedThinking.map((m, i) => i === existingTextIdx
            ? { ...m, content: m.content + content }
            : m
          )
        }
        return [...resolvedThinking, {
          id: msgId,
          sessionId: chunk.sessionId as string,
          role: "assistant" as const,
          displayType: "text" as const,
          content,
          timestamp: new Date().toISOString(),
        }]
      }

      const existingIdx = prev.findIndex(m => m.id === msgId && m.displayType === "text")
      if (existingIdx !== -1) {
        return prev.map((m, i) => i === existingIdx
          ? { ...m, content: m.content + content }
          : m
        )
      }
      return [...prev, {
        id: msgId,
        sessionId: chunk.sessionId as string,
        role: "assistant" as const,
        displayType: "text" as const,
        content,
        timestamp: new Date().toISOString(),
      }]
    }

    case "text_done":
      return prev

    case "thinking_start": {
      const msgId = chunk.messageId as string
      return prev.map(m => m.id === msgId && m.displayType === "thinking"
        ? { ...m, thinkingStartMs: Date.now() }
        : m
      )
    }

    case "thinking": {
      const msgId = chunk.messageId as string
      const content = chunk.content as string
      return prev.map(m => m.id === msgId && m.displayType === "thinking"
        ? { ...m, thinkingContent: (m.thinkingContent ?? "") + content }
        : m
      )
    }

    case "thinking_done": {
      const msgId = chunk.messageId as string
      const serverDuration = chunk.thinkingDuration as string | undefined
      return prev.map(m => m.id === msgId && m.displayType === "thinking"
        ? {
            ...m,
            thinkingDone: true,
            thinkingDuration: serverDuration ?? (
              m.thinkingStartMs
                ? `${((Date.now() - m.thinkingStartMs) / 1000).toFixed(1)}s`
                : undefined
            ),
          }
        : m
      )
    }

    case "tool_call_start": {
      const msgId = chunk.messageId as string
      const toolId = chunk.toolCallId as string

      const resolved = prev.map(m => m.id === msgId && m.displayType === "thinking" && !m.thinkingDone
        ? { ...m, thinkingDone: true }
        : m
      )

      const existingIdx = resolved.findIndex(m => m.toolCallId === toolId)
      if (existingIdx !== -1) {
        return resolved.map((m, i) => i === existingIdx
          ? { ...m, toolName: chunk.toolName as string, toolStatus: "running" as const }
          : m
        )
      }
      const toolMsg: ChatMessage = {
        id: `tool-${chunk.toolCallId ?? chunk.toolName}-${Date.now()}`,
        sessionId: chunk.sessionId as string,
        role: "assistant" as const,
        displayType: "tool_call" as const,
        content: "",
        toolCallId: chunk.toolCallId as string,
        toolName: chunk.toolName as string,
        toolInput: undefined,
        toolStatus: "running",
        timestamp: new Date().toISOString(),
      }
      return [...resolved, toolMsg]
    }

    case "tool_call": {
      const toolId = chunk.toolCallId as string
      return prev.map(m => m.toolCallId === toolId && m.toolStatus === "running"
        ? { ...m, toolInput: chunk.toolInput }
        : m
      )
    }

    case "tool_progress": {
      const toolId = chunk.toolCallId as string
      const seconds = chunk.elapsedSeconds as number
      return prev.map(m => m.toolCallId === toolId && m.toolStatus === "running"
        ? { ...m, toolDuration: `${seconds.toFixed(1)}s` }
        : m
      )
    }

    case "tool_result": {
      const toolId = chunk.toolCallId as string
      const idx = [...prev].reverse().findIndex(m => m.toolCallId === toolId)
      if (idx === -1) return prev
      const realIdx = prev.length - 1 - idx
      return prev.map((m, i) => i === realIdx ? {
        ...m,
        toolStatus: chunk.isError ? "error" : "done",
        toolResult: chunk.content as string,
        toolDuration: (chunk.toolDuration as string | undefined) ?? m.toolDuration,
      } : m)
    }

    case "tool_summary":
      return prev

    case "ask_user_question": {
      const toolCallId = chunk.toolCallId as string
      const questions = chunk.questions
      return prev.map(m => m.toolCallId === toolCallId && m.displayType === "tool_call"
        ? { ...m, toolStatus: "done" as const, toolInput: questions }
        : m
      )
    }

    case "local_command_output": {
      const content = chunk.content as string
      const existingIdx = prev.findIndex(m => m.displayType === "text" && m.id.startsWith("cmd-"))
      if (existingIdx !== -1) {
        return prev.map((m, i) => i === existingIdx
          ? { ...m, content: m.content + content }
          : m
        )
      }
      return [...prev, {
        id: `cmd-${Date.now()}`,
        sessionId: chunk.sessionId as string,
        role: "assistant" as const,
        displayType: "text" as const,
        content,
        timestamp: new Date().toISOString(),
      }]
    }

    case "message_delta":
    case "message_stop":
      return prev

    case "result": {
      const content = chunk.content as string | undefined
      const updated = prev.map(m => m.displayType === "text" && !m.usage ? {
        ...m,
        usage: chunk.usage as ChatMessage["usage"],
        costUsd: chunk.costUsd as number,
      } : m)

      const hasTextThisTurn = updated.some(m =>
        m.displayType === "text" && m.role === "assistant"
      )
      if (content && !hasTextThisTurn) {
        return [...updated, {
          id: `result-${Date.now()}`,
          sessionId: chunk.sessionId as string,
          role: "assistant" as const,
          displayType: "text" as const,
          content,
          timestamp: new Date().toISOString(),
        }]
      }
      return updated
    }

    case "status":
    case "error":
      return prev

    default:
      return prev
  }
}

/**
 * Parse SSE from a ReadableStream, calling applyChunk for each event.
 * Shared between useChatStream and useInteractionStream.
 */
export async function parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  applyChunk: (chunk: Record<string, unknown>) => void,
): Promise<void> {
  const decoder = new TextDecoder()
  let buffer = ""
  let currentEventType = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""

    for (const line of lines) {
      if (line.startsWith("event:")) {
        currentEventType = line.slice(6).trim()
        continue
      }

      if (line.startsWith("data:")) {
        const dataStr = line.slice(5).trim()
        if (!dataStr) continue

        try {
          const eventData = JSON.parse(dataStr)
          if (!eventData.type && currentEventType) {
            eventData.type = currentEventType
          }
          applyChunk(eventData)
          currentEventType = ""
        } catch {
          // skip unparseable lines
        }
      }
    }
  }
}
