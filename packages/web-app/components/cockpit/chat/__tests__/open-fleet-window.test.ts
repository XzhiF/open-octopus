// v22 #5（2026-11-23 用户）：编队 💬 有概率开出小窗 —— 根因是主通讯台收起 / 停靠 /
// 首帧还没量到 rect 时退到 560×520 兜底。锁：量不到通讯台也按通讯台默认几何开窗，
// 永远是「正儿八经的聊天窗口」。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CockpitRect, CockpitWindowsApi } from '../../state/cockpit-state'
import { cockpitConsoleRect } from '../geometry'
import { openFleetChat } from '../open-fleet-window'

function makeWins(existing: { threadKey: string; rect: CockpitRect }[] = []) {
  const openWindow = vi.fn<(threadKey: string, rect: CockpitRect) => boolean>(() => true)
  const wins = {
    windows: existing.map((w, i) => ({ id: `w${i + 1}`, threadKey: w.threadKey, sessionId: null, title: '', rect: w.rect, min: false })),
    openWindow,
  } as unknown as CockpitWindowsApi
  return { wins, openWindow }
}

const clearUnread = vi.fn()

function openedRect(openWindow: ReturnType<typeof makeWins>['openWindow']): CockpitRect {
  const call = openWindow.mock.calls[0]
  expect(call).toBeDefined()
  return call![1]
}

const VIEWPORT = { width: 1440, height: 900 }

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: VIEWPORT.width, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: VIEWPORT.height, configurable: true })
  clearUnread.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('openFleetChat — 默认几何', () => {
  it('通讯台在台内 → 直接盖在通讯台同尺寸同位', () => {
    const { wins, openWindow } = makeWins()
    const consoleRect = { x: 502, y: 66, w: 797, h: 580 }
    openFleetChat(wins, { clearUnread }, 'job:1', { rect: consoleRect, open: true, mini: false, docked: false })
    expect(openedRect(openWindow)).toEqual(consoleRect)
    expect(clearUnread).toHaveBeenCalledWith('job:1')
  })

  it('通讯台停靠 / 收起 → 按通讯台默认几何开，绝不退成小窗', () => {
    const expected = cockpitConsoleRect({ viewport: VIEWPORT, footerTop: null, composerTop: null })
    for (const view of [
      { rect: null, open: true, mini: false, docked: true },
      { rect: null, open: true, mini: true, docked: false },
      { rect: null, open: false, mini: false, docked: false },
    ]) {
      const { wins, openWindow } = makeWins()
      openFleetChat(wins, { clearUnread }, 'job:1', view)
      expect(openedRect(openWindow)).toEqual(expected)
    }
    // 默认几何本身就是「正儿八经」的大小（1440×900 下 ≥ 700×600）。
    expect(expected.w).toBeGreaterThanOrEqual(700)
    expect(expected.h).toBeGreaterThanOrEqual(600)
  })

  it('首帧 state.rect 还是收起高度（47）→ 视为未量到，按默认几何开', () => {
    const expected = cockpitConsoleRect({ viewport: VIEWPORT, footerTop: null, composerTop: null })
    const { wins, openWindow } = makeWins()
    openFleetChat(wins, { clearUnread }, 'job:1', {
      rect: { x: 600, y: 66, w: 740, h: 47 }, open: true, mini: false, docked: false,
    })
    expect(openedRect(openWindow)).toEqual(expected)
  })

  it('已开过同线程 → 聚焦不新建、不改几何', () => {
    const rect = { x: 300, y: 200, w: 500, h: 400 }
    const { wins, openWindow } = makeWins([{ threadKey: 'job:1', rect }])
    openFleetChat(wins, { clearUnread }, 'job:1', null)
    expect(openedRect(openWindow)).toEqual(rect)
  })
})
