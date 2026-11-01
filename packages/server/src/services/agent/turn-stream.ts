// packages/server/src/services/agent/turn-stream.ts
//
// Turn-scoped SSE writer (P0-3, 2026-11-01).
//
// Responsibilities:
//   1. Serialize every frame through one promise chain, so a keep-alive frame
//      can never interleave with a chunk frame.
//   2. Emit a lightweight `heartbeat` every N ms while the turn is open, so the
//      browser can tell "the model is thinking" from "the socket is dead".
//   3. Emit exactly one terminal frame (`done` or `error`). Callers use
//      `terminate()` instead of writing terminal frames by hand.
//
// A failed write (client already gone) is swallowed: the turn still has to be
// finalized and persisted. The raw stream's `close()` is left to the caller's
// `finally`, so the terminal frame is flushed first.

export interface TurnStreamLike {
  writeSSE(message: { event: string; data: string }): Promise<void>
  /** Hono's SSEStreamingApi returns Promise<unknown>; we only await it. */
  sleep?(ms: number): Promise<unknown>
  onAbort?(callback: () => void): void
  close(): void
}

export interface TurnStreamHandle {
  /** Drop-in stream for existing code paths (writeSSE / sleep / onAbort / close). */
  readonly stream: TurnStreamLike
  startHeartbeat(ms?: number): void
  stopHeartbeat(): void
  /** Write the turn's single terminal frame. No-op after the first call. */
  terminate(event: 'done' | 'error', data: unknown): Promise<void>
  readonly terminated: boolean
  /** Stop the heartbeat and close the underlying stream. */
  close(): void
}

export const DEFAULT_HEARTBEAT_MS = 15_000

export function createTurnStream(
  raw: TurnStreamLike,
  options: { heartbeatEvent?: string } = {},
): TurnStreamHandle {
  const heartbeatEvent = options.heartbeatEvent ?? 'heartbeat'
  let chain: Promise<void> = Promise.resolve()
  let terminated = false
  let heartbeat: ReturnType<typeof setInterval> | undefined

  const enqueue = (frame: { event: string; data: string }): Promise<void> => {
    chain = chain
      .then(() => raw.writeSSE(frame))
      // A dead client must not abort the turn's persistence path.
      .catch(() => undefined)
    return chain
  }

  const write = (event: string, data: unknown): Promise<void> =>
    enqueue({ event, data: JSON.stringify(data) })

  const wrapped: TurnStreamLike = {
    writeSSE: (frame) => enqueue(frame),
    sleep: (ms) => raw.sleep
      ? raw.sleep(ms)
      : new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms)
          ;(timer as unknown as { unref?: () => void }).unref?.()
        }),
    onAbort: (callback) => raw.onAbort?.(callback),
    close: () => raw.close(),
  }

  const stopHeartbeat = (): void => {
    if (!heartbeat) return
    clearInterval(heartbeat)
    heartbeat = undefined
  }

  const startHeartbeat = (ms: number = DEFAULT_HEARTBEAT_MS): void => {
    if (heartbeat || terminated) return
    heartbeat = setInterval(() => {
      if (terminated) return
      void write(heartbeatEvent, { ts: new Date().toISOString() })
    }, ms)
    ;(heartbeat as unknown as { unref?: () => void }).unref?.()
  }

  const terminate = async (event: 'done' | 'error', data: unknown): Promise<void> => {
    if (terminated) return
    terminated = true
    stopHeartbeat()
    await write(event, data)
  }

  return {
    stream: wrapped,
    startHeartbeat,
    stopHeartbeat,
    terminate,
    get terminated() { return terminated },
    close: () => {
      stopHeartbeat()
      raw.close()
    },
  }
}
