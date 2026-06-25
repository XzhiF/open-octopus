'use client'

import { useCallback, useRef, useEffect } from 'react'
import type { AgentSSEEvent } from './types'
import type { AgentSSEConnection } from './api'

export interface SSEHandlers {
  onTextDelta?: (content: string) => void
  onThinkingStart?: () => void
  onThinking?: (content: string) => void
  onThinkingDone?: () => void
  onToolCall?: (data: Extract<AgentSSEEvent, { event: 'tool_call' }>['data']) => void
  onStatus?: (data: Extract<AgentSSEEvent, { event: 'status' }>['data']) => void
  onConfirm?: (data: Extract<AgentSSEEvent, { event: 'confirm' }>['data']) => void
  onDone?: (data: Extract<AgentSSEEvent, { event: 'done' }>['data']) => void
  onError?: (data: Extract<AgentSSEEvent, { event: 'error' }>['data']) => void
}

/**
 * Parse SSE text chunk into events.
 * SSE format: "event: <name>\ndata: <json>\n\n"
 */
function parseSSEChunk(chunk: string): Array<{ event: string; data: string }> {
  const events: Array<{ event: string; data: string }> = []
  const lines = chunk.split('\n')
  let currentEvent = ''
  let currentData = ''

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7).trim()
    } else if (line.startsWith('data: ')) {
      currentData = line.slice(6)
    } else if (line === '' && currentEvent && currentData) {
      events.push({ event: currentEvent, data: currentData })
      currentEvent = ''
      currentData = ''
    }
  }

  return events
}

export function useSSEConnection() {
  const connectionRef = useRef<AgentSSEConnection | null>(null)
  const activeRef = useRef(false)

  const connect = useCallback((connection: AgentSSEConnection, handlers: SSEHandlers) => {
    connectionRef.current = connection
    activeRef.current = true

    const processStream = async () => {
      const decoder = new TextDecoder()
      let buffer = ''

      try {
        while (activeRef.current) {
          const { done, value } = await connection.reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })

          // Process complete events from buffer
          const doubleNewlineIdx = buffer.lastIndexOf('\n\n')
          if (doubleNewlineIdx === -1) continue

          const completePart = buffer.slice(0, doubleNewlineIdx + 2)
          buffer = buffer.slice(doubleNewlineIdx + 2)

          const events = parseSSEChunk(completePart)
          for (const evt of events) {
            try {
              const data = JSON.parse(evt.data)
              switch (evt.event) {
                case 'text_delta':
                  handlers.onTextDelta?.(data.delta ?? data.content)
                  break
                case 'thinking_start':
                  handlers.onThinkingStart?.()
                  break
                case 'thinking':
                  handlers.onThinking?.(data.delta ?? data.content)
                  break
                case 'thinking_done':
                  handlers.onThinkingDone?.()
                  break
                case 'tool_call':
                  handlers.onToolCall?.(data)
                  break
                case 'status':
                  handlers.onStatus?.(data)
                  break
                case 'confirm':
                  handlers.onConfirm?.(data)
                  break
                case 'done':
                  handlers.onDone?.(data)
                  activeRef.current = false
                  break
                case 'error':
                  handlers.onError?.(data)
                  activeRef.current = false
                  break
              }
            } catch {
              // Skip malformed JSON
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          handlers.onError?.({ code: 'STREAM_ERROR', message: (err as Error).message })
        }
      } finally {
        connectionRef.current = null
        activeRef.current = false
      }
    }

    processStream()
  }, [])

  const disconnect = useCallback(() => {
    activeRef.current = false
    if (connectionRef.current) {
      connectionRef.current.abort()
      connectionRef.current = null
    }
  }, [])

  useEffect(() => {
    return () => {
      activeRef.current = false
      connectionRef.current?.abort()
    }
  }, [])

  return { connect, disconnect, isConnected: activeRef.current }
}
