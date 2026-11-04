'use client'

import { useCallback, useRef, useEffect } from 'react'
import type { AgentSSEEvent } from './types'
import type { AgentSSEConnection, BackgroundTaskInfo } from './api'

export interface SSEHandlers {
  onTextDelta?: (content: string) => void
  onThinkingStart?: () => void
  onThinking?: (content: string) => void
  onThinkingDone?: () => void
  onToolCall?: (data: Extract<AgentSSEEvent, { event: 'tool_call' }>['data']) => void
  /** AskUserQuestion 显式标记（server interactionSession 拦截后发出）。 */
  onAskUserQuestion?: (data: Extract<AgentSSEEvent, { event: 'ask_user_question' }>['data']) => void
  onStatus?: (data: Extract<AgentSSEEvent, { event: 'status' }>['data']) => void
  /** 后台任务电平（REPLACE 语义）：非空 = 本轮正在等后台任务。 */
  onBackgroundTasks?: (data: { tasks: BackgroundTaskInfo[] }) => void
  /** 后台任务唤醒的续轮开始（首轮 result 后又来一段正文）。 */
  onAssistantContinue?: (data: { separator?: string }) => void
  onConfirm?: (data: Extract<AgentSSEEvent, { event: 'confirm' }>['data']) => void
  onContextUsage?: (data: import('@/lib/agent/types').ContextUsageData) => void
  /** Slash commands advertised by the CLI — replace the composer's list. */
  onSlashCommands?: (data: Extract<AgentSSEEvent, { event: 'slash_commands' }>['data']) => void
  /** 2026-10-28 task-thread: a task turn landed a [quick-edit] commit. */
  onQuickEditCommit?: (data: {
    sessionId?: string
    taskId?: string
    repo: string
    branch: string
    commit: string
    message: string
  }) => void
  /** Keep-alive frame — only refreshes the stall watchdog. */
  onHeartbeat?: () => void
  onDone?: (data: Extract<AgentSSEEvent, { event: 'done' }>['data']) => void
  onError?: (data: Extract<AgentSSEEvent, { event: 'error' }>['data']) => void
}

export interface SSEConnectionOptions {
  /** 多久没有任何事件就判定流已死。默认 5min —— 只有确实静默的死流才该触发；
   *  服务端每 15s 发 heartbeat 的通道（主对话）可由调用方降到 60s。 */
  stallMs?: number
  /** 看门狗检查间隔。默认 5s。测试可调小。 */
  watchdogIntervalMs?: number
}

const DEFAULT_STALL_MS = 300_000
const DEFAULT_WATCHDOG_INTERVAL_MS = 5_000

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

export function useSSEConnection(options?: SSEConnectionOptions) {
  const connectionRef = useRef<AgentSSEConnection | null>(null)
  const activeRef = useRef(false)
  // Options live in a ref so `connect` keeps a stable identity for callers
  // (useAgentChat puts it in a useCallback dependency list).
  const optionsRef = useRef(options)
  optionsRef.current = options

  const connect = useCallback((connection: AgentSSEConnection, handlers: SSEHandlers) => {
    connectionRef.current = connection
    activeRef.current = true

    const stallMs = optionsRef.current?.stallMs ?? DEFAULT_STALL_MS
    const watchdogIntervalMs = optionsRef.current?.watchdogIntervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS
    // A turn is over only once the server says so. Anything else (silent EOF,
    // an idle socket, a crashed server) must settle as an error — otherwise the
    // composer stays `streaming` forever with no way back. 2026-11-01.
    let sawTerminal = false
    let lastEventAt = Date.now()
    let watchdog: ReturnType<typeof setInterval> | undefined

    const settle = (code: string, message: string) => {
      if (sawTerminal) return
      sawTerminal = true
      activeRef.current = false
      handlers.onError?.({ code, message })
    }

    const processStream = async () => {
      const decoder = new TextDecoder()
      let buffer = ''

      watchdog = setInterval(() => {
        if (!activeRef.current || sawTerminal) return
        if (Date.now() - lastEventAt < stallMs) return
        // Abort the transport first, then settle — the abort's rejection is
        // ignored in the catch below because `sawTerminal` is already true.
        try { connection.abort() } catch { /* already closed */ }
        settle('STREAM_STALL', `超过 ${Math.round(stallMs / 1000)}s 没有收到任何事件`)
      }, watchdogIntervalMs)
      ;(watchdog as unknown as { unref?: () => void }).unref?.()

      try {
        while (activeRef.current) {
          const { done, value } = await connection.reader.read()
          if (done) break
          // Any bytes at all mean the transport is alive (chunks may hold
          // several events, and heartbeat frames are events too).
          lastEventAt = Date.now()

          buffer += decoder.decode(value, { stream: true })

          // Process complete events from buffer
          const doubleNewlineIdx = buffer.lastIndexOf('\n\n')
          if (doubleNewlineIdx === -1) continue

          const completePart = buffer.slice(0, doubleNewlineIdx + 2)
          buffer = buffer.slice(doubleNewlineIdx + 2)

          const events = parseSSEChunk(completePart)
          for (const evt of events) {
            lastEventAt = Date.now()
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
                case 'context_usage':
                  handlers.onContextUsage?.(data)
                  break
                case 'slash_commands':
                  handlers.onSlashCommands?.(data)
                  break
                case 'tool_call':
                  handlers.onToolCall?.(data)
                  break
                case 'ask_user_question':
                  handlers.onAskUserQuestion?.(data)
                  break
                case 'status':
                  handlers.onStatus?.(data)
                  break
                case 'background_tasks':
                  handlers.onBackgroundTasks?.(data)
                  break
                case 'assistant_continue':
                  handlers.onAssistantContinue?.(data)
                  break
                case 'confirm':
                  handlers.onConfirm?.(data)
                  break
                case 'quick_edit_commit':
                  handlers.onQuickEditCommit?.(data)
                  break
                case 'heartbeat':
                  handlers.onHeartbeat?.()
                  break
                case 'done':
                  sawTerminal = true
                  handlers.onDone?.(data)
                  activeRef.current = false
                  break
                case 'error':
                  sawTerminal = true
                  handlers.onError?.(data)
                  activeRef.current = false
                  break
              }
            } catch {
              // Skip malformed JSON
            }
          }
        }

        // EOF without a terminal frame: the server (or a proxy) closed the
        // socket mid-turn. Settle instead of leaving the UI spinning.
        if (activeRef.current && !sawTerminal) {
          settle('STREAM_EOF', '连接已结束，但服务端未发送结束帧')
        }
      } catch (err) {
        const e = err as Error & { code?: string }
        if (e.name !== 'AbortError' && !sawTerminal) {
          // Pass through the server's structured code when the transport
          // layer attached one (e.g. STREAM_IN_PROGRESS from the 409 guard) —
          // callers branch on it (resume-polling instead of a dead error).
          sawTerminal = true
          handlers.onError?.({ code: e.code ?? 'STREAM_ERROR', message: e.message })
        }
      } finally {
        if (watchdog) clearInterval(watchdog)
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
