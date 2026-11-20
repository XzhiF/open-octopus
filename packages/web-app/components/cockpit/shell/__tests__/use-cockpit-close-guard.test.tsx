// 用户 #18：关浏览器 / 窗口时，本舱还有 agent 在跑 → 先拦一道确认，
// 确认离开后（pagehide）用 keepalive fetch 逐个停流，再让页面走。
//
// 钉住四条：
//   1. 只有**本舱线程**里的会话才算「在工作」（全局运行列表要取交集）；
//   2. 拦截只发生在真的有人在跑时 —— 空闲页面不能被扣住；
//   3. pagehide 只发一次、发到 /sessions/:id/stop、带 keepalive（销毁后仍送达）；
//   4. 进 bfcache（persisted）不算离开，不许停流。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'

const stateRef = vi.hoisted(() => ({ chat: null as null | { streaming: boolean } }))
const threadsRef = vi.hoisted(() => ({
  threads: [] as Array<{ sessionId: string | null }>,
  active: { sessionId: null as string | null },
}))
const runningRef = vi.hoisted(() => ({ items: [] as Array<{ id: string }> }))

vi.mock('../../state/CockpitStateProvider', () => ({
  useCockpitState: () => ({ chat: stateRef.chat }),
}))
vi.mock('../../chat/use-cockpit-threads', () => ({
  useCockpitThreads: () => threadsRef,
}))
vi.mock('@/lib/agent/api', () => ({
  listRunningSessions: vi.fn(async () => ({ items: runningRef.items })),
}))

import { useCockpitCloseGuard, runningInCabin } from '../use-cockpit-close-guard'

function setThreads(main: string | null, extra: Array<string | null> = []): void {
  threadsRef.threads = [main, ...extra].map((sessionId) => ({ sessionId }))
  threadsRef.active = { sessionId: main }
}

function beforeUnload(): Event {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event
}

function pageHide(persisted = false): void {
  const event = new Event('pagehide') as Event & { persisted: boolean }
  Object.defineProperty(event, 'persisted', { value: persisted })
  window.dispatchEvent(event)
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  stateRef.chat = null
  threadsRef.threads = []
  threadsRef.active = { sessionId: null }
  runningRef.items = []
  fetchMock = vi.fn(async () => ({ ok: true }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('runningInCabin', () => {
  it('全局运行列表 ∩ 本舱线程会话（不在本舱的不算）', () => {
    expect(runningInCabin(
      [{ id: 's-main' }, { id: 's-task' }, { id: 's-other-cabin' }],
      ['s-main', null, 's-task'],
    )).toEqual(['s-main', 's-task'])
  })
})

describe('useCockpitCloseGuard', () => {
  it('空闲 → 不拦关闭、pagehide 不发停流', async () => {
    setThreads('s-main')
    renderHook(() => useCockpitCloseGuard())
    await act(async () => {})

    expect(beforeUnload().defaultPrevented).toBe(false)
    pageHide()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('本舱线程在跑 → 拦关闭；确认离开时 keepalive 停流', async () => {
    setThreads('s-main', ['s-task'])
    runningRef.items = [{ id: 's-task' }]
    renderHook(() => useCockpitCloseGuard())

    await waitFor(() => expect(beforeUnload().defaultPrevented).toBe(true))

    pageHide()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/agent/sessions/s-task/stop')
    expect(init.method).toBe('POST')
    expect(init.keepalive).toBe(true)
  })

  it('别舱的会话在跑 → 不拦（只守本舱）', async () => {
    setThreads('s-main')
    runningRef.items = [{ id: 's-other-cabin' }]
    renderHook(() => useCockpitCloseGuard())
    await act(async () => {})

    expect(beforeUnload().defaultPrevented).toBe(false)
  })

  it('轮询空档：当前台正在生成（chat.streaming）也立刻拦', async () => {
    setThreads('s-main')
    stateRef.chat = { streaming: true }
    renderHook(() => useCockpitCloseGuard())
    await act(async () => {})

    expect(beforeUnload().defaultPrevented).toBe(true)
    pageHide()
    expect(fetchMock.mock.calls[0][0]).toContain('/sessions/s-main/stop')
  })

  it('进 bfcache（persisted）不是离开 → 不停流', async () => {
    setThreads('s-main')
    runningRef.items = [{ id: 's-main' }]
    renderHook(() => useCockpitCloseGuard())
    await waitFor(() => expect(beforeUnload().defaultPrevented).toBe(true))

    pageHide(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
