/**
 * AsyncEventBridge converts push-based event sources into pull-based
 * async iterables. Used to bridge Pi SDK's callback-driven event model
 * with Octopus's AsyncGenerator-based provider interface.
 *
 * Architecture:
 * ```
 * Pi SDK (push events) → AsyncEventBridge → PiAgentProvider (pull via for-await-of)
 * ```
 *
 * Thread-safety model: multiple producers can call `push()` / `pushError()`
 * concurrently; a single consumer pulls via `for await...of`.
 *
 * @example
 * ```ts
 * const bridge = new AsyncEventBridge<PiEvent>()
 *
 * // Producer side
 * session.on('event', (e) => bridge.push(e))
 * session.on('error', (e) => bridge.pushError(e))
 * session.on('end', () => bridge.close())
 *
 * // Consumer side
 * for await (const event of bridge) {
 *   processEvent(event)
 * }
 * ```
 */

// ═══════════════════════════════════════════════════
// Queue item
// ═══════════════════════════════════════════════════

interface QueueItem<T> {
  readonly value?: T
  readonly done: boolean
  readonly error?: unknown
}

// ═══════════════════════════════════════════════════
// AsyncEventBridge
// ═══════════════════════════════════════════════════

export class AsyncEventBridge<T> implements AsyncIterable<T> {
  private readonly queue: QueueItem<T>[] = []
  private waitingResolve: ((item: QueueItem<T>) => void) | null = null
  private _isClosed = false

  /** Whether `close()` has been called. */
  get isClosed(): boolean {
    return this._isClosed
  }

  /**
   * Push a value into the bridge.
   *
   * If a consumer is waiting, the value is delivered directly to the
   * waiting promise. Otherwise it is buffered in the queue.
   *
   * Silently ignored after `close()`.
   */
  push(value: T): void {
    if (this._isClosed) return

    const item: QueueItem<T> = { value, done: false }
    this.deliver(item)
  }

  /**
   * Push an error into the bridge.
   *
   * The error will be thrown when the consumer reaches it during
   * iteration. Subsequent `push()` calls are still accepted (the
   * consumer stops iterating after the error, so they won't be seen).
   *
   * Silently ignored after `close()`.
   */
  pushError(error: unknown): void {
    if (this._isClosed) return

    const item: QueueItem<T> = { done: true, error }
    this.deliver(item)
  }

  /**
   * Signal end of stream.
   *
   * Buffered events are still drained — the consumer receives them
   * before the iteration terminates. Idempotent: calling multiple
   * times has no additional effect.
   */
  close(): void {
    if (this._isClosed) return
    this._isClosed = true

    const item: QueueItem<T> = { done: true }
    this.deliver(item)
  }

  // ═══════════════════════════════════════════════════
  // AsyncIterable implementation
  // ═══════════════════════════════════════════════════

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        const item = await this.pull()
        if (item.error) throw item.error
        if (item.done) return { value: undefined, done: true }
        return { value: item.value!, done: false }
      },
    }
  }

  // ═══════════════════════════════════════════════════
  // Internal helpers
  // ═══════════════════════════════════════════════════

  /**
   * Deliver a queue item to a waiting consumer, or buffer it.
   *
   * This is the single point where the resolve-or-enqueue decision
   * is made, keeping `push`, `pushError`, and `close` consistent.
   */
  private deliver(item: QueueItem<T>): void {
    if (this.waitingResolve) {
      const resolve = this.waitingResolve
      this.waitingResolve = null
      resolve(item)
    } else {
      this.queue.push(item)
    }
  }

  /**
   * Pull the next item from the queue, waiting if empty.
   */
  private pull(): Promise<QueueItem<T>> {
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift()!)
    }

    return new Promise<QueueItem<T>>((resolve) => {
      this.waitingResolve = resolve
    })
  }
}
