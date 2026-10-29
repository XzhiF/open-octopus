import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { useDagAutoFit } from "../use-dag-auto-fit"

// 横向主干的 DAG 是宽扁形状：运行台里日志台一展开，DAG pane 被挤矮，挂载时算好的
// fitView 就把两端节点裁到 pane 外（2026-10-30 实测 zoom 0.5 时 7 个主干节点 3 个出界）。
// 这个 hook 的职责：容器尺寸真变了就重拟合；用户自己滚轮/拖过画布就不再抢镜头。

let latestInit: ((instance: unknown) => void) | null = null

function Probe({ contentKey }: { contentKey?: number }) {
  const { containerRef, onInit } = useDagAutoFit<HTMLDivElement>({ contentKey })
  latestInit = onInit
  return (
    <div ref={containerRef} data-testid="stage">
      <div className="react-flow__node" data-testid="node" />
      <div className="react-flow__edge" data-testid="edge" />
      <div data-testid="pane-bg" />
    </div>
  )
}

/** 数据没到时的形态：提前 return，画布 div 不存在 */
function EmptyProbe() {
  return <div data-testid="placeholder" />
}

/**
 * 容器尺寸可改：模拟「日志台展开 → pane 从 600 高变 252 高」。
 * 打在 Element.prototype 上（render 之前生效），因为 hook 在 effect 里就要读一次
 * 基线尺寸 —— 等 render 返回后再补就已经晚了。
 */
const originalRect = Element.prototype.getBoundingClientRect
let stageSize = { width: 1400, height: 600 }
function rectOf(width: number, height: number): DOMRect {
  return {
    x: 0, y: 0, top: 0, left: 0, right: width, bottom: height,
    width, height, toJSON: () => ({}),
  } as DOMRect
}

const fireResize = () => (globalThis as unknown as { __fireResizeObservers: () => void }).__fireResizeObservers()

const flush = () => new Promise<void>((resolve) => { resolve() })

let fitView: ReturnType<typeof vi.fn>

beforeEach(() => {
  fitView = vi.fn()
  stageSize = { width: 1400, height: 600 }
  Element.prototype.getBoundingClientRect = function () { return rectOf(stageSize.width, stageSize.height) }
  // rAF 同步化：断言不必等帧
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 1 })
  vi.stubGlobal("cancelAnimationFrame", () => {})
  latestInit = null
})

afterEach(() => {
  vi.unstubAllGlobals()
  Element.prototype.getBoundingClientRect = originalRect
  cleanup()
})

describe("useDagAutoFit", () => {
  // minZoom 必须显式给：xyflow 默认 minZoom 0.5 会把 fitView 钳在 50%，宽图「居中但装不进」
  it("onInit 立即拟合一次（不再靠 setTimeout(50) 猜节点测量时间）", async () => {
    render(<Probe />)

    latestInit!({ fitView })
    expect(fitView).toHaveBeenCalledTimes(1)
    expect(fitView.mock.calls[0][0]).toMatchObject({ padding: 0.2, minZoom: 0.2, maxZoom: 1 })
  })

  it("pane 被挤矮 → 重新拟合", async () => {
    render(<Probe />)
    latestInit!({ fitView })
    expect(fitView).toHaveBeenCalledTimes(1)

    stageSize.height = 252
    fireResize()
    await flush()
    expect(fitView).toHaveBeenCalledTimes(2)
  })

  it("尺寸没变（几像素抖动）→ 不重拟合，画布不会自己跳", async () => {
    render(<Probe />)
    latestInit!({ fitView })

    fireResize() // ResizeObserver 在 observe 时立刻回调一次，尺寸没变 → 不该再拟合
    await flush()
    expect(fitView).toHaveBeenCalledTimes(1)

    stageSize.height = 599 // < 2px 阈值内当噪声（滚动条出现、窗口过渡动画）
    fireResize()
    await flush()
    expect(fitView).toHaveBeenCalledTimes(1)
  })

  it("用户滚轮缩放后 → 容器再变也不抢镜头", async () => {
    render(<Probe />)
    latestInit!({ fitView })

    screen.getByTestId("node").dispatchEvent(new Event("wheel", { bubbles: true }))
    await flush()
    stageSize.height = 252
    fireResize()
    await flush()
    expect(fitView).toHaveBeenCalledTimes(1)
  })

  it("点节点不算接管（那是「聚焦该通道」的正常操作），拖背景才算", async () => {
    render(<Probe />)
    latestInit!({ fitView })

    screen.getByTestId("node").dispatchEvent(new Event("pointerdown", { bubbles: true }))
    screen.getByTestId("edge").dispatchEvent(new Event("pointerdown", { bubbles: true }))
    await flush()
    stageSize.height = 252
    fireResize()
    await flush()
    expect(fitView).toHaveBeenCalledTimes(2)

    // 背景按下 = 平移意图，之后不再自动拟合
    screen.getByTestId("pane-bg").dispatchEvent(new Event("pointerdown", { bubbles: true }))
    stageSize.height = 200
    fireResize()
    await flush()
    expect(fitView).toHaveBeenCalledTimes(2)
  })

  it("div 迟到（yaml/步骤先空后到）→ 补上订阅，pane 之后被挤矮仍能重拟合", async () => {
    // viewer 在 flowData 为空时是提前 return 的：这一帧根本没有可观察的容器 div
    const { rerender } = render(<EmptyProbe />)
    rerender(<Probe />)
    latestInit!({ fitView })
    expect(fitView).toHaveBeenCalledTimes(1)

    stageSize.height = 252 // 日志台展开
    fireResize()
    await flush()
    expect(fitView).toHaveBeenCalledTimes(2)
  })

  it("结构变化（体内节点迟到）→ 补一次拟合", async () => {
    const { rerender } = render(<Probe contentKey={7} />)
    stageSize = { width: 1400, height: 600 }
    latestInit!({ fitView })
    expect(fitView).toHaveBeenCalledTimes(1) // 首帧（此时 instance 还没就位则 0 次）

    rerender(<Probe contentKey={11} />)
    await flush()
    expect(fitView.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})
