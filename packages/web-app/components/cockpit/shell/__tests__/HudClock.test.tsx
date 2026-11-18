// HUD 中间 pill 右段（当前时间）：真实系统时间 + 每秒走字。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { HudClock } from '../HudClock'

describe('HudClock', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 10, 18, 18, 14, 54))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('显示系统时间 HH:MM:SS', () => {
    render(<HudClock />)
    expect(screen.getByTestId('cockpit-clock')).toHaveTextContent('18:14:54')
  })

  it('每秒走字（不是静态文案）', () => {
    render(<HudClock />)
    const clock = screen.getByTestId('cockpit-clock')
    act(() => { vi.advanceTimersByTime(1000) })
    expect(clock).toHaveTextContent('18:14:55')
    act(() => { vi.advanceTimersByTime(1000) })
    expect(clock).toHaveTextContent('18:14:56')
  })
})
