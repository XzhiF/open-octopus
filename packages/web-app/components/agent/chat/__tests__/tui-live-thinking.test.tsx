// TuiLive 流式 thinking 段展开交互（2026-10-10 用户要求：截断的这次 thinking 点开要能看全）。
// 默认 = 3 行活窗口（旧既有行为零变化）；点标题 = 本段全文逐字；再点 = 收回。
import { describe, it, expect } from "vitest"
import { render, fireEvent } from "@testing-library/react"
import { TuiLive } from "../TuiTranscript"
import type { StreamTimelineItem } from "@/hooks/useAgentChat"
import type { ToolCallRecord } from "@/lib/agent/types"

const full = Array.from({ length: 12 }, (_, i) => `R-${String(i + 1).padStart(2, "0")}`).join("\n")
const item: StreamTimelineItem = { kind: "thinking", id: "t1", text: full, active: true }

describe("TuiLive thinking 展开全文", () => {
  it("默认 3 行活窗口：末 3 行在、更早行不渲染", () => {
    const { container } = render(<TuiLive items={[item]} toolCalls={[]} />)
    expect(container.textContent).toContain("R-10")
    expect(container.textContent).toContain("R-12")
    expect(container.textContent).not.toContain("R-09")
    expect(container.textContent).not.toContain("R-01")
  })

  it("点标题 → 本段全文逐字出现（含最早行），展开态标记在", () => {
    const { container } = render(<TuiLive items={[item]} toolCalls={[]} />)
    const btn = container.querySelector('[data-tui-thinking-expand="closed"]') as HTMLElement
    fireEvent.click(btn)
    expect(container.querySelector('[data-tui-thinking-expand="open"]')).toBeTruthy()
    expect(container.textContent).toContain("R-01")
    expect(container.textContent).toContain("R-06")
    expect(container.textContent).toContain("R-12")
  })

  it("再点收回：回到 3 行窗口，最早行消失", () => {
    const { container } = render(<TuiLive items={[item]} toolCalls={[]} />)
    fireEvent.click(container.querySelector('[data-tui-thinking-expand="closed"]') as HTMLElement)
    fireEvent.click(container.querySelector('[data-tui-thinking-expand="open"]') as HTMLElement)
    expect(container.querySelector('[data-tui-thinking-expand="closed"]')).toBeTruthy()
    expect(container.textContent).not.toContain("R-01")
    expect(container.textContent).toContain("R-12")
  })

  it("多段独立：展开一段不吞另一段的窗口", () => {
    const other: StreamTimelineItem = { kind: "thinking", id: "t2", text: "A1\nA2\nA3\nA4\nA5", active: false }
    const { container } = render(<TuiLive items={[item, other]} toolCalls={[]} />)
    fireEvent.click(container.querySelector('[data-tui-thinking-expand="closed"]') as HTMLElement)
    expect(container.textContent).toContain("R-01") // t1 已展开
    expect(container.textContent).not.toContain("A1") // t2 仍窗口（末3行=A3/A4/A5）
    expect(container.textContent).toContain("A5")
  })
})

describe("TuiLive 工具行展开 input/result", () => {
  const tc: ToolCallRecord = {
    id: "k1",
    name: "Bash",
    input: { command: "cat /uniq/in.txt", description: "READ-NEEDLE-DESC" },
    status: "success",
    result: "READ-NEEDLE-RESULT\nsecond line",
  }

  it("默认仅一行简报：无 result 全文、无美化 input 字段", () => {
    const { container } = render(<TuiLive items={[{ kind: "tool", id: "k1" }]} toolCalls={[tc]} />)
    expect(container.textContent).toContain("Bash")
    expect(container.textContent).not.toContain("READ-NEEDLE-RESULT")
    expect(container.textContent).not.toContain('"description"')
  })

  it("点开 → input 全字段 + result 全文；再点收回", () => {
    const { container } = render(<TuiLive items={[{ kind: "tool", id: "k1" }]} toolCalls={[tc]} />)
    fireEvent.click(container.querySelector('[data-tui-tool="closed"] button') as HTMLElement)
    expect(container.querySelector('[data-tui-tool="open"]')).toBeTruthy()
    expect(container.textContent).toContain('"description": "READ-NEEDLE-DESC"')
    expect(container.textContent).toContain("READ-NEEDLE-RESULT")
    fireEvent.click(container.querySelector('[data-tui-tool="open"] button') as HTMLElement)
    expect(container.textContent).not.toContain("READ-NEEDLE-RESULT")
  })

  it("result 未到（running）也已有 input 可展；空载荷不报错", () => {
    const running: ToolCallRecord = { id: "k2", name: "Read", input: { file_path: "/x" }, status: "running" }
    const { container } = render(<TuiLive items={[{ kind: "tool", id: "k2" }]} toolCalls={[running]} />)
    fireEvent.click(container.querySelector('[data-tui-tool="closed"] button') as HTMLElement)
    expect(container.textContent).toContain('"file_path": "/x"')
    expect(container.textContent).not.toContain("result")
  })
})
