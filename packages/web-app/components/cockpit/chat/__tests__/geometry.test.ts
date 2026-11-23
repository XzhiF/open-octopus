// S5 · 聊天浮窗纯几何（plans §0.3）：默认落位 / 夹回 / mini / 缩放 / 透明度档位。
//
// 三档视口都覆盖：1440（满宽 >1360 → 让位 366）、1280（334）、1024（334）。
// 期望值按 §0.3 的公式手算，不是跑一遍实现再抄回来。

import { describe, it, expect } from 'vitest'
import {
  CHAT_ALPHA_STEPS,
  cascadeFromConsole,
  clampCockpitRect,
  cockpitChatPadding,
  cockpitChatRect,
  miniCockpitRect,
  moveCockpitRect,
  nextCockpitAlpha,
  resizeCockpitRect,
} from '../geometry'

describe('cockpitChatPadding — v12 断点', () => {
  it('>1360 → 366，>900 → 334，其余 300', () => {
    expect(cockpitChatPadding(1440)).toBe(366)
    expect(cockpitChatPadding(1360)).toBe(334)
    expect(cockpitChatPadding(1280)).toBe(334)
    expect(cockpitChatPadding(1024)).toBe(334)
    expect(cockpitChatPadding(900)).toBe(300)
  })
})

describe('cockpitChatRect — arena + paddingLeft', () => {
  it('1440：x = arena.left + 366，w = arena.width - 366，h = arena.height - 8', () => {
    const rect = cockpitChatRect(
      { left: 320, top: 48, width: 1100, height: 800 },
      cockpitChatPadding(1440),
    )
    expect(rect).toEqual({ x: 686, y: 48, w: 734, h: 792 })
    expect(clampCockpitRect(rect, { width: 1440, height: 900 })).toEqual(rect)
  })

  it('1280：右侧越界时夹回视口（8px 留白）', () => {
    const rect = cockpitChatRect(
      { left: 300, top: 48, width: 980, height: 712 },
      cockpitChatPadding(1280),
    )
    expect(rect).toEqual({ x: 634, y: 48, w: 646, h: 704 })
    expect(clampCockpitRect(rect, { width: 1280, height: 800 }))
      .toEqual({ x: 626, y: 48, w: 646, h: 704 })
  })

  it('1024：宽度收窄后仍然贴住右侧留白', () => {
    const rect = cockpitChatRect(
      { left: 300, top: 48, width: 724, height: 680 },
      cockpitChatPadding(1024),
    )
    expect(rect).toEqual({ x: 634, y: 48, w: 390, h: 672 })
    expect(clampCockpitRect(rect, { width: 1024, height: 768 }))
      .toEqual({ x: 626, y: 48, w: 390, h: 672 })
  })

  it('arena 太窄时宽度兜底到 320（不出现负宽）', () => {
    const rect = cockpitChatRect({ left: 0, top: 0, width: 200, height: 100 }, 366)
    expect(rect.w).toBe(320)
    expect(rect.h).toBe(92)
  })
})

describe('clampCockpitRect / miniCockpitRect', () => {
  it('拖出左上角 / 右下角都会被夹回 8px 边距', () => {
    expect(clampCockpitRect({ x: -400, y: -400, w: 500, h: 400 }, { width: 1280, height: 800 }))
      .toEqual({ x: 8, y: 8, w: 500, h: 400 })
    expect(clampCockpitRect({ x: 5000, y: 5000, w: 500, h: 400 }, { width: 1280, height: 800 }))
      .toEqual({ x: 772, y: 392, w: 500, h: 400 })
  })

  it('尺寸超过视口时先夹尺寸，再夹位置', () => {
    const rect = clampCockpitRect({ x: 0, y: 0, w: 4000, h: 3000 }, { width: 1280, height: 800 })
    expect(rect.w).toBe(1264)
    expect(rect.h).toBe(784)
    expect(rect.x).toBe(8)
    expect(rect.y).toBe(8)
  })

  it('mini 只改高度为 47，位置与宽度不动', () => {
    expect(miniCockpitRect({ x: 600, y: 48, w: 646, h: 704 }))
      .toEqual({ x: 600, y: 48, w: 646, h: 47 })
  })
})

describe('resizeCockpitRect / moveCockpitRect', () => {
  it('右下缩放：最小 320 × 240', () => {
    expect(resizeCockpitRect({ x: 600, y: 100, w: 400, h: 300 }, { dx: -200, dy: -200 }, { width: 1440, height: 900 }))
      .toEqual({ x: 600, y: 100, w: 320, h: 240 })
  })

  it('右下缩放：不超过视口右/下边界', () => {
    expect(resizeCockpitRect({ x: 600, y: 100, w: 400, h: 300 }, { dx: 900, dy: 900 }, { width: 1440, height: 900 }))
      .toEqual({ x: 600, y: 100, w: 832, h: 792 })
  })

  it('拖动不改尺寸，只夹位置', () => {
    expect(moveCockpitRect({ x: 600, y: 100, w: 400, h: 300 }, { dx: 100, dy: 50 }, { width: 1440, height: 900 }))
      .toEqual({ x: 700, y: 150, w: 400, h: 300 })
    expect(moveCockpitRect({ x: 600, y: 100, w: 400, h: 300 }, { dx: 9000, dy: 9000 }, { width: 1440, height: 900 }))
      .toEqual({ x: 1032, y: 592, w: 400, h: 300 })
  })
})

describe('cascadeFromConsole — v22 #5 编队 chat 窗默认几何', () => {
  const consoleRect = { x: 502, y: 66, w: 797, h: 580 }
  const viewport = { width: 1440, height: 900 }

  it('首扇 = 主通讯台同尺寸同位（直接盖在上面）', () => {
    expect(cascadeFromConsole(consoleRect, 0, viewport)).toEqual(consoleRect)
  })

  it('多扇逐扇错开 18px，最后一扇仍夹回视口留白', () => {
    expect(cascadeFromConsole(consoleRect, 2, viewport)).toEqual({
      x: 502 + 36,
      y: 66 + 36,
      w: 797,
      h: 580,
    })
    // 第 9 扇 x 会越界：夹回 视口 − 窗宽 − 8。
    expect(cascadeFromConsole(consoleRect, 8, viewport)).toEqual({
      x: 1440 - 797 - 8,
      y: 66 + 144,
      w: 797,
      h: 580,
    })
  })

  it('量不到通讯台（收起 / 停靠 / 最小化）按 560×520 兜底', () => {
    expect(cascadeFromConsole(null, 0, viewport)).toEqual({ x: 120, y: 66, w: 560, h: 520 })
  })

  it('宽高夹进 [300×260, 视口−留白]（小视口不撑出屏幕）', () => {
    expect(cascadeFromConsole({ x: 0, y: 0, w: 320, h: 47 }, 0, { width: 800, height: 600 }))
      .toEqual({ x: 8, y: 54, w: 320, h: 260 })
  })
})

describe('nextCockpitAlpha — ◍ 五档循环', () => {
  it('94 → 82 → 70 → 55 → 100 → 94', () => {
    let alpha: number = CHAT_ALPHA_STEPS[0]
    const seen = [alpha]
    for (let i = 0; i < CHAT_ALPHA_STEPS.length; i++) {
      alpha = nextCockpitAlpha(alpha)
      seen.push(alpha)
    }
    expect(seen).toEqual([0.94, 0.82, 0.7, 0.55, 1, 0.94])
  })

  it('未知值回到第一档（不产生 NaN）', () => {
    expect(nextCockpitAlpha(0.123)).toBe(0.94)
  })
})
