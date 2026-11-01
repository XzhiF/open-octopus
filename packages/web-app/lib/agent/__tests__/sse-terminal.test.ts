// packages/web-app/lib/agent/__tests__/sse-terminal.test.ts
//
// P0-1 契约（2026-11-01）：一条对话流只有收到 `done` 或 `error` 才算回合结束。
// 静默 EOF / 长时间无事件必须降级为错误，否则 composer 会永远停在 streaming。
// 主动 disconnect（切会话、关闭弹窗）不是错误，不得触发 onError。

import { describe, it, expect, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useSSEConnection } from '../sse'
import type { AgentSSEConnection } from '../api'

function abortError(): Error {
  const e = new Error('aborted')
  e.name = 'AbortError'
  return e
}

/** Controllable SSE transport: push()/end() satisfy the pending read(). */
function makeConnection() {
  let resolveNext: ((r: ReadableStreamReadResult<Uint8Array>) => void) | null = null
  let rejectNext: ((e: unknown) => void) | null = null
  let aborted = false
  const reader = {
    read: () => new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
      if (aborted) { reject(abortError()); return }
      resolveNext = resolve
      rejectNext = reject
    }),
  }
  const abort = vi.fn(() => {
    aborted = true
    rejectNext?.(abortError())
    rejectNext = null
  })
  const connection = { reader, abort } as unknown as AgentSSEConnection
  return {
    connection,
    abort,
    push(text: string) {
      const resolve = resolveNext
      resolveNext = null
      resolve?.({ done: false, value: new TextEncoder().encode(text) })
    },
    end() {
      const resolve = resolveNext
      resolveNext = null
      resolve?.({ done: true, value: undefined })
    },
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('useSSEConnection terminal guarantee', () => {
  it('silent EOF settles as STREAM_EOF instead of leaving the turn open', async () => {
    const handlers = { onError: vi.fn(), onDone: vi.fn() }
    const { result } = renderHook(() => useSSEConnection({ stallMs: 5_000, watchdogIntervalMs: 50 }))
    const conn = makeConnection()

    act(() => { result.current.connect(conn.connection, handlers) })
    act(() => { conn.end() })

    await waitFor(() => expect(handlers.onError).toHaveBeenCalledTimes(1))
    expect(handlers.onError.mock.calls[0][0].code).toBe('STREAM_EOF')
    expect(handlers.onDone).not.toHaveBeenCalled()
  })

  it('an idle socket settles as STREAM_STALL and aborts the transport', async () => {
    const handlers = { onError: vi.fn(), onDone: vi.fn() }
    const { result } = renderHook(() => useSSEConnection({ stallMs: 60, watchdogIntervalMs: 10 }))
    const conn = makeConnection()

    act(() => { result.current.connect(conn.connection, handlers) })

    await waitFor(() => expect(handlers.onError).toHaveBeenCalledTimes(1), { timeout: 2_000 })
    expect(handlers.onError.mock.calls[0][0].code).toBe('STREAM_STALL')
    expect(conn.abort).toHaveBeenCalled()
  })

  it('a done frame is terminal — no EOF error follows', async () => {
    const handlers = { onError: vi.fn(), onDone: vi.fn() }
    const { result } = renderHook(() => useSSEConnection({ stallMs: 5_000, watchdogIntervalMs: 50 }))
    const conn = makeConnection()

    act(() => { result.current.connect(conn.connection, handlers) })
    act(() => { conn.push(`event: done\ndata: ${JSON.stringify({ session_id: 's-1' })}\n\n`) })
    act(() => { conn.end() })

    await waitFor(() => expect(handlers.onDone).toHaveBeenCalledTimes(1))
    expect(handlers.onError).not.toHaveBeenCalled()
  })

  it('disconnect() is not an error (switching sessions/closing a dialog)', async () => {
    const handlers = { onError: vi.fn(), onDone: vi.fn() }
    const { result } = renderHook(() => useSSEConnection({ stallMs: 5_000, watchdogIntervalMs: 20 }))
    const conn = makeConnection()

    act(() => { result.current.connect(conn.connection, handlers) })
    act(() => { result.current.disconnect() })

    await sleep(80)
    expect(handlers.onError).not.toHaveBeenCalled()
    expect(handlers.onDone).not.toHaveBeenCalled()
  })

  it('heartbeat frames keep a long turn alive past the stall threshold', async () => {
    const handlers = { onError: vi.fn(), onDone: vi.fn(), onHeartbeat: vi.fn() }
    const { result } = renderHook(() => useSSEConnection({ stallMs: 120, watchdogIntervalMs: 10 }))
    const conn = makeConnection()

    act(() => { result.current.connect(conn.connection, handlers) })
    // 5 beats over ~150ms — well past the 120ms stall budget.
    for (let i = 0; i < 5; i++) {
      await sleep(30)
      act(() => { conn.push(`event: heartbeat\ndata: ${JSON.stringify({ ts: String(i) })}\n\n`) })
    }
    await sleep(10) // let the reader re-arm before the terminal frame
    act(() => { conn.push(`event: done\ndata: ${JSON.stringify({ session_id: 's-1' })}\n\n`) })

    await waitFor(() => expect(handlers.onDone).toHaveBeenCalledTimes(1))
    expect(handlers.onHeartbeat).toHaveBeenCalled()
    expect(handlers.onError).not.toHaveBeenCalled()
  })
})
