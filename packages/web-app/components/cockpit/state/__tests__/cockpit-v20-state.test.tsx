// v20（design 29 §3–§6）状态层锁：线程 tab / 未读 / 本地回执 / 弹出窗上限与聚焦 /
// 停靠 / 面板入参 / 回传 flash。只测状态契约，不测渲染。

import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { CockpitStateProvider, useCockpitState } from '../CockpitStateProvider'
import { COCKPIT_WIN_LIMIT } from '../cockpit-state'

function wrapper({ children }: { children: ReactNode }) {
  return <CockpitStateProvider entryCabinId="c1">{children}</CockpitStateProvider>
}

const rect = { x: 120, y: 84, w: 380, h: 440 }

describe('v20 线程 tab / 未读 / 回执', () => {
  it('activateThread 切线程并消未读；closeTab 回主对话；reopenTab 恢复', () => {
    const { result } = renderHook(() => useCockpitState(), { wrapper })
    act(() => {
      result.current.threads.bumpUnread('job:1', 2)
      result.current.threads.activateThread('job:1')
    })
    expect(result.current.threads.activeThread).toBe('job:1')
    expect(result.current.threads.unread['job:1']).toBe(0)

    act(() => result.current.threads.closeTab('job:1'))
    expect(result.current.threads.activeThread).toBe('main')
    expect(result.current.threads.closedTabs).toContain('job:1')

    act(() => result.current.threads.reopenTab('job:1'))
    expect(result.current.threads.closedTabs).not.toContain('job:1')

    // 主对话不可关。
    act(() => result.current.threads.closeTab('main'))
    expect(result.current.threads.closedTabs).not.toContain('main')
  })

  it('pushReceipt 落本地回执且封顶 40 条', () => {
    const { result } = renderHook(() => useCockpitState(), { wrapper })
    act(() => {
      for (let i = 0; i < 45; i += 1) result.current.threads.pushReceipt('main', `r${i}`)
    })
    const list = result.current.threads.receipts.main
    expect(list).toHaveLength(40)
    expect(list[list.length - 1].text).toBe('r44')
  })
})

describe('v20 弹出窗', () => {
  it('同线程再开 = 聚焦不新建；上限 5 拒绝；关闭/最小化恢复', () => {
    const { result } = renderHook(() => useCockpitState(), { wrapper })
    const focus = vi.fn()
    window.addEventListener('octopus:cockpit-win-focus', focus)

    act(() => { expect(result.current.wins.openWindow('job:1', rect)).toBe(true) })
    expect(result.current.wins.windows).toHaveLength(1)
    act(() => { expect(result.current.wins.openWindow('job:1', rect)).toBe(true) })
    expect(result.current.wins.windows).toHaveLength(1)
    expect(focus).toHaveBeenCalled()

    for (let i = 2; i <= COCKPIT_WIN_LIMIT; i += 1) {
      act(() => { expect(result.current.wins.openWindow(`job:${i}`, rect)).toBe(true) })
    }
    act(() => { expect(result.current.wins.openWindow('job:99', rect)).toBe(false) })
    expect(result.current.wins.windows).toHaveLength(COCKPIT_WIN_LIMIT)

    const id = result.current.wins.windows[0].id
    act(() => result.current.wins.setWindowMin(id, true))
    expect(result.current.wins.windows[0].min).toBe(true)
    act(() => result.current.wins.setWindowMin(id, false))
    expect(result.current.wins.windows[0].min).toBe(false)
    act(() => result.current.wins.closeWindow(id))
    expect(result.current.wins.windows.find((w) => w.id === id)).toBeUndefined()
    window.removeEventListener('octopus:cockpit-win-focus', focus)
  })
})

describe('v20 停靠 / 面板 / flash', () => {
  it('openWithFocus 清 docked + mini；面板带入参；flash nonce 递增', () => {
    const { result } = renderHook(() => useCockpitState(), { wrapper })
    act(() => result.current.chatWindow.set({ open: true, docked: true, mini: true }))
    act(() => result.current.chatWindow.openWithFocus())
    expect(result.current.chatWindow.docked).toBe(false)
    expect(result.current.chatWindow.mini).toBe(false)
    expect(result.current.chatWindow.open).toBe(true)

    act(() => result.current.openPanel('ws', 'ledger-core'))
    expect(result.current.panel).toBe('ws')
    expect(result.current.panelArg).toBe('ledger-core')
    act(() => result.current.closePanel())
    expect(result.current.panel).toBeNull()

    act(() => result.current.markArrival('job:1'))
    const first = result.current.flash.nonce
    act(() => result.current.markArrival('job:1'))
    expect(result.current.flash.nonce).toBe(first + 1)
    expect(result.current.flash.key).toBe('job:1')
  })
})
