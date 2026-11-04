// packages/providers/src/idle-watchdog.ts
//
// Stream idle watchdog (P0-2, 2026-11-01).
//
// A provider stream can stop producing without ever throwing: the SDK
// subprocess wedges, the transport stalls, or an in-flight body read is
// abandoned by its own abort. Waiting on `iterator.next()` alone then hangs the
// whole chat turn forever — the SSE connection stays open and the composer
// spins with no way back.
//
// The watchdog races every demand against a deadline. The deadline only starts
// while we are actually waiting for the next value (consumer think-time does not
// count). On expiry it notifies the caller — which aborts the underlying query —
// and throws a typed error the provider maps to an `IDLE_TIMEOUT` chunk.
//
// Deliberately does NOT await `iterator.return()` after a timeout: the pending
// demand may never settle, and awaiting it would block past our own deadline.
// The abandoned promise is caught so it cannot surface as an unhandled
// rejection later.

/** Machine-routable code carried by {@link IdleTimeoutError}. */
export const IDLE_TIMEOUT_CODE = 'IDLE_TIMEOUT'

/** Wait for the first event before declaring the stream dead (default). */
export const DEFAULT_FIRST_EVENT_TIMEOUT_MS = 90_000

/** Max silence between two events once the stream is live (default). */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

export class IdleTimeoutError extends Error {
  readonly code = IDLE_TIMEOUT_CODE

  constructor(
    readonly phase: 'first-event' | 'idle',
    readonly timeoutMs: number,
  ) {
    super(
      phase === 'first-event'
        ? `模型在 ${timeoutMs}ms 内没有返回任何事件`
        : `模型流已 ${timeoutMs}ms 没有新事件`,
    )
    this.name = 'IdleTimeoutError'
  }
}

export interface GuardIdleOptions {
  /** Deadline for the first event. */
  firstEventMs: number
  /**
   * Deadline between two events once the first one arrived. A function is
   * evaluated before every wait: the provider lifts the deadline to its
   * background-wait budget while a `run_in_background` task legitimately keeps
   * the stream silent (a Maven build is not a wedged transport).
   */
  idleMs: number | (() => number)
  /** Called synchronously before the error is thrown — abort the transport here. */
  onTimeout?: (error: IdleTimeoutError) => void
}

const TIMEOUT = Symbol('idle-timeout')

function assertPositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`)
  }
}

function armTimer(ms: number): { promise: Promise<typeof TIMEOUT>; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const promise = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  })
  return { promise, clear: () => { if (timer) clearTimeout(timer) } }
}

function nextWithTimeout<T>(
  iterator: AsyncIterator<T>,
  ms: number,
): Promise<IteratorResult<T> | typeof TIMEOUT> {
  const pending = iterator.next()
  // The timeout may win this race. The abandoned read must never surface as an
  // unhandled rejection when the transport eventually errors out.
  pending.catch(() => undefined)
  const timer = armTimer(ms)
  return Promise.race([pending, timer.promise]).finally(timer.clear)
}

/**
 * Yield values from `source`, failing with {@link IdleTimeoutError} when the
 * source stays silent past its deadline. Errors and normal completion pass
 * through untouched.
 */
export async function* guardIdle<T>(
  source: AsyncIterable<T>,
  options: GuardIdleOptions,
): AsyncGenerator<T> {
  assertPositive(options.firstEventMs, 'firstEventMs')
  if (typeof options.idleMs === 'number') assertPositive(options.idleMs, 'idleMs')

  const idleBudget = (): number => {
    const ms = typeof options.idleMs === 'function' ? options.idleMs() : options.idleMs
    assertPositive(ms, 'idleMs')
    return ms
  }

  const iterator = source[Symbol.asyncIterator]()
  let waitingForFirst = true

  try {
    for (;;) {
      // A function form is re-read on every demand so the provider can switch
      // budgets mid-stream (background task started/finished).
      const budget = waitingForFirst ? options.firstEventMs : idleBudget()
      const result = await nextWithTimeout(iterator, budget)

      if (result === TIMEOUT) {
        const error = new IdleTimeoutError(waitingForFirst ? 'first-event' : 'idle', budget)
        try {
          options.onTimeout?.(error)
        } catch {
          // The abort hook is best-effort; the timeout still wins.
        }
        throw error
      }

      if (result.done) return
      waitingForFirst = false
      yield result.value
    }
  } finally {
    // Propagate early termination (consumer `break`, e.g. on `result`) to the
    // source, exactly like a bare `for await` would. Never await it: after a
    // timeout the outstanding demand may never settle.
    try {
      void Promise.resolve(iterator.return?.()).catch(() => undefined)
    } catch {
      // The source may already be closed; nothing to do.
    }
  }
}

/**
 * Bound an auxiliary await (e.g. the SDK's getContextUsage control request)
 * that is not part of the event stream but must not block the turn forever.
 * The underlying promise is left running; only the wait is bounded.
 */
export async function withSoftTimeout<T>(promise: Promise<T>, ms: number, code: string): Promise<T> {
  assertPositive(ms, `${code} timeoutMs`)
  const timer = armTimer(ms)
  const timeout = timer.promise.then(() => {
    throw new Error(`${code} after ${ms}ms`)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    timer.clear()
  }
}
