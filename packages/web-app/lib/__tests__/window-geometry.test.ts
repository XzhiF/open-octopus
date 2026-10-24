import { describe, expect, it } from 'vitest'
import {
  CASCADE_STEP,
  HEADER_HEIGHT,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  TITLE_BAR_HEIGHT,
  cascadeRect,
  clampRect,
  maximizeRect,
  missionLayout,
  resizeRect,
  stageSize,
} from '@/lib/window-geometry'

const STAGE = { width: 1440, height: 900 - HEADER_HEIGHT }

describe('window-geometry', () => {
  it('subtracts the global header from the stage height', () => {
    expect(stageSize({ width: 1440, height: 900 })).toEqual({ width: 1440, height: 860 })
  })

  it('clamps windows to the stage and keeps part of the title bar visible', () => {
    expect(clampRect({ x: 100, y: 100, w: 900, h: 600 }, STAGE)).toEqual({
      x: 100,
      y: 100,
      w: 900,
      h: 600,
    })
    expect(clampRect({ x: 0, y: 0, w: 10, h: 10 }, STAGE)).toMatchObject({
      w: MIN_WINDOW_WIDTH,
      h: MIN_WINDOW_HEIGHT,
    })
    expect(clampRect({ x: 5000, y: -50, w: 600, h: 400 }, STAGE)).toEqual({
      x: STAGE.width - 160,
      y: 0,
      w: 600,
      h: 400,
    })
    expect(clampRect({ x: 0, y: 5000, w: 600, h: 400 }, STAGE).y).toBe(
      STAGE.height - TITLE_BAR_HEIGHT,
    )
  })

  it('cascades new windows with a repeating 24px offset', () => {
    const first = cascadeRect(STAGE, 0)
    const second = cascadeRect(STAGE, 1)
    const wrapped = cascadeRect(STAGE, 6)
    expect(second.x - first.x).toBe(CASCADE_STEP)
    expect(second.y - first.y).toBe(CASCADE_STEP)
    expect(wrapped).toEqual(first)
    expect(first.w).toBeGreaterThanOrEqual(MIN_WINDOW_WIDTH)
    expect(first.h).toBeGreaterThanOrEqual(MIN_WINDOW_HEIGHT)
  })

  it('honors a preferred window size and clamps it to the stage', () => {
    const preferred = cascadeRect(STAGE, 0, { width: 1240, height: 760 })
    expect(preferred).toMatchObject({ w: 1240, h: 760 })
    expect(preferred.x).toBe(Math.round((STAGE.width - 1240) / 2))
    expect(preferred.y).toBe(Math.round((STAGE.height - 760) / 2))

    const tiny = cascadeRect({ width: 700, height: 500 }, 0, { width: 1240, height: 760 })
    expect(tiny.w).toBe(700)
    expect(tiny.h).toBe(500)
  })

  it('resizes from every direction and enforces the minimum size', () => {
    const start = { x: 100, y: 100, w: 600, h: 400 }
    expect(resizeRect(start, 'e', 100, 0, STAGE)).toEqual({ x: 100, y: 100, w: 700, h: 400 })
    expect(resizeRect(start, 'w', 100, 0, STAGE)).toEqual({ x: 200, y: 100, w: 500, h: 400 })
    expect(resizeRect(start, 's', 0, 50, STAGE)).toEqual({ x: 100, y: 100, w: 600, h: 450 })
    expect(resizeRect(start, 'n', 0, 50, STAGE)).toEqual({ x: 100, y: 150, w: 600, h: 350 })
    expect(resizeRect(start, 'se', 50, 50, STAGE)).toEqual({ x: 100, y: 100, w: 650, h: 450 })
    expect(resizeRect(start, 'nw', 50, 50, STAGE)).toEqual({ x: 150, y: 150, w: 550, h: 350 })
    expect(resizeRect(start, 'e', -1000, 0, STAGE).w).toBe(MIN_WINDOW_WIDTH)
    expect(resizeRect(start, 's', 0, -1000, STAGE).h).toBe(MIN_WINDOW_HEIGHT)
  })

  it('maximizes to the full stage', () => {
    expect(maximizeRect(STAGE)).toEqual({ x: 0, y: 0, w: 1440, h: 860 })
  })

  it('lays out Mission Control slots without overlap', () => {
    const one = missionLayout(
      [{ id: 'desktop', rect: { x: 0, y: 0, w: STAGE.width, h: STAGE.height } }],
      STAGE,
    )
    expect(one).toHaveLength(1)
    expect(one[0].scale).toBeLessThanOrEqual(1)
    expect(one[0].content.w).toBeGreaterThan(STAGE.width * 0.8)

    const four = missionLayout(
      Array.from({ length: 4 }, (_, index) => ({
        id: `w${index}`,
        rect: { x: 100, y: 100, w: 900, h: 600 },
      })),
      STAGE,
    )
    expect(four).toHaveLength(4)
    expect(four[0].content.x).toBeLessThan(four[1].content.x)
    expect(four[0].content.y).toBeLessThan(four[2].content.y)
    for (const slot of four) {
      expect(slot.scale).toBeGreaterThan(0)
      expect(slot.tx).toBeGreaterThanOrEqual(slot.content.x)
      expect(slot.ty).toBeGreaterThanOrEqual(slot.content.y)
    }

    const nine = missionLayout(
      Array.from({ length: 9 }, (_, index) => ({
        id: `w${index}`,
        rect: { x: 0, y: 0, w: 1000, h: 700 },
      })),
      STAGE,
    )
    expect(nine).toHaveLength(9)
  })
})
