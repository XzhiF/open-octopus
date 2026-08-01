"use client"

import { useState, useRef, useCallback, useEffect } from "react"
import type { ChatMessage } from "@/lib/types"
import { toast } from "sonner"
import { getServerUrl } from "@/lib/server-config"
import { applyChunkToMessages, parseSSEStream } from "../chat/apply-chunk"

interface UseInteractionStreamOptions {
  workspaceId: string
  executionId: string
  nodeId: string
  /** Gate: only reset+load when the backend session is created. */
  ready?: boolean
}

interface UseInteractionStreamReturn {
  messages: ChatMessage[]
  isStreaming: boolean
  status: "compacting" | "requesting" | null
  streamStartMs: number | null
  streamEndState: "done" | "aborted" | null
  hasMoreMessages: boolean
  sendMessage: (content: string) => Promise<void>
  abort: () => void
  loadMoreMessages: () => Promise<void>
}

/**
 * Hook for streaming interaction node conversations.
 * Mirrors the ChatPanel-compatible interface from useChatStream,
 * but targets the interaction API instead of the chat API.
 */
export function useInteractionStream({
  workspaceId,
  executionId,
  nodeId,
  ready = true,
}: UseInteractionStreamOptions): UseInteractionStreamReturn {
  const syntheticSessionId = `${executionId}-${nodeId}`

  // Ref to track current session ID for use in async guards
  const syntheticSessionIdRef = useRef(syntheticSessionId)
  useEffect(() => {
    syntheticSessionIdRef.current = syntheticSessionId
  }, [syntheticSessionId])

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [status, setStatus] = useState<"compacting" | "requesting" | null>(null)
  const [streamStartMs, setStreamStartMs] = useState<number | null>(null)
  const [streamEndState, setStreamEndState] = useState<"done" | "aborted" | null>(null)
  const [hasMoreMessages, setHasMoreMessages] = useState(true)

  const abortRef = useRef<AbortController | null>(null)
  const oldestCreatedAtRef = useRef<string | null>(null)

  const apiBase = `${getServerUrl()}/api/workspaces/${workspaceId}/interactions/${executionId}/${nodeId}`

  const applyChunk = useCallback((chunk: Record<string, unknown>) => {
    const type = chunk.type as string | undefined

    if (type === "status") {
      setStatus(chunk.status as "compacting" | "requesting" | null)
    }
    if (type === "error") {
      const errMap: Record<string, string> = {
        auth: "认证失败，请检查 API Key",
        rate_limit: "请求过于频繁，请稍后重试",
        timeout: "AI 响应超时",
        NO_SESSION: "交互会话未初始化",
        MAX_ROUNDS: "已达到最大对话轮数",
      }
      const code = chunk.code as string
      toast.error(errMap[code] ?? (chunk.message as string) ?? "未知错误")
    }

    setMessages(prev => applyChunkToMessages(prev, chunk))
  }, [])

  const sendMessage = useCallback(async (content: string): Promise<void> => {
    if (isStreaming) return

    const controller = new AbortController()
    abortRef.current = controller

    // Capture session ID at call time — if it changes (node switch), ignore chunks
    const callSessionId = syntheticSessionId

    // Optimistically add user message
    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      sessionId: callSessionId,
      role: "user",
      displayType: "user",
      content,
      timestamp: new Date().toISOString(),
    }
    setMessages(prev => [...prev, userMsg])
    setIsStreaming(true)
    setStreamStartMs(Date.now())
    setStreamEndState(null)
    setStatus("requesting")

    let wasAborted = false

    // Wrap applyChunk with session guard — ignore chunks from stale streams
    const guardedApplyChunk = (chunk: Record<string, unknown>) => {
      if (callSessionId !== syntheticSessionIdRef.current) return
      applyChunk(chunk)
    }

    try {
      const res = await fetch(`${apiBase}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: "请求失败" }))
        throw new Error(errData.error ?? "请求失败")
      }

      const reader = res.body?.getReader()
      if (!reader) throw new Error("无法读取响应流")

      setStatus(null)
      await parseSSEStream(reader, guardedApplyChunk)
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        wasAborted = true
      } else {
        toast.error(err instanceof Error ? err.message : "发送消息失败")
      }
    } finally {
      // Only update state if we're still on the same session
      if (callSessionId === syntheticSessionIdRef.current) {
        // Convert AskUserQuestion tool_calls to ask_user_question display type
        setMessages(prev => prev.map(m => {
          if (m.displayType === "tool_call" && m.toolName === "AskUserQuestion" && m.toolStatus === "done") {
            return { ...m, displayType: "ask_user_question" as const }
          }
          return m
        }))

        setIsStreaming(false)
        setStatus(null)
        setStreamEndState(wasAborted ? "aborted" : "done")
      }
      abortRef.current = null
    }
  }, [isStreaming, syntheticSessionId, apiBase, applyChunk])

  const abort = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const loadMoreMessages = useCallback(async (): Promise<void> => {
    const cursor = oldestCreatedAtRef.current
    const params = new URLSearchParams({ limit: "100" })
    if (cursor) params.set("before", cursor)

    try {
      const res = await fetch(`${apiBase}/messages?${params}`)
      if (!res.ok) return

      const rows = await res.json() as Array<{
        id: string
        role: string
        type: string
        content: string
        metadata: string | null
        created_at: string
      }>

      if (rows.length < 100) {
        setHasMoreMessages(false)
      }

      // Convert DB rows to ChatMessage
      const dbMessages: ChatMessage[] = rows.map(row => {
        let meta: Record<string, unknown> = {}
        try { meta = JSON.parse(row.metadata ?? "{}") } catch { /* ignore */ }

        return {
          id: row.id,
          sessionId: syntheticSessionId,
          role: row.role as ChatMessage["role"],
          displayType: (meta.displayType as ChatMessage["displayType"]) ?? row.type as ChatMessage["displayType"],
          content: row.content,
          timestamp: row.created_at,
          toolCallId: meta.toolCallId as string | undefined,
          toolName: meta.toolName as string | undefined,
          toolInput: meta.toolInput,
          toolStatus: meta.toolStatus as ChatMessage["toolStatus"],
          toolResult: meta.toolResult as string | undefined,
          toolDuration: meta.toolDuration as string | undefined,
          thinkingContent: row.type === "thinking" ? row.content : undefined,
          thinkingDone: row.type === "thinking",
          thinkingDuration: meta.thinkingDuration as string | undefined,
          tokens: meta.tokens as ChatMessage["tokens"],
          costUsd: meta.costUsd as number | undefined,
        }
      })

      if (dbMessages.length > 0) {
        oldestCreatedAtRef.current = dbMessages[0].timestamp
      }

      // Prepend older messages (avoid duplicates by id, and deduplicate
      // optimistic user messages that match DB user messages by content)
      setMessages(prev => {
        const existingIds = new Set(prev.map(m => m.id))
        const optimisticUserContents = new Set(
          prev.filter(m => m.id.startsWith("user-")).map(m => m.content)
        )
        const newMessages = dbMessages.filter(m => {
          if (existingIds.has(m.id)) return false
          // Replace optimistic user message with DB version
          if (m.role === "user" && optimisticUserContents.has(m.content)) {
            optimisticUserContents.delete(m.content) // only remove one
            return false
          }
          return true
        })
        // Remove optimistic user messages that have DB equivalents
        const cleanedPrev = prev.filter(m => {
          if (!m.id.startsWith("user-")) return true
          return !dbMessages.some(db => db.role === "user" && db.content === m.content)
        })
        return [...newMessages, ...cleanedPrev]
      })
    } catch {
      // Non-fatal — history loading failure is not critical
    }
  }, [apiBase, syntheticSessionId])

  // Reset all state when switching to a different node/execution.
  // Triggers on syntheticSessionId change — the definitive signal for a new node.
  // Also aborts any in-flight stream from the previous node.
  useEffect(() => {
    // Abort previous stream to prevent old node's chunks polluting new node's messages
    abortRef.current?.abort()
    setMessages([])
    setIsStreaming(false)
    setStatus(null)
    setStreamStartMs(null)
    setStreamEndState(null)
    setHasMoreMessages(true)
    oldestCreatedAtRef.current = null
  }, [syntheticSessionId])

  // Load messages from DB when session becomes ready (after /start completes).
  // Separate from reset to avoid overwriting optimistic messages from sendMessage.
  useEffect(() => {
    if (!ready) return
    loadMoreMessages()
  }, [ready, loadMoreMessages])

  return {
    messages,
    isStreaming,
    status,
    streamStartMs,
    streamEndState,
    hasMoreMessages,
    sendMessage,
    abort,
    loadMoreMessages,
  }
}
