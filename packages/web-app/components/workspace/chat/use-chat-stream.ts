"use client"

import { useState, useRef, useCallback, useEffect } from "react"
import type { ChatMessage, ChatSession } from "@/lib/types"
import { fromDBMessage } from "@/lib/types"
import { toast } from "sonner"
import { getServerUrl } from "@/lib/server-config"

interface StreamMeta {
  startMs: number | null
  endState: 'done' | 'aborted' | null
}

interface SessionMeta {
  oldestCreatedAt: string | null
  totalMessageCount: number
}

interface UseChatStreamReturn {
  messages: ChatMessage[]
  sessions: ChatSession[]
  isStreaming: boolean
  isCurrentSessionStreaming: boolean
  status: 'compacting' | 'requesting' | null
  streamStartMs: number | null
  streamEndState: 'done' | 'aborted' | null
  hasMoreMessages: boolean
  sendMessage: (content: string) => Promise<string>
  abort: () => void
  createSession: () => Promise<string>
  switchSession: (sessionId: string) => void
  deleteSession: (sessionId: string) => void
  renameSession: (sessionId: string, title: string) => void
  loadSessionMessages: (sessionId: string) => Promise<void>
  loadMoreMessages: () => Promise<void>
}

function applyChunkToSession(prev: ChatMessage[], chunk: Record<string, unknown>): ChatMessage[] {
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

    case "text_done": {
      return prev
    }

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
      const idx = [...prev].reverse().findIndex(
        m => m.toolCallId === toolId
      )
      // Skip unmatched tool results — agent sub-results arrive without
      // a tool_call_start; they'll be properly formatted on DB reload.
      if (idx === -1) {
        return prev
      }
      const realIdx = prev.length - 1 - idx
      return prev.map((m, i) => i === realIdx ? {
        ...m,
        toolStatus: chunk.isError ? "error" : "done",
        toolResult: chunk.content as string,
        toolDuration: (chunk.toolDuration as string | undefined) ?? m.toolDuration,
      } : m)
    }

    case "tool_summary": {
      return prev
    }

    case "ask_user_question": {
      const toolCallId = chunk.toolCallId as string
      const questions = chunk.questions
      return prev.map(m => m.toolCallId === toolCallId && m.displayType === "tool_call"
        ? {
            ...m,
            // Keep tool_call displayType during streaming; converted to ask_user_question on stream end
            toolStatus: "done" as const,
            toolInput: questions,
          }
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
    case "message_stop": {
      return prev
    }

    case "result": {
      const content = chunk.content as string | undefined
      const updated = prev.map(m => m.displayType === "text" && !m.tokens ? {
        ...m,
        tokens: chunk.tokens as ChatMessage["tokens"],
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
    case "error": {
      return prev
    }

    default:
      return prev
  }
}

export function useChatStream(
  workspaceId: string | null,
  activeSessionId: string | null,
  options?: { apiBase?: string; onSessionCreated?: (sessionId: string) => void }
): UseChatStreamReturn {
  // Compute API base path: either workspace-specific or custom (e.g. global chat)
  const apiBase = options?.apiBase
    ?? (workspaceId ? `/api/workspaces/${workspaceId}/chat` : '/api/chat/global')
  const [messagesBySession, setMessagesBySession] = useState<Record<string, ChatMessage[]>>({})
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  const sessionsRef = useRef<ChatSession[]>([])
  useEffect(() => { sessionsRef.current = sessions }, [sessions])
  const activeSessionIdRef = useRef<string | null>(activeSessionId)
  useEffect(() => { activeSessionIdRef.current = activeSessionId }, [activeSessionId])
  const [streamingSessionId, setStreamingSessionId] = useState<string | null>(null)
  const [status, setStatus] = useState<'compacting' | 'requesting' | null>(null)
  const [streamMeta, setStreamMeta] = useState<Record<string, StreamMeta>>({})
  const [sessionMetaMap, setSessionMetaMap] = useState<Record<string, SessionMeta>>({})
  const abortRef = useRef<AbortController | null>(null)
  const streamingSessionIdRef = useRef<string | null>(null)

  // Keep ref in sync with state (for EventSource handler which runs outside React lifecycle)
  useEffect(() => {
    streamingSessionIdRef.current = streamingSessionId
  }, [streamingSessionId])

  // Derived values
  const messages = messagesBySession[activeSessionId ?? ''] ?? []
  const isStreaming = streamingSessionId !== null
  const isCurrentSessionStreaming = streamingSessionId !== null && streamingSessionId === activeSessionId
  const streamStartMs = streamMeta[streamingSessionId ?? '']?.startMs ?? null
  const streamEndState = streamMeta[activeSessionId ?? '']?.endState ?? null
  const activeMeta = sessionMetaMap[activeSessionId ?? '']
  const hasMoreMessages = activeMeta?.oldestCreatedAt !== null &&
    messages.length < (activeMeta?.totalMessageCount ?? 0)

  // Auto-fade streamEndState for the active session
  useEffect(() => {
    const meta = streamMeta[activeSessionId ?? '']
    if (!meta?.endState) return
    const fadeDelay = meta.endState === 'done' ? 3000 : 2000
    const timer = setTimeout(() => {
      setStreamMeta(prev => ({
        ...prev,
        [activeSessionId ?? '']: { ...prev[activeSessionId ?? ''], endState: null },
      }))
    }, fadeDelay)
    return () => clearTimeout(timer)
  }, [activeSessionId, streamMeta])

  // Workspace-level EventSource for cross-session notifications
  // Only active when workspaceId is set (not for global scope)
  useEffect(() => {
    if (!workspaceId) return
    const source = new EventSource(`${getServerUrl()}/api/workspaces/${workspaceId}/events`)

    source.addEventListener("session_updated", (e) => {
      try {
        const data = JSON.parse(e.data)
        const updatedSessionId = data?.sessionId
        // Skip reload for currently streaming or active session —
        // chunks are already delivering messages via SSE.
        if (updatedSessionId === streamingSessionIdRef.current) return
        if (updatedSessionId === activeSessionIdRef.current) return
        loadSessionMessages(updatedSessionId)
      } catch {
        if (activeSessionId && !streamingSessionIdRef.current) {
          loadSessionMessages(activeSessionId)
        }
      }
    })
    source.addEventListener("session_created", () => {
      loadSessions()
    })

    source.onerror = () => {
      // EventSource auto-reconnects
    }

    return () => {
      source.close()
    }
  }, [workspaceId])

  const loadSessions = useCallback(async () => {
    try {
      const res = await fetch(`${getServerUrl()}${apiBase}/sessions`)
      const data = await res.json()
      setSessions(Array.isArray(data) ? data : [])
    } catch {
      setSessions([])
    } finally {
      setSessionsLoaded(true)
    }
  }, [workspaceId])

  const loadingSessionsRef = useRef<Set<string>>(new Set())

  const loadSessionMessages = useCallback(async (sessionId: string) => {
    if (loadingSessionsRef.current.has(sessionId)) return
    loadingSessionsRef.current.add(sessionId)
    try {
      const res = await fetch(`${getServerUrl()}${apiBase}/sessions/${sessionId}?limit=100`)
      if (!res.ok) return
      // Re-check: don't overwrite messages if a new stream started during the fetch
      if (streamingSessionIdRef.current === sessionId) return
      const data = await res.json()
      const msgs: ChatMessage[] = (data.messages ?? []).map((m: Record<string, unknown>) =>
        fromDBMessage({
          id: m.id as string,
          session_id: sessionId,
          role: m.role as string,
          type: (m.type as string) ?? 'text',
          content: m.content as string,
          metadata: (m.metadata as string | null) ?? null,
          created_at: (m.created_at as string) ?? new Date().toISOString(),
        })
      )
      // Re-convert AskUserQuestion tool_calls from DB (fallback if server didn't persist)
      const converted = msgs.map(m => {
        if (m.toolName === 'AskUserQuestion' && m.displayType === 'tool_call') {
          return { ...m, displayType: 'ask_user_question' as const, toolStatus: 'done' as const }
        }
        return m
      })
      setMessagesBySession(prev => {
        const existing = prev[sessionId] ?? []
        // Preserve in-memory question cards — the async DB reload runs after
        // the finally-block conversion; replacing messages here would unmount
        // the interactive card and discard user selections.
        if (existing.some(m => m.displayType === 'ask_user_question')) return prev
        return {
          ...prev,
          [sessionId]: converted,
        }
      })
      setSessionMetaMap(prev => ({
        ...prev,
        [sessionId]: {
          oldestCreatedAt: msgs.length > 0 ? msgs[0].timestamp : null,
          totalMessageCount: data.totalMessageCount ?? 0,
        },
      }))
    } catch {
      // silent fail
    } finally {
      loadingSessionsRef.current.delete(sessionId)
    }
  }, [workspaceId])

  useEffect(() => {
    loadSessions()
  }, [loadSessions])

  useEffect(() => {
    if (activeSessionId && sessionsLoaded) {
      // Only load messages if the session actually exists
      if (sessions.some(s => s.id === activeSessionId)) {
        loadSessionMessages(activeSessionId)
      }
    }
  }, [activeSessionId, sessionsLoaded, sessions, loadSessionMessages])

  const applyChunk = useCallback((chunk: Record<string, unknown>) => {
    const type = chunk.type as string | undefined
    const targetSessionId = chunk.sessionId as string

    // Side effects outside state update
    if (type === 'status') {
      setStatus(chunk.status as 'compacting' | 'requesting' | null)
    }
    if (type === 'error') {
      const errMap: Record<string, string> = {
        auth: "认证失败，请检查 API Key",
        rate_limit: "请求过于频繁，请稍后重试",
        timeout: "AI 响应超时",
        unknown: (chunk.message as string) || "未知错误",
      }
      toast.error(errMap[(chunk.code as string)] ?? errMap.unknown)
    }

    // Message updates — target the chunk's session slot
    setMessagesBySession(prev => {
      const sessionMessages = prev[targetSessionId] ?? []
      const updated = applyChunkToSession(sessionMessages, chunk)
      if (updated === sessionMessages) return prev
      return { ...prev, [targetSessionId]: updated }
    })
  }, [])

  const sendMessage = useCallback(async (content: string): Promise<string> => {
    if (streamingSessionIdRef.current) {
      toast.error("请等待当前响应完成")
      return ""
    }

    let sessionId: string | null = activeSessionId

    if (!sessionId) {
      const res = await fetch(`${getServerUrl()}${apiBase}/sessions`, { method: "POST" })
      const session = await res.json()
      sessionId = session.id as string
      const newSession: ChatSession = {
        id: session.id as string,
        workspaceId,
        title: (session.title as string) ?? `会话 ${sessions.length + 1}`,
        messages: [],
        createdAt: (session.created_at as string) ?? new Date().toISOString(),
        updatedAt: (session.updated_at as string) ?? new Date().toISOString(),
        isActive: true,
      }
      setSessions(prev => [...prev, newSession])
      // Immediately notify parent so activeSessionId is set BEFORE the stream
      // starts. Without this, messages written to messagesBySession[sessionId]
      // during the stream are invisible because the UI reads from
      // messagesBySession[activeSessionId ?? ''] and activeSessionId is still null.
      options?.onSessionCreated?.(sessionId)
    }

    const resolvedSessionId = sessionId as string

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      sessionId: resolvedSessionId,
      role: "user",
      displayType: "user",
      content,
      timestamp: new Date().toISOString(),
    }
    setMessagesBySession(prev => ({
      ...prev,
      [resolvedSessionId]: [...(prev[resolvedSessionId] ?? []), userMsg],
    }))

    setStreamingSessionId(resolvedSessionId)
    streamingSessionIdRef.current = resolvedSessionId
    setStatus("requesting")
    setStreamMeta(prev => ({
      ...prev,
      [resolvedSessionId]: { startMs: Date.now(), endState: null },
    }))

    const controller = new AbortController()
    abortRef.current = controller

    let wasAborted = false

    try {
      const res = await fetch(
        `${getServerUrl()}${apiBase}/sessions/${resolvedSessionId}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
          signal: controller.signal,
        }
      )

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: "请求失败" }))
        throw new Error(errData.error ?? "请求失败")
      }

      const reader = res.body?.getReader()
      if (!reader) throw new Error("无法读取响应流")

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

      // Use ref to avoid stale closure — sessions state may not reflect
      // the session we just created inside this callback.
      const session = sessionsRef.current.find(s => s.id === resolvedSessionId)
      if (session && !session.title) {
        fetch(`${getServerUrl()}${apiBase}/sessions/${resolvedSessionId}/generate-title`, { method: "POST" })
          .then(r => r.json())
          .then(d => {
            if (d.title) {
              setSessions(prev => prev.map(s =>
                s.id === resolvedSessionId ? { ...s, title: d.title, updatedAt: new Date().toISOString() } : s
              ))
            }
          })
          .catch(() => {})
      }
      return resolvedSessionId
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        wasAborted = true
        return ""
      }
      toast.error(err instanceof Error ? err.message : "发送消息失败")
      return resolvedSessionId
    } finally {
      setStreamingSessionId(null)
      streamingSessionIdRef.current = null
      setStatus(null)
      setStreamMeta(prev => ({
        ...prev,
        [resolvedSessionId]: {
          ...prev[resolvedSessionId],
          endState: wasAborted ? 'aborted' : 'done',
        },
      }))
      abortRef.current = null
      // Convert pending AskUserQuestion tool_calls to interactive question cards
      if (!wasAborted && resolvedSessionId) {
        setMessagesBySession(prev => {
          const sessionMessages = prev[resolvedSessionId] ?? []
          const transformed = sessionMessages.map(m => {
            if (m.displayType === 'tool_call' && m.toolName === 'AskUserQuestion' && m.toolStatus === 'done') {
              return { ...m, displayType: 'ask_user_question' as const }
            }
            return m
          })
          if (sessionMessages === transformed) return prev
          return { ...prev, [resolvedSessionId]: transformed }
        })
        // Reconcile with DB — ensures slash command output appears immediately
        loadSessionMessages(resolvedSessionId)
      }
    }
  }, [workspaceId, activeSessionId, sessions, applyChunk, apiBase, options?.onSessionCreated])

  const abort = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const createSession = useCallback(async (): Promise<string> => {
    const res = await fetch(`${getServerUrl()}${apiBase}/sessions`, { method: "POST" })
    const session = await res.json()
    const newSession: ChatSession = {
      id: session.id,
      workspaceId,
      title: session.title ?? `会话 ${sessions.length + 1}`,
      messages: [],
      createdAt: session.created_at ?? new Date().toISOString(),
      updatedAt: session.updated_at ?? new Date().toISOString(),
      isActive: true,
    }
    setSessions(prev => [...prev, newSession])
    return session.id as string
  }, [workspaceId, sessions.length])

  const switchSession = useCallback((_sessionId: string) => {
    // Messages are loaded by useEffect when activeSessionId changes
  }, [])

  const loadMoreMessages = useCallback(async () => {
    if (!activeSessionId) return
    const meta = sessionMetaMap[activeSessionId]
    if (!meta?.oldestCreatedAt) return
    try {
      const res = await fetch(`${getServerUrl()}${apiBase}/sessions/${activeSessionId}?limit=100&before=${encodeURIComponent(meta.oldestCreatedAt)}`)
      if (!res.ok) return
      const data = await res.json()
      const olderMsgs: ChatMessage[] = (data.messages ?? []).map((m: Record<string, unknown>) =>
        fromDBMessage({
          id: m.id as string,
          session_id: activeSessionId,
          role: m.role as string,
          type: (m.type as string) ?? 'text',
          content: m.content as string,
          metadata: (m.metadata as string | null) ?? null,
          created_at: (m.created_at as string) ?? new Date().toISOString(),
        })
      )
      setSessionMetaMap(prev => ({
        ...prev,
        [activeSessionId]: {
          ...prev[activeSessionId],
          oldestCreatedAt: olderMsgs.length > 0 ? olderMsgs[0].timestamp : null,
          totalMessageCount: data.totalMessageCount ?? 0,
        },
      }))
      // Deduplicate and prepend
      const existingIds = new Set((messagesBySession[activeSessionId] ?? []).map(m => m.id))
      const newMsgs = olderMsgs.filter(m => !existingIds.has(m.id))
      if (newMsgs.length > 0) {
        setMessagesBySession(prev => ({
          ...prev,
          [activeSessionId]: [...newMsgs, ...(prev[activeSessionId] ?? [])],
        }))
      }
    } catch {
      // silent fail
    }
  }, [activeSessionId, workspaceId, sessionMetaMap, messagesBySession])

  const deleteSession = useCallback((sessionId: string) => {
    fetch(`${getServerUrl()}${apiBase}/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {})
    setSessions(prev => prev.filter(s => s.id !== sessionId))
    setMessagesBySession(prev => {
      const next = { ...prev }
      delete next[sessionId]
      return next
    })
    setSessionMetaMap(prev => {
      const next = { ...prev }
      delete next[sessionId]
      return next
    })
    setStreamMeta(prev => {
      const next = { ...prev }
      delete next[sessionId]
      return next
    })
  }, [workspaceId])

  const renameSession = useCallback((sessionId: string, title: string) => {
    fetch(`${getServerUrl()}${apiBase}/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    }).catch(() => {})
    setSessions(prev => prev.map(s =>
      s.id === sessionId ? { ...s, title, updatedAt: new Date().toISOString() } : s
    ))
  }, [workspaceId])

  return {
    messages,
    sessions,
    isStreaming,
    isCurrentSessionStreaming,
    status,
    streamStartMs,
    streamEndState,
    hasMoreMessages,
    sendMessage,
    abort,
    createSession,
    switchSession,
    deleteSession,
    renameSession,
    loadSessionMessages,
    loadMoreMessages,
  }
}