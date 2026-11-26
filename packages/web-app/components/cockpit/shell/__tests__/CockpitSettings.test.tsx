// 全舱「更多 → 设置」：对话组要有「显示图片缩略图」开关（与桌面 设置 → 外观 同一个偏好）。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('@/components/cabin/CockpitProvider', () => ({
  useCockpit: () => ({
    prefs: { sound: true, theme: 'default', winAlpha: 0.9, frameRate: 'std' },
    applyPrefs: vi.fn(),
  }),
}))

vi.mock('../../state/CockpitStateProvider', () => ({
  useCockpitState: () => ({
    autoWarp: false,
    setAutoWarp: vi.fn(),
    layer: { register: () => () => undefined },
  }),
}))

vi.mock('../../fx/sim-auto', () => ({
  useSimAuto: () => false,
  setSimAuto: vi.fn(),
}))

import { CockpitSettings } from '../CockpitSettings'
import { resetCockpitSettings, setCockpitSettingsOpen } from '../settings-store'

const KEY = 'octopus.ui.chatImageThumbs.v1'

beforeEach(() => {
  window.localStorage.clear()
  resetCockpitSettings()
  setCockpitSettingsOpen(true)
})

afterEach(() => {
  cleanup()
  resetCockpitSettings()
})

describe('CockpitSettings · 对话图片缩略图', () => {
  it('默认开；点一下写 localStorage=false 并即时反映', () => {
    render(<CockpitSettings />)
    const sw = screen.getByTestId('cockpit-setting-chat-images')
    expect(sw.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(sw)

    expect(sw.getAttribute('aria-pressed')).toBe('false')
    expect(window.localStorage.getItem(KEY)).toBe('false')
  })

  it('localStorage 已关 → 开关初始就是关', () => {
    window.localStorage.setItem(KEY, 'false')
    render(<CockpitSettings />)
    expect(screen.getByTestId('cockpit-setting-chat-images').getAttribute('aria-pressed')).toBe('false')
  })
})
