// 作业坞浮窗拖拽几何：右侧锚定（只改宽高，不改 left），拖北边时下沿不动。
// 回归 2026-11-09「调整宽度时文件内容框错位」——尺寸必须夹在聊天栏可视范围内。

import { describe, expect, it } from "vitest"
import { fitPanelFrame, resizePanelFrame, type PanelFrameLimits } from "../dock-panel-geometry"

const limits: PanelFrameLimits = {
  minWidth: 320,
  minHeight: 220,
  maxWidth: 900,
  containerHeight: 600,
}

describe("resizePanelFrame", () => {
  it("拖西边往左 = 变宽（右侧锚定，left 由 right − width 推导）", () => {
    const next = resizePanelFrame({ width: 480, height: 400, top: 56 }, "w", -40, 0, limits)
    expect(next).toEqual({ width: 520, height: 400, top: 56 })
  })

  it("拖西边往右 = 变窄，且不越最小宽度", () => {
    expect(resizePanelFrame({ width: 480, height: 400, top: 56 }, "w", 40, 0, limits).width).toBe(440)
    expect(resizePanelFrame({ width: 480, height: 400, top: 56 }, "w", 400, 0, limits).width).toBe(320)
  })

  it("东边不在可拖方向里：dx 不改变几何", () => {
    const start = { width: 480, height: 400, top: 56 }
    expect(resizePanelFrame(start, "e", 120, 0, limits)).toEqual(start)
  })

  it("拖北边改高度，下沿保持不动（top 反推）", () => {
    const next = resizePanelFrame({ width: 480, height: 400, top: 56 }, "n", 0, 60, limits)
    expect(next.height).toBe(340)
    expect(next.top).toBe(116) // 下沿仍是 456
    expect(next.top + next.height).toBe(456)
  })

  it("拖北边往下超过下沿时，高度停在最小高度", () => {
    const next = resizePanelFrame({ width: 480, height: 400, top: 56 }, "n", 0, 1000, limits)
    expect(next.height).toBe(220)
    expect(next.top).toBe(236)
  })

  it("拖南边变高，但不越过容器底部留白", () => {
    const next = resizePanelFrame({ width: 480, height: 400, top: 56 }, "s", 0, 1000, limits)
    expect(next.height).toBe(536) // 600 − 56 − 8
    expect(next.top).toBe(56)
  })

  it("宽度超过容器可用宽度时夹住", () => {
    expect(resizePanelFrame({ width: 480, height: 400, top: 56 }, "w", -1000, 0, limits).width).toBe(900)
  })
})

describe("fitPanelFrame", () => {
  it("分屏变窄 / 侧栏变宽后把宽度夹回可用空间", () => {
    const fitted = fitPanelFrame({ width: 700, height: 400, top: 56 }, { ...limits, maxWidth: 520 })
    expect(fitted.width).toBe(520)
  })

  it("容器变矮后高度与 top 一起收回容器内", () => {
    const fitted = fitPanelFrame({ width: 480, height: 500, top: 56 }, { ...limits, containerHeight: 400 })
    expect(fitted.height).toBe(336) // 400 − 56 − 8
    expect(fitted.top + fitted.height).toBeLessThanOrEqual(392)
  })

  it("top 为负时归零", () => {
    expect(fitPanelFrame({ width: 480, height: 300, top: -20 }, limits).top).toBe(0)
  })
})
