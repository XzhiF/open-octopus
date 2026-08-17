"use client"

import { useState, useRef, useCallback, useEffect } from "react"
import { toast } from "sonner"
import { getServerUrl } from "@/lib/server-config"

/**
 * Task-author clone chat adapter.
 *
 * WHY this exists (not a reuse of components/workspace/chat/use-chat-stream.ts):
 * The clone route (packages/server/src/routes/clone/index.ts, ticket 09) speaks a
 * DIFFERENT SSE protocol than the workspace/global chat:
 *   - POST /api/clones/:name/sessions/:id/chat with body { message }   (global: { content })
 *   - Named SSE events (event: text_delta)                              (global: type-field chunks)
 *   - text_delta.data.content = FULL accumulator                        (global: per-call delta)
 *   - tool_call = one event with sub-type start|input|result             (global: 3 separate types)
 *   - done / error are named events                                      (global: message_stop / error)
 * useChatStream cannot speak this without rewriting its reducer (spec forbids
 * 重写前端 chat 组件). This module is net-new, protocol-faithful, and self-contained.
 */

export interface CloneMessage {
  id: string
  role: "user" | "assistant"
  kind: "text" | "thinking" | "tool_call"
  content: string
  toolName?: string
  toolStatus?: "running" | "done" | "error"
  toolResult?: string
  isError?: boolean
}

/** Index of the last user message, or -1 when none exists. */
function lastUserIndex(msgs: CloneMessage[]): number {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") return i
  }
  return -1
}

/**
 * Pure reducer that maps one clone SSE event onto the message list. Turn-scoped:
 * edits only affect assistant messages AFTER the last user message, so prior turns
 * are never clobbered. Returns the SAME array reference when the event causes no
 * message change (status / done / unknown) so React can bail out.
 */
export function reduceCloneEvent(
  prev: CloneMessage[],
  event: string,
  data: Record<string, unknown>
): CloneMessage[] {
  // Irrelevant-to-messages events: no array change.
  if (event === "status" || event === "done" || event === "error" || event === "thinking_done") {
    return prev
  }

  const uIdx = lastUserIndex(prev)
  const head = prev.slice(0, uIdx + 1)
  const tail = prev.slice(uIdx + 1)
  const userId = uIdx >= 0 ? prev[uIdx].id : "clone"

  switch (event) {
    case "text_delta": {
      // content is the FULL accumulator — REPLACE, never append.
      const content = (data.content as string | undefined) ?? ""
      const textIdx = [...tail].reverse().findIndex(
        (m) => m.role === "assistant" && m.kind === "text"
      )
      if (textIdx !== -1) {
        const realIdx = tail.length - 1 - textIdx
        const newTail = tail.map((m, i) => (i === realIdx ? { ...m, content } : m))
        return [...head, ...newTail]
      }
      return [...head, ...tail, { id: `${userId}-text`, role: "assistant", kind: "text", content }]
    }

    case "thinking_start": {
      return [...head, ...tail, { id: `${userId}-thinking`, role: "assistant", kind: "thinking", content: "" }]
    }

    case "thinking": {
      const delta = (data.delta as string | undefined) ?? ""
      const newTail = [...tail]
      for (let i = newTail.length - 1; i >= 0; i--) {
        if (newTail[i].kind === "thinking") {
          newTail[i] = { ...newTail[i], content: newTail[i].content + delta }
          return [...head, ...newTail]
        }
      }
      return prev
    }

    case "tool_call": {
      const subType = data.type as string
      const toolId = `tool-${data.tool_call_id as string}`
      if (subType === "start") {
        return [...head, ...tail, {
          id: toolId, role: "assistant", kind: "tool_call", content: "",
          toolName: data.tool_name as string, toolStatus: "running",
        }]
      }
      // input / result mutate the existing tool message.
      const idx = tail.findIndex((m) => m.id === toolId)
      if (idx === -1) return prev
      if (subType === "result") {
        const isError = Boolean(data.is_error)
        const result = (data.content as string | undefined) ?? ""
        const newTail = tail.map((m, i): CloneMessage => i === idx
          ? { ...m, toolStatus: isError ? "error" : "done", toolResult: result, isError }
          : m)
        return [...head, ...newTail]
      }
      // subType === "input" — record input without changing status.
      const inputTail = tail.map((m, i): CloneMessage => i === idx
        ? { ...m, toolName: (data.tool_name as string) ?? m.toolName }
        : m)
      return [...head, ...inputTail]
    }

    default:
      return prev
  }
}

interface CloneSessionRow {
  id: string
  title?: string
  created_at?: string
  updated_at?: string
}

interface CloneMessageRow {
  id: string
  role: string
  type?: string
  content: string
  created_at?: string
}

function rowsToMessages(rows: CloneMessageRow[]): CloneMessage[] {
  return rows.map((m) => ({
    id: m.id,
    role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
    kind: "text" as const,
    content: m.content ?? "",
  }))
}

export interface UseCloneChatStreamOptions {
  apiBase: string
  sessionId?: string | null
  onSessionCreated?: (sessionId: string) => void
}

export interface UseCloneChatStreamReturn {
  messages: CloneMessage[]
  isStreaming: boolean
  status: "requesting" | null
  sendMessage: (content: string) => Promise<string | null>
  abort: () => void
  createSession: (scopeId?: string) => Promise<string | null>
  activeSessionId: string | null
  ready: boolean
}

export function useCloneChatStream(
  options: UseCloneChatStreamOptions
): UseCloneChatStreamReturn {
  const { apiBase, sessionId, onSessionCreated } = options
  const [messages, setMessages] = useState<CloneMessage[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [status, setStatus] = useState<"requesting" | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(sessionId ?? null)
  const [ready, setReady] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const activeRef = useRef<string | null>(sessionId ?? null)
  useEffect(() => { activeRef.current = activeSessionId }, [activeSessionId])

  const loadSession = useCallback(async (sid: string) => {
    try {
      const res = await fetch(`${getServerUrl()}${apiBase}/sessions/${sid}?limit=200`)
      if (!res.ok) return
      const data = await res.json() as { messages?: CloneMessageRow[] }
      setMessages(rowsToMessages(data.messages ?? []))
    } catch {
      // silent — streaming will still work against a live session
    } finally {
      setReady(true)
    }
  }, [apiBase])

  // Load messages when an external sessionId is provided.
  useEffect(() => {
    if (sessionId) {
      setActiveSessionId(sessionId)
      void loadSession(sessionId)
    } else {
      setMessages([])
      setReady(true)
    }
  }, [sessionId, loadSession])

  const createSession = useCallback(async (scopeId?: string): Promise<string | null> => {
    try {
      const res = await fetch(`${getServerUrl()}${apiBase}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(scopeId ? { scope_id: scopeId } : {}),
      })
      if (!res.ok) {
        toast.error("无法创建任务对话会话")
        return null
      }
      const session = await res.json() as CloneSessionRow
      setActiveSessionId(session.id)
      setMessages([])
      onSessionCreated?.(session.id)
      return session.id
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "创建会话失败")
      return null
    }
  }, [apiBase, onSessionCreated])

  const sendMessage = useCallback(async (content: string): Promise<string | null> => {
    const trimmed = content.trim()
    if (!trimmed || isStreaming) return null

    let sid = activeRef.current
    if (!sid) {
      sid = await createSession()
      if (!sid) return null
    }
    const resolvedSid = sid

    const userMsg: CloneMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      kind: "text",
      content: trimmed,
    }
    setMessages((prev) => [...prev, userMsg])
    setIsStreaming(true)
    setStatus("requesting")

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const res = await fetch(`${getServerUrl()}${apiBase}/sessions/${resolvedSid}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed }),
        signal: controller.signal,
      })
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: { message: "请求失败" } }))
        const msg = (errData?.error?.message) ?? errData?.error ?? "请求失败"
        throw new Error(typeof msg === "string" ? msg : "请求失败")
      }

      const reader = res.body?.getReader()
      if (!reader) throw new Error("无法读取响应流")
      const decoder = new TextDecoder()
      let buffer = ""
      let currentEvent = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim()
            continue
          }
          if (line.startsWith("data:")) {
            const dataStr = line.slice(5).trim()
            if (!dataStr || !currentEvent) continue
            try {
              const data = JSON.parse(dataStr) as Record<string, unknown>
              setMessages((prev) => reduceCloneEvent(prev, currentEvent, data))
            } catch {
              // skip unparseable
            }
            currentEvent = ""
          }
        }
      }
      return resolvedSid
    } catch (err: unknown) {
      if ((err as Error).name === "AbortError") return null
      toast.error(err instanceof Error ? err.message : "发送消息失败")
      return resolvedSid
    } finally {
      setIsStreaming(false)
      setStatus(null)
      abortRef.current = null
      // Reconcile with persisted messages so tool_call/tool_result rows render.
      void loadSession(resolvedSid)
    }
  }, [apiBase, createSession, isStreaming, loadSession])

  const abort = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  return {
    messages,
    isStreaming,
    status,
    sendMessage,
    abort,
    createSession,
    activeSessionId,
    ready,
  }
}
