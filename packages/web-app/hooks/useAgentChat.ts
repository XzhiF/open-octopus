'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import type { AgentMessage, ToolCallRecord, ContextUsageData } from '@/lib/agent/types'
import * as api from '@/lib/agent/api'
import { useSSEConnection, type SSEHandlers } from '@/lib/agent/sse'

/** Ordered stream timeline (2026-08-19 UX fix): thinking / text / tool items
 *  in ARRIVAL order so the streaming UI can render them interleaved (thinking
 *  shows as in-flow cards like tool calls, not one pinned top block). When the
 *  stream ends, the final message's CollapsibleMeta merges thinking again. */
export type StreamTimelineItem =
  | { kind: 'thinking'; id: string; text: string; active: boolean }
  | { kind: 'text'; id: string; text: string }
  | { kind: 'tool'; id: string }

/** A subagent (expert) to register for a single chat turn — resolved server-side
 *  into the Claude SDK `agents` option so the main agent can invoke it. */
export interface ChatSubagentRef {
  id: string
  label?: string
}

export interface UseAgentChatApiOverride {
  /** Load session messages. Returns { messages: PaginatedResponse<AgentMessage> } */
  getSession?: (id: string, query?: { limit?: number; cursor?: string }) => Promise<{
    session: import('@/lib/agent/types').AgentSession
    messages: import('@/lib/agent/types').PaginatedResponse<import('@/lib/agent/types').AgentMessage>
  }>
  /** Create SSE stream for chat. Returns { reader, abort } */
  chatStream?: (id: string, message: string, opts?: { debug?: boolean; delegate_to?: string; model?: string; subagents?: ChatSubagentRef[] }) => import('@/lib/agent/api').AgentSSEConnection
  /** Stop an in-progress chat stream */
  stopChat?: (id: string) => Promise<unknown>
  /** Probe whether the session has an in-flight server-side turn (clone chat
   *  stream-resume). When present, the hook auto-resumes on mount: reopening
   *  a dialog that was closed mid-generation shows the growing reply (via
   *  message polling) instead of a dead transcript. Absent (main agent
   *  ChatTab) → behavior is byte-identical to before. */
  checkRunning?: (id: string) => Promise<{ running: boolean; partial: boolean }>
}

export function useAgentChat(sessionId: string | null, options?: { onTitleUpdate?: (sessionId: string, title: string) => void; api?: UseAgentChatApiOverride }) {
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [streamContent, setStreamContent] = useState('')
  const [streamThinking, setStreamThinking] = useState('')
  const [isThinking, setIsThinking] = useState(false)
  const [toolCalls, setToolCalls] = useState<ToolCallRecord[]>([])
  // Arrival-ordered timeline for interleaved streaming render (see type above).
  const [streamTimeline, setStreamTimeline] = useState<StreamTimelineItem[]>([])
  const timelineRef = useRef<StreamTimelineItem[]>([])
  const [pendingConfirm, setPendingConfirm] = useState<{
    event_id: string
    type: 'dangerous_command' | 'evolution_major'
    operation: string
    detail: string
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState('')
  // Context window usage breakdown (from SDK getContextUsage via SSE context_usage event).
  // Updated at the start of each assistant turn (after message_start).
  // Persisted in sessionStorage keyed by sessionId so reopening the dialog
  // restores the last known token count without needing to send a message.
  const [contextUsage, setContextUsageRaw] = useState<ContextUsageData | null>(() => {
    if (!sessionId) return null
    try {
      const saved = sessionStorage.getItem(`context-usage:${sessionId}`)
      return saved ? JSON.parse(saved) : null
    } catch { return null }
  })
  const setContextUsage = useCallback((data: ContextUsageData | null) => {
    setContextUsageRaw(data)
    if (sessionId && data) {
      try { sessionStorage.setItem(`context-usage:${sessionId}`, JSON.stringify(data)) } catch { /* quota */ }
    } else if (sessionId && !data) {
      try { sessionStorage.removeItem(`context-usage:${sessionId}`) } catch { /* ignore */ }
    }
  }, [sessionId])
  const { connect, disconnect } = useSSEConnection()
  const streamContentRef = useRef('')
  const streamThinkingRef = useRef('')
  const toolCallsRef = useRef<ToolCallRecord[]>([])
  const streamingRef = useRef(false)
  // Track the session that initiated the current stream to prevent cross-session contamination
  const streamingSessionRef = useRef<string | null>(null)
  // ── Resume-polling state (clone chat stream-resume, "关闭不丢失") ──
  // This hook instance does NOT own the SSE stream — it is tailing a
  // server-side turn that outlived a dialog close (the client aborted the
  // connection, but disconnect ≠ stop on the server). resumeStreaming is
  // exposed for UIs that want a distinct banner; streaming=true is reused so
  // the existing send-guard/input-disable applies automatically.
  const [resumeStreaming, setResumeStreaming] = useState(false)
  const resumePollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const resumeModeRef = useRef(false)
  // Ref-based callback for title updates (avoids recreating sendMessage on every render)
  const onTitleUpdateRef = useRef(options?.onTitleUpdate)
  onTitleUpdateRef.current = options?.onTitleUpdate
  // Ref-based API overrides (avoids recreating callbacks when overrides change identity)
  const apiOverrideRef = useRef(options?.api)
  apiOverrideRef.current = options?.api

  // Abort any in-flight stream when session changes
  useEffect(() => {
    return () => {
      disconnect()
      streamingRef.current = false
      streamingSessionRef.current = null
      // Resume-poll is ref-based so the cleanup can clear it without taking
      // stopResumePolling in the dep array (TDZ-safe; runs only on unmount).
      if (resumePollRef.current) { clearInterval(resumePollRef.current); resumePollRef.current = null }
      resumeModeRef.current = false
    }
  }, [disconnect])

  // When sessionId changes while streaming, abort the old stream.
  // Also restore contextUsage from sessionStorage for the new session (so the
  // status bar shows the last known token count without a fresh message).
  useEffect(() => {
    if (streamingSessionRef.current && streamingSessionRef.current !== sessionId) {
      disconnect()
      setStreaming(false)
      streamingRef.current = false
      streamingSessionRef.current = null
      // Leaving a session mid-resume → its poll belongs to the past now.
      if (resumePollRef.current) { clearInterval(resumePollRef.current); resumePollRef.current = null }
      resumeModeRef.current = false
      setResumeStreaming(false)
    }
    // Restore contextUsage for the new session (or null if no cached value).
    if (sessionId) {
      try {
        const saved = sessionStorage.getItem(`context-usage:${sessionId}`)
        setContextUsageRaw(saved ? JSON.parse(saved) : null)
      } catch { setContextUsageRaw(null) }
    } else {
      setContextUsageRaw(null)
    }
  }, [sessionId, disconnect])

  const loadMessages = useCallback(async () => {
    if (!sessionId) return
    try {
      const getSessionFn = apiOverrideRef.current?.getSession ?? api.getSession
      const res = await getSessionFn(sessionId, { limit: 50 })
      setMessages(res.messages.items)
    } catch {
      setError('Failed to load messages')
    }
  }, [sessionId])

  const stopResumePolling = useCallback(() => {
    if (resumePollRef.current) { clearInterval(resumePollRef.current); resumePollRef.current = null }
    resumeModeRef.current = false
    setResumeStreaming(false)
  }, [])

  // "关闭不丢失" stream-resume — tail a server-side turn this instance holds
  // no SSE connection for. The clone chat route persists a growing assistant
  // partial (metadata.streaming) every ~1s, so polling the messages endpoint
  // at 1.5s shows the reply advancing near-real-time; when the probe reports
  // running=false, one last poll brings the finalized row and we exit.
  // Declared BEFORE sendMessage so the 409 branch can reference it.
  const startResumePolling = useCallback((sid: string) => {
    if (resumePollRef.current) return // already tailing
    const checkRunningFn = apiOverrideRef.current?.checkRunning
    if (!checkRunningFn) return

    resumeModeRef.current = true
    setResumeStreaming(true)
    streamingSessionRef.current = sid
    streamingRef.current = true
    setStreaming(true) // reuses the send-guard: input disabled + stop button

    const tick = async () => {
      try {
        await loadMessages()
        const r = await checkRunningFn(sid)
        if (!r.running) {
          // The route finalizes the row BEFORE unregistering the stream, so
          // running=false guarantees the finalized content is on this fetch.
          await loadMessages()
          stopResumePolling()
          setStreaming(false)
          streamingRef.current = false
          streamingSessionRef.current = null
          setStreamContent('')
          setStreamThinking('')
          setIsThinking(false)
          setToolCalls([])
          setStreamTimeline([])
          timelineRef.current = []
          setStatusMessage('')
        }
      } catch {
        // Transient network hiccup — keep polling; the server turn is alive.
      }
    }
    void tick()
    resumePollRef.current = setInterval(tick, 1500)
  }, [loadMessages, stopResumePolling])

  // On (re)mount / session switch: if a turn is still generating server-side
  // and this instance doesn't own the live stream, resume automatically.
  useEffect(() => {
    if (!sessionId) return
    if (!apiOverrideRef.current?.checkRunning) return
    if (streamingSessionRef.current === sessionId) return // our own live SSE stream
    let alive = true
    apiOverrideRef.current.checkRunning(sessionId)
      .then((r) => { if (alive && r.running) startResumePolling(sessionId) })
      .catch(() => { /* server offline — the normal error path covers it */ })
    return () => { alive = false }
  }, [sessionId, startResumePolling])

  const sendMessage = useCallback(async (message: string, opts?: { delegate_to?: string; model?: string; subagents?: ChatSubagentRef[] }) => {
    if (!sessionId || !message.trim()) return
    // Guard: block if already streaming
    if (streamingRef.current) return

    // Abort any lingering stream from a previous session
    if (streamingSessionRef.current && streamingSessionRef.current !== sessionId) {
      disconnect()
    }

    // Capture the session that owns this stream
    streamingSessionRef.current = sessionId

    // Optimistic: add user message (preserve original @@syntax for display)
    const userMsg: AgentMessage = {
      id: `temp-${Date.now()}`,
      session_id: sessionId,
      role: 'user',
      content: message,
      created_at: new Date().toISOString(),
      is_summary: false,
      is_compressed: false,
      is_edited: false,
    }
    setMessages(prev => [...prev, userMsg])
    setStreaming(true)
    streamingRef.current = true
    setStreamContent('')
    setStreamThinking('')
    setIsThinking(false)
    setToolCalls([])
    setError(null)
    setStatusMessage('')
    // contextUsage: NOT reset here — preserve the last known value so the
    // status bar stays populated between sends (and across dialog reopens).
    // The new value arrives via onContextUsage SSE handler during the stream.
    streamContentRef.current = ''
    streamThinkingRef.current = ''
    toolCallsRef.current = []
    timelineRef.current = []
    setStreamTimeline([])

    const chatStreamFn = apiOverrideRef.current?.chatStream ?? api.chatStream
    const source = chatStreamFn(sessionId, message, {
      delegate_to: opts?.delegate_to,
      model: opts?.model,
      subagents: opts?.subagents,
    })

    const handlers: SSEHandlers = {
      onContextUsage: (data) => {
        setContextUsage(data)
      },
      onTextDelta: (content) => {
        streamContentRef.current += content
        setStreamContent(streamContentRef.current)
        // Timeline: extend the open text segment, or open a new one when the
        // model switched back from thinking/tool to text.
        const tl = timelineRef.current
        const last = tl[tl.length - 1]
        if (last && last.kind === 'text') {
          tl[tl.length - 1] = { ...last, text: last.text + content }
        } else {
          tl.push({ kind: 'text', id: `tx-${Date.now()}`, text: content })
        }
        setStreamTimeline([...tl])
      },
      onThinkingStart: () => {
        setIsThinking(true)
        // Close any still-active thinking segment, then open a fresh one so
        // alternating think/text phases render as separate cards.
        const tl = timelineRef.current
        for (let i = tl.length - 1; i >= 0; i--) {
          const it = tl[i]
          if (it.kind === 'thinking' && it.active) tl[i] = { ...it, active: false }
        }
        tl.push({ kind: 'thinking', id: `th-${Date.now()}-${tl.length}`, text: '', active: true })
        setStreamTimeline([...tl])
      },
      onThinking: (content) => {
        streamThinkingRef.current += content
        setStreamThinking(streamThinkingRef.current)
        const tl = timelineRef.current
        const last = tl[tl.length - 1]
        if (last && last.kind === 'thinking') {
          tl[tl.length - 1] = { ...last, text: last.text + content, active: true }
        } else {
          // Thinking delta without a start event (provider variance) — open one.
          tl.push({ kind: 'thinking', id: `th-${Date.now()}-${tl.length}`, text: content, active: true })
        }
        setStreamTimeline([...tl])
      },
      onThinkingDone: () => {
        setIsThinking(false)
        const tl = timelineRef.current
        const last = tl[tl.length - 1]
        if (last && last.kind === 'thinking') {
          tl[tl.length - 1] = { ...last, active: false }
          setStreamTimeline([...tl])
        }
      },
      onToolCall: (data) => {
        const isResult = data.type === 'result'
        const id = data.id ?? data.tool_call_id
        const name = data.name ?? data.tool_name
        const now = Date.now()

        // Ref is the source of truth (events arrive sequentially) — compute
        // next OUTSIDE setState so the timeline push happens exactly once per
        // new tool call (a side effect inside a setState updater could double-
        // fire under StrictMode).
        const prev = toolCallsRef.current
        let next: ToolCallRecord[]
        let newId: string | null = null
        if (id) {
          const existing = prev.findIndex(tc => tc.id === id)
          if (existing >= 0) {
            const updated = [...prev]
            updated[existing] = {
              ...updated[existing],
              status: data.status ?? data.type ?? updated[existing].status,
              result: data.result ?? data.content,
              input: data.input ?? updated[existing].input,
              ...(isResult ? { ended_at: now } : {}),
            }
            next = updated
          } else if (isResult) {
            next = prev
          } else {
            newId = id
            next = [...prev, { id, name: name ?? 'unknown', input: data.input, status: data.status ?? data.type ?? 'start', result: data.result, started_at: now }]
          }
        } else if (isResult) {
          next = prev
        } else {
          newId = `tc-${name ?? 'tool'}-${now}`
          next = [...prev, { id: newId, name: name ?? 'unknown', input: data.input, status: data.status ?? data.type ?? 'start', result: data.result, started_at: now }]
        }
        toolCallsRef.current = next
        setToolCalls(next)

        // First sight of this tool call → pin its position in the timeline.
        if (newId) {
          timelineRef.current = [...timelineRef.current, { kind: 'tool', id: newId }]
          setStreamTimeline(timelineRef.current)
        }
      },
      onAskUserQuestion: (data) => {
        // AskUserQuestion 显式标记（interactionSession 拦截后 server 发出）：
        // 保证 toolCalls 里有带 questions input 的记录 —— content_block 事件
        // 缺失/乱序时的唯一兜底。id 命中既有记录则只补 input，不重复建条目。
        const id = data.tool_call_id
        const prev = toolCallsRef.current
        const idx = prev.findIndex((tc) => tc.id === id)
        let next: ToolCallRecord[]
        let newId: string | null = null
        if (idx >= 0) {
          if (prev[idx].input) return
          next = [...prev]
          next[idx] = { ...prev[idx], input: data.questions }
        } else {
          newId = id
          next = [...prev, {
            id, name: 'AskUserQuestion', input: data.questions,
            status: 'start', started_at: Date.now(),
          }]
        }
        toolCallsRef.current = next
        setToolCalls(next)
        if (newId) {
          timelineRef.current = [...timelineRef.current, { kind: 'tool', id: newId }]
          setStreamTimeline(timelineRef.current)
        }
      },
      onStatus: (data) => {
        setStatusMessage(data.message)
      },
      onConfirm: (data) => {
        setPendingConfirm(data)
      },
      onDone: (data) => {
        // Guard against cross-session contamination: only process if session matches
        if (data.session_id !== streamingSessionRef.current) return

        const finalToolCalls = toolCallsRef.current.length > 0 ? [...toolCallsRef.current] : undefined
        // Persistable timeline (chronological process for the completed
        // message's collapsible meta) — strip streaming-only fields.
        const finalTimeline = timelineRef.current.length > 0
          ? timelineRef.current.map((it) =>
              it.kind === 'tool'
                ? { kind: 'tool' as const, id: it.id }
                : { kind: it.kind, text: it.text })
          : undefined
        const assistantMsg: AgentMessage = {
          id: data.message_id,
          session_id: data.session_id,
          role: 'assistant',
          content: streamContentRef.current,
          tool_calls: finalToolCalls,
          thinking: streamThinkingRef.current || undefined,
          timeline: finalTimeline,
          created_at: new Date().toISOString(),
          is_summary: false,
          is_compressed: false,
          is_edited: false,
        }
        setMessages(prev => [...prev, assistantMsg])
        setStreaming(false)
        streamingRef.current = false
        streamingSessionRef.current = null
        setStreamContent('')
        setStreamThinking('')
        setIsThinking(false)
        setToolCalls([])
        setStreamTimeline([])
        timelineRef.current = []
        setStatusMessage('')
        // Propagate auto-generated session title to sidebar
        if (data.session_title) {
          onTitleUpdateRef.current?.(data.session_id, data.session_title)
        }
      },
      onError: (data) => {
        // 409 from the server concurrency guard — the previous turn is still
        // generating (typical: user closed the dialog mid-stream, reopened,
        // and resent). Don't surface an error: drop the (never-persisted)
        // optimistic send and tail the live turn instead.
        if (data.code === 'STREAM_IN_PROGRESS' && apiOverrideRef.current?.checkRunning) {
          startResumePolling(sessionId)
          return
        }
        setError(data.message)
        setStreaming(false)
        streamingRef.current = false
        streamingSessionRef.current = null
      },
    }

    connect(source, handlers)
  }, [sessionId, connect, setContextUsage, startResumePolling])

  const stopGenerate = useCallback(async () => {
    if (!sessionId) return

    // Wrap in try/finally so partial content is ALWAYS preserved — even if
    // the stop API call fails, the user sees what the agent produced so far.
    try {
      const stopChatFn = apiOverrideRef.current?.stopChat ?? api.stopChat
      await stopChatFn(sessionId)
    } catch {
      // Server-side abort failed (network error, 500, etc.) — that's OK,
      // we still disconnect locally and save the partial message.
    }

    // Resume mode: no local SSE stream and no in-memory partial — the server
    // owns the turn (its route persists the interrupted row on abort). The
    // running poll brings the finalized row back and exits on its own; keep
    // streaming=true so input stays disabled until then.
    if (resumeModeRef.current) return

    disconnect()
    setStreaming(false)
    streamingRef.current = false
    streamingSessionRef.current = null

    // Preserve ANY content the agent produced before the abort — text,
    // tool calls, or thinking. Previously only text was saved; tool calls
    // and thinking silently vanished.
    const partialText = streamContentRef.current
    // Mark non-terminal tool calls as 'fail' — otherwise they keep spinning
    // (Loader2 icon) indefinitely because no result event will arrive.
    // Also set `ended_at` so the elapsed timer stops counting.
    const stopNow = Date.now()
    const partialTools = toolCallsRef.current.length > 0
      ? toolCallsRef.current.map((tc) => {
          const terminal = tc.status === 'success' || tc.status === 'result' || tc.status === 'fail'
          return terminal ? tc : { ...tc, status: 'fail' as const, ended_at: stopNow }
        })
      : undefined
    const partialThinking = streamThinkingRef.current || undefined
    const partialTimeline = timelineRef.current.length > 0
      ? timelineRef.current.map((it) =>
          it.kind === 'tool'
            ? { kind: 'tool' as const, id: it.id }
            : { kind: it.kind, text: it.text })
      : undefined

    const hasAnyContent = partialText || partialTools || partialThinking

    if (hasAnyContent) {
      const partialMsg: AgentMessage = {
        id: `partial-${Date.now()}`,
        session_id: sessionId,
        role: 'assistant',
        content: partialText,
        tool_calls: partialTools,
        thinking: partialThinking,
        timeline: partialTimeline,
        created_at: new Date().toISOString(),
        is_summary: false,
        is_compressed: false,
        is_edited: false,
        interrupted: true,
      }
      setMessages(prev => [...prev, partialMsg])
    }

    // Clear streaming state
    setStreamContent('')
    setStreamThinking('')
    setIsThinking(false)
    setToolCalls([])
    setStreamTimeline([])
    timelineRef.current = []
    streamContentRef.current = ''
    streamThinkingRef.current = ''
    toolCallsRef.current = []
    setStatusMessage('')
  }, [sessionId, disconnect])

  const handleConfirm = useCallback(async (eventId: string, decision: 'accept' | 'reject') => {
    try {
      await api.confirmSafety(eventId, decision)
      setPendingConfirm(null)
    } catch {
      setError('Failed to send confirmation')
    }
  }, [])

  return {
    messages,
    streaming,
    /** True while tailing a server-side turn after a dialog close
     *  (stream-resume). `streaming` is also true in this mode. */
    resumeStreaming,
    streamContent,
    streamThinking,
    streamTimeline,
    isThinking,
    toolCalls,
    pendingConfirm,
    error,
    statusMessage,
    contextUsage,
    sendMessage,
    stopGenerate,
    handleConfirm,
    loadMessages,
  }
}
