'use client'

import { useState, useCallback, useRef } from 'react'
import type { AgentMessage, ToolCallRecord } from '@/lib/agent/types'
import * as api from '@/lib/agent/api'
import { useSSEConnection, type SSEHandlers } from '@/lib/agent/sse'

export function useAgentChat(sessionId: string | null, options?: { onTitleUpdate?: (sessionId: string, title: string) => void }) {
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [streamContent, setStreamContent] = useState('')
  const [streamThinking, setStreamThinking] = useState('')
  const [isThinking, setIsThinking] = useState(false)
  const [toolCalls, setToolCalls] = useState<ToolCallRecord[]>([])
  const [pendingConfirm, setPendingConfirm] = useState<{
    event_id: string
    type: 'dangerous_command' | 'evolution_major'
    operation: string
    detail: string
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState('')
  const { connect, disconnect } = useSSEConnection()
  const streamContentRef = useRef('')
  const streamThinkingRef = useRef('')
  const toolCallsRef = useRef<ToolCallRecord[]>([])
  // Ref-based callback for title updates (avoids recreating sendMessage on every render)
  const onTitleUpdateRef = useRef(options?.onTitleUpdate)
  onTitleUpdateRef.current = options?.onTitleUpdate

  const loadMessages = useCallback(async () => {
    if (!sessionId) return
    try {
      const res = await api.getSession(sessionId, { limit: 50 })
      setMessages(res.messages.items)
    } catch {
      setError('Failed to load messages')
    }
  }, [sessionId])

  const sendMessage = useCallback(async (message: string) => {
    if (!sessionId || !message.trim()) return

    // Optimistic: add user message
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
    setStreamContent('')
    setStreamThinking('')
    setIsThinking(false)
    setToolCalls([])
    setError(null)
    setStatusMessage('')
    streamContentRef.current = ''
    streamThinkingRef.current = ''
    toolCallsRef.current = []

    const source = api.chatStream(sessionId, message)

    const handlers: SSEHandlers = {
      onTextDelta: (content) => {
        streamContentRef.current += content
        setStreamContent(streamContentRef.current)
      },
      onThinkingStart: () => {
        setIsThinking(true)
      },
      onThinking: (content) => {
        streamThinkingRef.current += content
        setStreamThinking(streamThinkingRef.current)
      },
      onThinkingDone: () => {
        setIsThinking(false)
      },
      onToolCall: (data) => {
        const isResult = data.type === 'result'
        const id = data.id ?? data.tool_call_id
        const name = data.name ?? data.tool_name
        const now = Date.now()

        setToolCalls(prev => {
          let next: ToolCallRecord[]
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
              next = [...prev, { id, name: name ?? 'unknown', input: data.input, status: data.status ?? data.type ?? 'start', result: data.result, started_at: now }]
            }
          } else if (isResult) {
            next = prev
          } else {
            next = [...prev, { id: `tc-${name ?? 'tool'}-${now}`, name: name ?? 'unknown', input: data.input, status: data.status ?? data.type ?? 'start', result: data.result, started_at: now }]
          }
          toolCallsRef.current = next
          return next
        })
      },
      onStatus: (data) => {
        setStatusMessage(data.message)
      },
      onConfirm: (data) => {
        setPendingConfirm(data)
      },
      onDone: (data) => {
        const finalToolCalls = toolCallsRef.current.length > 0 ? [...toolCallsRef.current] : undefined
        const assistantMsg: AgentMessage = {
          id: data.message_id,
          session_id: data.session_id,
          role: 'assistant',
          content: streamContentRef.current,
          tool_calls: finalToolCalls,
          thinking: streamThinkingRef.current || undefined,
          created_at: new Date().toISOString(),
          is_summary: false,
          is_compressed: false,
          is_edited: false,
        }
        setMessages(prev => [...prev, assistantMsg])
        setStreaming(false)
        setStreamContent('')
        setStreamThinking('')
        setIsThinking(false)
        setToolCalls([])
        setStatusMessage('')
        // Propagate auto-generated session title to sidebar
        if (data.session_title) {
          onTitleUpdateRef.current?.(data.session_id, data.session_title)
        }
      },
      onError: (data) => {
        setError(data.message)
        setStreaming(false)
      },
    }

    connect(source, handlers)
  }, [sessionId, connect])

  const stopGenerate = useCallback(async () => {
    if (!sessionId) return
    try {
      await api.stopChat(sessionId)
      disconnect()
      setStreaming(false)
      if (streamContentRef.current) {
        const partialMsg: AgentMessage = {
          id: `partial-${Date.now()}`,
          session_id: sessionId,
          role: 'assistant',
          content: streamContentRef.current + '\n\n*[已停止生成]*',
          created_at: new Date().toISOString(),
          is_summary: false,
          is_compressed: false,
          is_edited: false,
        }
        setMessages(prev => [...prev, partialMsg])
      }
      setStreamContent('')
    } catch {
      setError('Failed to stop generation')
    }
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
    streamContent,
    streamThinking,
    isThinking,
    toolCalls,
    pendingConfirm,
    error,
    statusMessage,
    sendMessage,
    stopGenerate,
    handleConfirm,
    loadMessages,
  }
}
