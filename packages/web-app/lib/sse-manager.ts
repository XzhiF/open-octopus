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
 *
 * Visibility budget (2026-11-14): every page opens ~3 长连接 to the same origin
 * (舱事件 / 任务事件 / 工作区会话). Browsers allow only 6 HTTP/1.1 connections per
 * origin, so **two open pages exhaust the pool** and every ordinary request after
 * that queues forever — surfacing as "编队请求超时（15s）" / "作业详情超时（8s）"
 * (2026-11-14 用户 bug)。隐藏页不需要实时流：页面 hidden 时关闭全部连接，可见时
 * 重连（`reconnected: true` → 消费方各自 refetch）。
 */

type Listener = (event: MessageEvent) => void

export interface SSEStatus {
  connected: boolean
  /** true on the OPEN transition that followed a drop (not the first connect). */
  reconnected: boolean
}
type StatusListener = (status: SSEStatus) => void

interface SSEEntry {
  /** 共享连接的 URL（隐藏/可见切换时用它重建 EventSource）。 */
  url: string
  /** null = 当前没有开着连接（隐藏页 / 没人订阅 / 重建间隙）。 */
  es: EventSource | null
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
/** 页面隐藏时挂起全部长连接（见文件头 Visibility budget）。 */
let suspended = typeof document !== 'undefined' && document.hidden
/**
 * 单页面最多同时开几条共享长连接。浏览器单源只有 6 条 HTTP/1.1，必须给普通
 * 请求留出余量 —— 多开桌面窗口时，每个任务窗都会订阅自己的工作区事件流，
 * 不设上限同样会把池子吃满（表现仍是「请求一直排队 → 超时」）。
 * 超出的订阅保持「已订阅、未连接」：组件自己的 10s 轮询照常刷新，只是没有
 * 实时推送 —— 比把全站请求饿死好得多。有连接空出来时按订阅顺序补位。
 */
const MAX_SSE_PER_PAGE = 4

function emitStatus(entry: SSEEntry, reconnected: boolean): void {
  const status: SSEStatus = { connected: entry.connected, reconnected }
  for (const cb of entry.statusListeners) cb(status)
}

// (Re)bind the per-type dispatcher handlers onto the current EventSource. Called on
// first creation AND after a manual rebuild — subscriber Map survives, ES instance does not.
function bindEventListeners(entry: SSEEntry): void {
  if (!entry.es) return
  for (const [eventType, typeMap] of entry.listeners) {
    for (const bound of typeMap.values()) entry.es.addEventListener(eventType, bound)
  }
}

/** 打开这条共享连接（隐藏页 / 无人订阅 / 已达单页上限时不建）。 */
function openEntry(entry: SSEEntry): void {
  if (entry.es || suspended || entry.refCount <= 0) return
  if (liveCount() >= MAX_SSE_PER_PAGE) return // 排队：等有连接空出来再补
  entry.es = new EventSource(entry.url)
  bindEventListeners(entry)
  attachLiveness(entry)
}

function liveCount(): number {
  let n = 0
  for (const entry of connections.values()) if (entry.es) n += 1
  return n
}

/** 有配额空出时，按 Map 插入顺序（先订阅者先连）把排队的订阅补上。 */
function promoteQueued(): void {
  if (suspended) return
  for (const entry of connections.values()) {
    if (liveCount() >= MAX_SSE_PER_PAGE) return
    if (!entry.es && entry.refCount > 0) openEntry(entry)
  }
}

/** 关掉但不拆订阅（隐藏页挂起 / 重建前 / 最后一个订阅者离开）。 */
function closeEntry(entry: SSEEntry): void {
  if (entry.retryTimer) {
    clearTimeout(entry.retryTimer)
    entry.retryTimer = null
  }
  entry.connected = false
  const es = entry.es
  entry.es = null
  if (!es) return
  try { es.close() } catch { /* already dead */ }
}

function attachLiveness(entry: SSEEntry): void {
  if (!entry.es) return
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
    if (!entry.es) return
    entry.connected = false
    emitStatus(entry, false)
    if (entry.es.readyState === EventSource.CLOSED) scheduleRebuild(entry)
  }
}

function scheduleRebuild(entry: SSEEntry): void {
  if (entry.retryTimer || entry.refCount <= 0) return
  entry.retryTimer = setTimeout(() => {
    entry.retryTimer = null
    // Still subscribed? swap in a fresh EventSource and rewire the listeners.
    if (connections.get(entry.url) !== entry || entry.refCount <= 0) return
    closeEntry(entry)
    openEntry(entry)
  }, RECONNECT_DELAY_MS)
}

/** hidden → 释放全部长连接；visible → 按订阅重建（onopen 会报 reconnected，消费方 refetch）。 */
function setSuspended(next: boolean): void {
  if (suspended === next) return
  suspended = next
  for (const entry of connections.values()) {
    if (next) closeEntry(entry)
    else openEntry(entry)
  }
  if (!next) promoteQueued()
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => setSuspended(document.hidden))
}

/** 当前真实开着的共享长连接数（诊断/测试用：单源 6 条是硬上限）。 */
export function liveSSECount(): number {
  return liveCount()
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
    entry = {
      url,
      es: null,
      listeners: new Map(),
      statusListeners: new Set(),
      refCount: 0,
      everOpen: false,
      connected: false,
      retryTimer: null,
    }
    connections.set(url, entry)
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
  entry.refCount++
  // 可能已经有连接（同一 URL 的第二个订阅者）：绑定到现有 ES 上，否则建立新连接。
  // 隐藏页里 refCount 会涨、连接不建，可见后由 setSuspended(false) 统一开出。
  if (entry.es) entry.es.addEventListener(eventType, handler)
  else openEntry(entry)

  return () => {
    const e = connections.get(url)
    if (!e) return

    const tm = e.listeners.get(eventType)
    if (tm) {
      const h = tm.get(listener)
      if (h) {
        e.es?.removeEventListener(eventType, h)
        tm.delete(listener)
      }
      if (tm.size === 0) {
        e.listeners.delete(eventType)
      }
    }
    e.refCount--

    // No more subscriptions — close the connection
    if (e.refCount <= 0) {
      closeEntry(e)
      connections.delete(url)
      promoteQueued() // 让出的一条配额给排队的订阅
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
    entry = {
      url,
      es: null,
      listeners: new Map(),
      statusListeners: new Set(),
      refCount: 0,
      everOpen: false,
      connected: false,
      retryTimer: null,
    }
    connections.set(url, entry)
  }
  entry.statusListeners.add(listener)
  // 首报乐观给 true：此时还没发生任何错误 —— 报 false 会让每个挂载面板闪一遍
  // 「连接中断」横幅。真相由 onopen/onerror 纠正。
  listener({
    connected: entry.everOpen
      ? !!entry.es && entry.es.readyState !== EventSource.CLOSED
      : true,
    reconnected: false,
  })
  return () => { entry?.statusListeners.delete(listener) }
}
