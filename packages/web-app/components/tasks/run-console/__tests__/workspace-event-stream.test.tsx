// 票11 ⑪真机复点 — WorkspaceEventStream 容器行为单测。
// jsdom 不跑真滚动，钉三件结构事实（原型 .console{height:100%;background:var(--inset)}）：
//   ① 容器撑满内容区到底：flex-1 + min-h-0（旧 max-h-[42vh] 半屏 float 绝迹）；
//   ② 内框 = inset 底（bg-pop-idle），滚动权在盒内（overflow-y-auto）；
//   ③ 自动贴底闸 nearStreamBottom 纯函数：贴底跟、上翻不抢、空盒视为贴底。

import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import type { AgentEvent } from "@/lib/types"
import { WorkspaceEventStream } from "../workspace-event-stream"
import { nearStreamBottom } from "../log-model"

const ev = (over: Partial<AgentEvent> & { event: string }): AgentEvent =>
  ({ nodeId: "dev", timestamp: "2026-10-09T01:00:00.000Z", ...over }) as AgentEvent

describe("WorkspaceEventStream — 铺到底结构（⑪真机复点：日志铺到底）", () => {
  it("容器 = flex-1 + min-h-0 + overflow-y-auto；max-h-[42vh] 旧半屏闸绝迹；内框 inset 底", () => {
    render(<WorkspaceEventStream events={[ev({ event: "tool_call", toolName: "Read" })]} live />)
    const box = screen.getByTestId("workspace-event-stream")
    expect(box.className).toContain("flex-1")
    expect(box.className).toContain("min-h-0")
    expect(box.className).toContain("overflow-y-auto")
    expect(box.className).not.toContain("max-h-[42vh]")
    expect(box.className).toContain("bg-pop-idle") // 原型 .console background:var(--inset)
  })

  it("live 标注 + 空态如实（等待节点事件…）", () => {
    render(<WorkspaceEventStream events={[]} live />)
    expect(screen.getByTestId("workspace-event-stream").getAttribute("data-stream-live")).toBe("true")
    expect(screen.getByTestId("workspace-log-empty").textContent).toContain("等待节点事件")
  })
})

describe("nearStreamBottom — 自动贴底闸（用户上翻不抢滚动）", () => {
  it("在底部（80px 缓冲内）→ 跟随", () => {
    expect(nearStreamBottom(880, 1000, 120)).toBe(true) // 1000-880-120 = 0
    expect(nearStreamBottom(840, 1000, 120)).toBe(true) // 余量恰 40 < 80
    expect(nearStreamBottom(100, 300, 200)).toBe(true)  // 余量 0
  })
  it("用户手动上翻离底（缓冲外）→ 不抢滚动", () => {
    expect(nearStreamBottom(0, 5000, 400)).toBe(false)    // 余量 4600
    expect(nearStreamBottom(4400, 5000, 400)).toBe(false) // 余量 200 ≥ 80
  })
  it("空盒（scrollHeight ≤ clientHeight）→ 视为贴底（jsdom/初始态无害跟随）", () => {
    expect(nearStreamBottom(0, 0, 0)).toBe(true)
    expect(nearStreamBottom(0, 100, 300)).toBe(true)
  })
})
