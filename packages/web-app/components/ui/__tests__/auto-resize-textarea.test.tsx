import { describe, it, expect } from "vitest"
import { render } from "@testing-library/react"
import { AutoResizeTextarea } from "../auto-resize-textarea"

// 行数几何。jsdom 里 scrollHeight 恒为 0、Tailwind padding 不参与计算，
// 所以这里只锁得住「下限」这一半：输入框空着也必须占满 minRows 行，
// 不会因为没内容就塌回一行（2026-10-30 chat 输入框默高 2 行）。
const LINE = 24

const heightOf = (el: HTMLTextAreaElement) => parseFloat(el.style.height)

describe("AutoResizeTextarea —— minRows 下限", () => {
  it("默认仍是一行，旧调用方（弹窗表单）高度不变", () => {
    const { container } = render(<AutoResizeTextarea value="" />)
    const el = container.querySelector("textarea")!
    expect(el.rows).toBe(1)
    expect(heightOf(el)).toBe(LINE)
  })

  it("minRows=2 → 空框也占两行，rows 属性同步（决定 height:auto 时的固有高度）", () => {
    const { container } = render(<AutoResizeTextarea value="" minRows={2} maxRows={5} />)
    const el = container.querySelector("textarea")!
    expect(el.rows).toBe(2)
    expect(heightOf(el)).toBe(2 * LINE)
  })

  it("改值后下限不丢：清空内容回到 minRows，而不是 1 行", () => {
    const { container, rerender } = render(<AutoResizeTextarea value="一行内容" minRows={2} maxRows={5} />)
    const el = container.querySelector("textarea")!
    rerender(<AutoResizeTextarea value="" minRows={2} maxRows={5} />)
    expect(el).toHaveStyle({ height: `${2 * LINE}px` })
  })
})
