// v20（design 29 §5/§4）几何锁：左缘/上缘 grip 反向联动 + 弹出窗级联夹回。

import { describe, expect, it } from 'vitest'
import {
  cascadeWinRect,
  cockpitConsoleRect,
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

// v21（design 31 §2.1 / §5.4）：通讯台默认几何 —— 左缘贴立绘右缘 −22、
// 右缘让出右栏、底缘 = 视口 − 56（与 56px 底栏同一条上沿）；≤900 变 56vh /
// 52vh 底部 sheet，底缘让开实测的底栏上沿（footerTop）。
// v22（design 33 §5）：宽屏再左移 36（--ck12-charshift），宽度全给通讯台。
describe('v21/v22 通讯台默认几何', () => {
  it('1600×900：left = 198+16+444−22−36=600；right 让出 100；top 66 / bottom 844', () => {
    const rect = cockpitConsoleRect({ viewport: { width: 1600, height: 900 }, footerTop: 844 })
    expect(rect.x).toBe(600)
    expect(rect.y).toBe(66)
    expect(rect.x + rect.w).toBe(1500)
    expect(rect.y + rect.h).toBe(844)
  })

  it('1200×800：左栏收 64，立绘 66vh；右栏 104（同样左移 36）', () => {
    const rect = cockpitConsoleRect({ viewport: { width: 1200, height: 800 }, footerTop: 700 })
    expect(rect.x).toBe(374)
    expect(rect.x + rect.w).toBe(1096)
    expect(rect.y).toBe(66)
  })

  it('900×700：底部 sheet 56vh，左 52 / 右 92，底缘让开底栏上沿', () => {
    const rect = cockpitConsoleRect({ viewport: { width: 900, height: 700 }, footerTop: 620 })
    expect(rect.x).toBe(52)
    expect(rect.x + rect.w).toBe(808)
    expect(rect.h).toBe(392)
    expect(rect.y).toBe(228)
  })

  it('560×740：52vh sheet，左 46 / 右 80', () => {
    const rect = cockpitConsoleRect({ viewport: { width: 560, height: 740 }, footerTop: 660 })
    expect(rect.x).toBe(46)
    expect(rect.x + rect.w).toBe(480)
    expect(rect.h).toBe(385)
    expect(rect.y).toBe(275)
  })
})
