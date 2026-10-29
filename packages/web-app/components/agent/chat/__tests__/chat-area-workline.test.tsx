// 流尾常驻工作行（2026-10-29 用户确认的形态 + 二轮修订）：
//   思考 / 执行工具 / 输出 三阶段全程挂在流式输出末尾；
//   文案用诙谐短语（work-phrases 按阶段轮换），耗时只到整秒；
//   回合结束由「已完成」meta 行接管，工作行退场。

import { render } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"
import { ChatArea } from "../ChatArea"
import { WORK_PHRASES } from "@/lib/agent/work-phrases"
import type { ToolCallRecord } from "@/lib/agent/types"

const baseProps = {
  messages: [],
  streaming: false,
  streamContent: "",
  streamThinking: "",
  isThinking: false,
  toolCalls: [] as ToolCallRecord[],
  pendingConfirm: null,
  error: null,
  statusMessage: "",
  onSend: vi.fn(),
  onStop: vi.fn(),
  onConfirm: vi.fn(),
  hasSession: true,
  currentModel: "pro",
  onModelChange: vi.fn(),
  tui: true,
}

function workline(container: HTMLElement): HTMLElement | null {
  return container.querySelector("[data-tui-workline]") as HTMLElement | null
}

describe("ChatArea 流尾工作行", () => {
  it("思考中：刚开始没有任何输出也挂着工作行（替代旧 indicator）", () => {
    const { container } = render(<ChatArea {...baseProps} streaming isThinking turnStartedAt={Date.now() - 3000} />)
    const line = workline(container)
    expect(line).toBeTruthy()
    expect(line!.getAttribute("data-tui-workline")).toBe("thinking")
    expect(WORK_PHRASES.thinking.some((p) => line!.textContent!.includes(p))).toBe(true)
    expect(line!.textContent).toMatch(/\b[0-9]+s\b/)
    expect(line!.textContent).not.toMatch(/\d\.\d+s/)
    // 旧「Agent 思考中」三球提示不再出现
    expect(container.textContent).not.toContain("Agent 思考中")
  })

  it("输出中：已经有正文时工作行仍然在（这正是旧 indicator 消失的场景）", () => {
    const { container } = render(<ChatArea {...baseProps} streaming streamContent="正在写代码" />)
    const line = workline(container)
    expect(line).toBeTruthy()
    expect(line!.getAttribute("data-tui-workline")).toBe("writing")
    expect(WORK_PHRASES.writing.some((p) => line!.textContent!.includes(p))).toBe(true)
  })

  it("执行工具：有进行中的工具调用 → 阶段切到 exec 的短语", () => {
    const toolCalls: ToolCallRecord[] = [{ id: "t1", name: "Bash", input: {}, status: "start" }]
    const { container } = render(
      <ChatArea {...baseProps} streaming toolCalls={toolCalls} streamContent="先跑一下" />,
    )
    const line = workline(container)!
    expect(line.getAttribute("data-tui-workline")).toBe("exec")
    expect(WORK_PHRASES.exec.some((p) => line.textContent!.includes(p))).toBe(true)
  })

  it("回合结束 → 工作行退场", () => {
    const { container } = render(<ChatArea {...baseProps} streamContent="完成了" />)
    expect(workline(container)).toBeNull()
  })
})
