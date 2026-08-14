/**
 * Shared SSE Connection Manager
 *
 * Problem: Multiple hooks (useHarnessEvents, useExecutionMetrics, observability-panel,
 * workflow-detail-panel, workflow-flow-viewer-with-status, etc.) each create their own
 * `new EventSource()` to the same endpoint. Browsers limit to ~6 concurrent HTTP/1.1
 * connections per origin. With 7+ EventSources + polling requests, the connection pool
 * is exhausted — node updates and monitoring data freeze.
 *
 * Solution: A module-level singleton that shares ONE EventSource per URL.
 * Components register event listeners via `subscribeSSE()`. The manager uses a
 * dispatcher pattern — ONE handler per event type on the EventSource fans out to
 * all registered listeners. The connection is created on first subscribe and closed
 * when the last subscriber unsubscribes.
 */

type Listener = (event: MessageEvent) => void

interface SSEEntry {
  es: EventSource
  /** eventType → Map<listener, boundHandler> — boundHandler is the function registered on ES */
  listeners: Map<string, Map<Listener, (e: MessageEvent) => void>>
  /** Total number of active subscriptions */
  refCount: number
}

const connections = new Map<string, SSEEntry>()

/**
 * Subscribe to an SSE event type on a shared connection.
 * Returns an unsubscribe function.
 *
 * Usage in useEffect:
 * ```ts
 * useEffect(() => {
 *   return subscribeSSE(url, "node_end", (e) => {
 *     const data = JSON.parse(e.data)
 *     // handle event
 *   })
 * }, [url])
 * ```
 */
export function subscribeSSE(
  url: string,
  eventType: string,
  listener: Listener,
): () => void {
  let entry = connections.get(url)

  if (!entry) {
    const es = new EventSource(url)
    entry = { es, listeners: new Map(), refCount: 0 }
    connections.set(url, entry)

    // EventSource auto-reconnects on transient errors.
    // No manual reconnect needed — the browser handles it.
  }

  // Get or create the listener map for this event type
  let typeMap = entry.listeners.get(eventType)
  if (!typeMap) {
    typeMap = new Map()
    entry.listeners.set(eventType, typeMap)
  }

  // Skip if this exact listener is already registered
  if (typeMap.has(listener)) return () => {}

  // Create a bound handler and register it on the EventSource
  const handler = (e: MessageEvent) => listener(e)
  typeMap.set(listener, handler)
  entry.es.addEventListener(eventType, handler)
  entry.refCount++

  // Return unsubscribe function
  return () => {
    const e = connections.get(url)
    if (!e) return

    const tm = e.listeners.get(eventType)
    if (tm) {
      const h = tm.get(listener)
      if (h) {
        e.es.removeEventListener(eventType, h)
        tm.delete(listener)
      }
      if (tm.size === 0) {
        e.listeners.delete(eventType)
      }
    }
    e.refCount--

    // No more subscriptions — close the connection
    if (e.refCount <= 0) {
      e.es.close()
      connections.delete(url)
    }
  }
}
