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

  it("工作行 spinner / 秒数跟阶段上色：思考紫 · 执行青 · 输出橙", () => {
    const thinking = render(<ChatArea {...baseProps} streaming isThinking turnStartedAt={Date.now() - 3000} />)
    expect(workline(thinking.container)!.querySelector(".text-pop-purple")).toBeTruthy()

    const running: ToolCallRecord[] = [{ id: "t1", name: "Bash", input: {}, status: "running" }]
    const exec = render(<ChatArea {...baseProps} streaming toolCalls={running} />)
    expect(workline(exec.container)!.querySelector(".text-pop-cyan")).toBeTruthy()

    const writing = render(<ChatArea {...baseProps} streaming streamContent="正在写代码" />)
    expect(workline(writing.container)!.querySelector(".text-pop-pink")).toBeTruthy()
  })

  // 2026-11-04：agent 收轮等后台 shell（run_in_background）时，工作行要说清
  // 在跑什么，而不是继续轮换「掐指一算」。
  it("等待后台任务：工作行显示「后台运行中：<description>」并保留计时", () => {
    const { container } = render(
      <ChatArea
        {...baseProps}
        streaming
        turnStartedAt={Date.now() - 3000}
        backgroundTasks={[
          { id: "bg-1", description: "until curl -sf http://localhost:8080/api/users", taskType: "local_bash" },
        ]}
      />,
    )
    const line = workline(container)!
    expect(line.getAttribute("data-tui-workline")).toBe("background")
    expect(line.textContent).toContain("后台运行中：until curl -sf http://localhost:8080/api/users")
    expect(line.textContent).toMatch(/[0-9]+s/)
  })

  it("多条后台任务最多显示两条，其余折成 +N", () => {
    const { container } = render(
      <ChatArea
        {...baseProps}
        streaming
        backgroundTasks={[
          { id: "bg-1", description: "mvn install" },
          { id: "bg-2", description: "docker compose up" },
          { id: "bg-3", description: "curl ready" },
        ]}
      />,
    )
    const line = workline(container)!
    expect(line.textContent).toContain("mvn install")
    expect(line.textContent).toContain("docker compose up")
    expect(line.textContent).toContain("+1")
    expect(line.getAttribute("title")).toBe("mvn install / docker compose up / curl ready")
  })
})
