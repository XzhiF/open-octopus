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
 *
 * Connection liveness (2026-09-20): the browser's EventSource silently auto-reconnects
 * on transient errors and the UI used to look live while frozen (the 验货台 "数据说谎"
 * failure). The manager now (a) rebuilds the EventSource when the browser gives up
 * (readyState CLOSED — e.g. server restart), (b) republishes real open/error state to
 * `subscribeSSEStatus` listeners, flagging the transition to OPEN *after* having been
 * open before as `reconnected` so consumers can refetch anything missed during the gap.
 */

type Listener = (event: MessageEvent) => void

export interface SSEStatus {
  connected: boolean
  /** true on the OPEN transition that followed a drop (not the first connect). */
  reconnected: boolean
}
type StatusListener = (status: SSEStatus) => void

interface SSEEntry {
  es: EventSource
  /** eventType → Map<listener, boundHandler> — boundHandler is the function registered on ES */
  listeners: Map<string, Map<Listener, (e: MessageEvent) => void>>
  /** liveness subscribers (connection banner / reconnect refetch) */
  statusListeners: Set<StatusListener>
  /** Total number of active subscriptions */
  refCount: number
  /** has the connection ever reached OPEN? distinguishes 首连 from 重连. */
  everOpen: boolean
  connected: boolean
  /** manual-reconnect timer (only armed when the browser gave up: readyState CLOSED). */
  retryTimer: ReturnType<typeof setTimeout> | null
}

const connections = new Map<string, SSEEntry>()
/** CLOSED (browser stopped retrying) 后的手动重连退避。 */
const RECONNECT_DELAY_MS = 3000

function emitStatus(entry: SSEEntry, reconnected: boolean): void {
  const status: SSEStatus = { connected: entry.connected, reconnected }
  for (const cb of entry.statusListeners) cb(status)
}

// (Re)bind the per-type dispatcher handlers onto the current EventSource. Called on
// first creation AND after a manual rebuild — subscriber Map survives, ES instance does not.
function bindEventListeners(entry: SSEEntry): void {
  for (const [eventType, typeMap] of entry.listeners) {
    for (const bound of typeMap.values()) entry.es.addEventListener(eventType, bound)
  }
}

function attachLiveness(url: string, entry: SSEEntry): void {
  entry.es.onopen = () => {
    const reconnected = entry.everOpen
    entry.everOpen = true
    entry.connected = true
    emitStatus(entry, reconnected)
  }
  entry.es.onerror = () => {
    // CONNECTING = transient blip, browser is auto-retrying → just report down.
    // CLOSED = browser gave up (server down / non-event-stream reply) → rebuild manually,
    // otherwise the panel freezes at "old data" forever and looks live.
    if (entry.es.readyState === EventSource.CLOSED) {
      entry.connected = false
      emitStatus(entry, false)
      scheduleRebuild(url, entry)
    } else {
      entry.connected = false
      emitStatus(entry, false)
    }
  }
}

function scheduleRebuild(url: string, entry: SSEEntry): void {
  if (entry.retryTimer || entry.refCount <= 0) return
  entry.retryTimer = setTimeout(() => {
    entry.retryTimer = null
    // Still subscribed? swap in a fresh EventSource and rewire the listeners.
    if (connections.get(url) !== entry || entry.refCount <= 0) return
    try { entry.es.close() } catch { /* already dead */ }
    entry.es = new EventSource(url)
    bindEventListeners(entry)
    attachLiveness(url, entry)
  }, RECONNECT_DELAY_MS)
}

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
    entry = { es, listeners: new Map(), statusListeners: new Set(), refCount: 0, everOpen: false, connected: false, retryTimer: null }
    connections.set(url, entry)
    attachLiveness(url, entry)
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
      if (e.retryTimer) clearTimeout(e.retryTimer)
      e.es.close()
      connections.delete(url)
    }
  }
}

/**
 * Subscribe to a shared connection's liveness. Fires immediately with the current
 * state, then on every open/error transition. Consumers use `reconnected` to
 * refetch whatever the gap may have dropped (e.g. verify log tail / detail).
 */
export function subscribeSSEStatus(url: string, listener: StatusListener): () => void {
  let entry = connections.get(url)
  if (!entry) {
    // No live connection yet — creating one is the caller's job (they'll subscribeSSE
    // too). Arm a placeholder so the first event-type subscribe adopts this status set.
    const es = new EventSource(url)
    entry = { es, listeners: new Map(), statusListeners: new Set(), refCount: 0, everOpen: false, connected: false, retryTimer: null }
    connections.set(url, entry)
    attachLiveness(url, entry)
  }
  entry.statusListeners.add(listener)
  // 首报乐观给 true：EventSource 构造后 readyState=CONNECTING，此时还没发生任何
  // 错误 —— 报 false 会让每个挂载面板闪一遍「连接中断」横幅。真相由 onopen/onerror 纠正。
  listener({ connected: entry.everOpen ? entry.es.readyState !== EventSource.CLOSED : true, reconnected: false })
  return () => { entry?.statusListeners.delete(listener) }
}
