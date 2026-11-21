// 门禁期 boot 立绘（2026-11-20 用户：一打开全域就要见到汐音）。
//
// 覆盖三条时间线：加载期先上屏 → 真立绘可画后淡出卸载；舱不存在立即退场；
// 放行后迟迟等不到真立绘时兜底退场（不能一直挡着舱面）。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { CockpitBootLayer } from '../CockpitBootLayer'
import { __resetBootHandover, notifyRealSpriteLive } from '../../crew/boot-handover'

describe('CockpitBootLayer · 门禁期出场立绘', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    __resetBootHandover()
  })
  afterEach(() => {
    vi.useRealTimers()
    __resetBootHandover()
  })

  it('加载期先上屏；真立绘首帧可画后 0.28s 淡出卸载', () => {
    render(<CockpitBootLayer gateOpen={false} gateFailed={false} />)
    expect(screen.getByTestId('cockpit-boot-crew')).toBeInTheDocument()
    const layer = screen.getByTestId('cockpit-boot-layer')
    expect(layer).toHaveAttribute('data-phase', 'shown')

    act(() => notifyRealSpriteLive())
    expect(layer).toHaveAttribute('data-phase', 'fading')

    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.queryByTestId('cockpit-boot-layer')).toBeNull()
  })

  it('舱不存在 / 加载失败 → 立即退场，不留残影', () => {
    render(<CockpitBootLayer gateOpen gateFailed />)
    expect(screen.queryByTestId('cockpit-boot-layer')).toBeNull()
  })

  it('放行后 6s 仍等不到真立绘 → 兜底退场', () => {
    render(<CockpitBootLayer gateOpen gateFailed={false} />)
    act(() => { vi.advanceTimersByTime(6_100) })
    expect(screen.getByTestId('cockpit-boot-layer')).toHaveAttribute('data-phase', 'fading')
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.queryByTestId('cockpit-boot-layer')).toBeNull()
  })
})
