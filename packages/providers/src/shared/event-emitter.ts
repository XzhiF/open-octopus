/**
 * Lightweight, type-safe event emitter for internal provider lifecycle events.
 *
 * Listeners are called synchronously on emit. If a listener throws,
 * the error is caught and remaining listeners still execute.
 *
 * @example
 * ```ts
 * interface ProviderEvents {
 *   'session-created': { sessionId: string };
 *   'provider-error': ProviderError;
 *   'ping': undefined;
 * }
 *
 * const emitter = new EventEmitter<ProviderEvents>();
 * emitter.on('session-created', (payload) => {
 *   console.log(payload.sessionId);
 * });
 * emitter.emit('session-created', { sessionId: 'abc123' });
 * ```
 */

/** Event map constraint: keys are event names, values are payload types. Use `type` (not `interface`) for compatibility. */
type EventMap = Record<string, unknown>

/** Listener function type, parameter shaped by the event map. */
type Listener<T> = (payload: T) => void

/**
 * Synchronous, type-safe event emitter.
 *
 * @template Events - A record mapping event names to their payload types.
 *   Use `undefined` as the payload type for events that carry no data.
 *   Define as a `type` alias (not `interface`) to satisfy the generic constraint.
 */
export class EventEmitter<Events extends EventMap> {
  /** Registered listeners keyed by event name. */
  private readonly listeners = new Map<keyof Events & string, Set<Function>>()

  /** Maps a `once` listener to its internal wrapper so `off()` can remove it. */
  private readonly onceWrappers = new WeakMap<Function, Function>()

  /**
   * Register a listener for the given event.
   *
   * @param event - The event name.
   * @param listener - Callback invoked with the event payload on emit.
   */
  on<K extends keyof Events & string>(event: K, listener: Listener<Events[K]>): void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener)
  }

  /**
   * Remove a previously registered listener.
   *
   * Safe to call even if the listener was never added or the event has no listeners.
   * If the listener was registered via `once()`, the internal wrapper is removed instead.
   *
   * @param event - The event name.
   * @param listener - The exact function reference passed to `on()` or `once()`.
   */
  off<K extends keyof Events & string>(event: K, listener: Listener<Events[K]>): void {
    const set = this.listeners.get(event)
    if (!set) return

    const wrapper = this.onceWrappers.get(listener)
    if (wrapper) {
      set.delete(wrapper)
      this.onceWrappers.delete(listener)
    } else {
      set.delete(listener)
    }
  }

  /**
   * Register a listener that is automatically removed after its first invocation.
   *
   * The listener can still be removed early via `off()` using the same reference.
   *
   * @param event - The event name.
   * @param listener - Callback invoked at most once.
   */
  once<K extends keyof Events & string>(event: K, listener: Listener<Events[K]>): void {
    const wrapper: Listener<Events[K]> = (payload) => {
      // Remove the wrapper from the listener set before calling the original,
      // so re-entrant emits don't trigger it again.
      const set = this.listeners.get(event)
      if (set) {
        set.delete(wrapper)
      }
      this.onceWrappers.delete(listener)
      listener(payload)
    }

    this.onceWrappers.set(listener, wrapper)

    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(wrapper)
  }

  /**
   * Emit an event, calling all registered listeners synchronously.
   *
   * Listener errors are caught and swallowed so one faulty listener
   * cannot prevent others from running.
   *
   * @param event - The event name.
   * @param payload - The event payload (omitted when the payload type is `undefined`).
   * @returns `true` if at least one listener was registered for the event.
   */
  emit<K extends keyof Events & string>(
    event: K,
    ...args: Events[K] extends undefined ? [] : [payload: Events[K]]
  ): boolean {
    const set = this.listeners.get(event)
    if (!set || set.size === 0) return false

    // Snapshot the set so listeners can safely add/remove during iteration.
    const snapshot = [...set]
    const payload = args[0]

    for (const fn of snapshot) {
      try {
        fn(payload)
      } catch {
        // Listener errors are swallowed: one bad listener must not
        // prevent other listeners from running or crash the emitter.
      }
    }

    return true
  }
}
