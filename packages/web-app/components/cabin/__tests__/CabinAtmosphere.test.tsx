// 顶部遥测条的读数口径（2026-11-14 用户口径）：
//   1. 与全域 HUD 同语汇、同顺序：运行中 → 需要你 → 排队 → 执行器 → 状态；
//   2. view 还没回来时写「—」，不拿 0 冒充「确实没有」（plans §1.5 数字纪律）；
//   3. 执行器 = 本舱运行中的 execution / 全局并发上限（服务端 health.workers/max）。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const h = vi.hoisted(() => ({
  cabin: { id: 'cabin-1', name: 'Aurora', status: 'active' } as Record<string, unknown> | null,
  view: null as Record<string, unknown> | null,
}))

vi.mock('../cabin-provider', () => ({
  useCabinContext: () => ({ cabin: h.cabin, view: h.view }),
}))
vi.mock('../CockpitProvider', () => ({
  useCockpit: () => ({ prefs: { theme: 'terminal', particles: 0 } }),
}))

import { CabinAtmosphere } from '../CabinAtmosphere'

function items(): string[] {
  const strip = screen.getByTestId('cabin-telemetry')
  return [...strip.querySelectorAll('.titem')].map((node) => node.textContent ?? '')
}

describe('CabinAtmosphere telemetry', () => {
  beforeEach(() => {
    h.cabin = { id: 'cabin-1', name: 'Aurora', status: 'active' }
    h.view = null
  })

  it('读数顺序与语汇跟全域 HUD 对齐', () => {
    h.view = {
      attention: [{ id: 'a1' }, { id: 'a2' }],
      health: { running: 1, queued: 3, dormant: 0, workers: 1, max: 5 },
    }
    render(<CabinAtmosphere />)
    expect(items()).toEqual([
      '运行中1', '需要你2', '排队3', '执行器1/5', '状态活跃',
    ])
  })

  it('view 未就绪时写「—」，不写 0', () => {
    render(<CabinAtmosphere />)
    expect(items()).toEqual([
      '运行中—', '需要你—', '排队—', '执行器—', '状态活跃',
    ])
  })
})
