// lib/sse-manager —— 共享 SSE 连接 + 「隐藏页释放长连接」。
//
// 为什么要这条门禁：浏览器对单源只有 6 条 HTTP/1.1 连接，每个页面 3 条长连接，
// 两个页面就把连接池吃满，之后所有普通请求永久排队（2026-11-14 用户：
// 作业详情一直「超时（8s）」）。隐藏页必须让出连接，可见时重连并通知 refetch。

import { describe, it, expect, beforeEach, vi } from 'vitest'

class FakeEventSource {
  static instances: FakeEventSource[] = []
  static CLOSED = 2
  static CONNECTING = 0
  static OPEN = 1

  url: string
  readyState = FakeEventSource.CONNECTING
  closed = false
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  handlers = new Map<string, Set<(e: MessageEvent) => void>>()

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, handler: (e: MessageEvent) => void) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set())
    this.handlers.get(type)!.add(handler)
  }

  removeEventListener(type: string, handler: (e: MessageEvent) => void) {
    this.handlers.get(type)?.delete(handler)
  }

  close() {
    this.closed = true
    this.readyState = FakeEventSource.CLOSED
  }

  emit(type: string, data: unknown) {
    for (const handler of this.handlers.get(type) ?? []) {
      handler({ data: JSON.stringify(data) } as MessageEvent)
    }
  }

  open() {
    this.readyState = FakeEventSource.OPEN
    this.onopen?.()
  }
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  document.dispatchEvent(new Event('visibilitychange'))
}

const URL_A = 'http://localhost:3001/api/tasks/events'

describe('sse-manager', () => {
  beforeEach(() => {
    vi.resetModules()
    FakeEventSource.instances = []
    setHidden(false)
    ;(globalThis as Record<string, unknown>).EventSource = FakeEventSource
  })

  it('同一 URL 的多个订阅只开一条连接，事件扇出给所有监听者', async () => {
    const { subscribeSSE, liveSSECount } = await import('../sse-manager')
    const a = vi.fn()
    const b = vi.fn()
    const offA = subscribeSSE(URL_A, 'task_status', a)
    const offB = subscribeSSE(URL_A, 'task_status', b)

    expect(FakeEventSource.instances).toHaveLength(1)

    FakeEventSource.instances[0].emit('task_status', { task_id: 't1' })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)

    offA()
    offB()
    expect(liveSSECount()).toBe(0)
    expect(FakeEventSource.instances[0].closed).toBe(true)
  })

  it('页面隐藏：关掉长连接让出连接池；可见：重连并报 reconnected 让消费方 refetch', async () => {
    const { subscribeSSE, subscribeSSEStatus, liveSSECount } = await import('../sse-manager')
    const onTask = vi.fn()
    subscribeSSE(URL_A, 'task_status', onTask)

    const seen: boolean[] = []
    subscribeSSEStatus(URL_A, (status) => { if (status.reconnected) seen.push(true) })

    expect(FakeEventSource.instances).toHaveLength(1)
    FakeEventSource.instances[0].open()
    expect(liveSSECount()).toBe(1)

    setHidden(true)
    expect(liveSSECount()).toBe(0)
    expect(FakeEventSource.instances[0].closed).toBe(true)

    setHidden(false)
    expect(liveSSECount()).toBe(1)
    expect(FakeEventSource.instances).toHaveLength(2)

    // 重连后订阅者仍挂在新的 EventSource 上，且状态报 reconnected。
    FakeEventSource.instances[1].open()
    FakeEventSource.instances[1].emit('task_status', { task_id: 't1' })
    expect(onTask).toHaveBeenCalledTimes(1)
    expect(seen.length).toBe(1)
  })

  it('单页上限：超过 4 条时排队不连，空出配额后自动补位', async () => {
    const { subscribeSSE, liveSSECount } = await import('../sse-manager')
    const offs = [1, 2, 3, 4, 5].map((i) =>
      subscribeSSE(`http://localhost:3001/api/tasks/events?ch=${i}`, 'task_status', () => {}),
    )
    expect(liveSSECount()).toBe(4)
    expect(FakeEventSource.instances).toHaveLength(4)

    offs[0]()
    expect(liveSSECount()).toBe(4) // 排队中的第 5 条补上
    expect(FakeEventSource.instances).toHaveLength(5)
  })
})