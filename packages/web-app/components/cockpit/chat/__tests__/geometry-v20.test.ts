// v20（design 29 §5/§4）几何锁：左缘/上缘 grip 反向联动 + 弹出窗级联夹回。

import { describe, expect, it } from 'vitest'
import {
  cascadeWinRect,
  resizeCockpitRectLeft,
  resizeCockpitRectTop,
} from '../geometry'

const vp = { width: 1440, height: 900 }
const base = { x: 400, y: 100, w: 600, h: 500 }

describe('v20 边缘 grip', () => {
  it('左缘：右缘钉住，x/w 反向联动，最小宽夹回', () => {
    const next = resizeCockpitRectLeft(base, { dx: 120, dy: 0 }, vp)
    expect(next.x).toBe(520)
    expect(next.w).toBe(480)
    expect(next.x + next.w).toBe(base.x + base.w)
    const extreme = resizeCockpitRectLeft(base, { dx: 900, dy: 0 }, vp)
    expect(extreme.w).toBeGreaterThanOrEqual(320)
    expect(extreme.x + extreme.w).toBe(base.x + base.w)
  })

  it('上缘：底缘钉住，y/h 反向联动，最小高夹回', () => {
    const next = resizeCockpitRectTop(base, { dx: 0, dy: 60 }, vp)
    expect(next.y).toBe(160)
    expect(next.h).toBe(440)
    expect(next.y + next.h).toBe(base.y + base.h)
    const extreme = resizeCockpitRectTop(base, { dx: 0, dy: 900 }, vp)
    expect(extreme.h).toBeGreaterThanOrEqual(240)
    expect(extreme.y + extreme.h).toBe(base.y + base.h)
  })
})

describe('v20 弹出窗级联', () => {
  it('x=120+n*64 / y=84+n*34，尺寸 380×440，越界夹回视口', () => {
    expect(cascadeWinRect(0, vp)).toEqual({ x: 120, y: 84, w: 380, h: 440 })
    expect(cascadeWinRect(2, vp)).toEqual({ x: 248, y: 152, w: 380, h: 440 })
    const small = cascadeWinRect(9, { width: 390, height: 700 })
    expect(small.w).toBe(366)
    expect(small.x + small.w).toBeLessThanOrEqual(390 - 8)
    expect(small.y + small.h).toBeLessThanOrEqual(700 - 8)
  })
})
