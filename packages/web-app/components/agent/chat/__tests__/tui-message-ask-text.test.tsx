// packages/web-app/components/agent/chat/__tests__/tui-message-ask-text.test.tsx
//
// 2026-11-02 用户反馈：以 AskUserQuestion 收尾的回合，问题前的正文在流式期
// 可见，回合结束、问题卡出现后却消失。TuiMessage 历史态按时间序显示全部
// 正文段；思考 / 工具仍折叠在 meta，展开也不重复正文。
//
// 2026-11-24 用户反馈（多 Agent 回合）：第一段正文在问用户问题，后续子代理
// 陆续返回、模型在同一消息里继续追加正文段，旧规则只显最后一段 → 最初那段
// 被折进 meta。现在规则统一：全部正文段进正文区（流式态与历史态一致）。

import { describe, it, expect, vi } from "vitest"
import { render, fireEvent } from "@testing-library/react"
import { TuiMessage } from "../TuiTranscript"
import type { AgentMessage } from "@/lib/agent/types"

vi.mock("@/lib/billing-currency", () => ({
  useBillingCurrency: () => ({ currency: "CNY", rate: 7 }),
}))

const BASE = {
  session_id: "s1",
  created_at: "2026-11-02T11:17:06.000Z",
  is_summary: false,
  is_compressed: false,
  is_edited: false,
} as const

const ASK_MESSAGE: AgentMessage = {
  ...BASE,
  id: "a-ask",
  role: "assistant",
  content: "收到，接口契约按 auth 独立控制器。\n等 麻子哥 确认验收起法。",
  tool_calls: [
    {
      id: "ask-1",
      name: "AskUserQuestion",
      input: { questions: [{ question: "验收时服务怎么起？", header: "验收起法", options: [] }] },
      status: "start",
    },
  ],
  timeline: [
    { kind: "thinking", text: "plan" },
    { kind: "text", text: "收到，接口契约按 auth 独立控制器。" },
    { kind: "tool", id: "ask-1" },
    { kind: "text", text: "等 麻子哥 确认验收起法。" },
  ],
}

const NORMAL_MESSAGE: AgentMessage = {
  ...BASE,
  id: "a-normal",
  role: "assistant",
  content: "第一段\n最后一段",
  timeline: [
    { kind: "thinking", text: "plan" },
    { kind: "text", text: "第一段" },
    { kind: "tool", id: "t-1" },
    { kind: "text", text: "最后一段" },
  ],
  tool_calls: [{ id: "t-1", name: "Bash", input: {}, status: "success" }],
}

const MULTI_AGENT_MESSAGE: AgentMessage = {
  ...BASE,
  id: "a-multi-agent",
  role: "assistant",
  content: "",
  tool_calls: [
    { id: "agent-1", name: "Agent", input: { description: "查右栏" }, status: "result" },
    { id: "agent-2", name: "Agent", input: { description: "查版本" }, status: "result" },
  ],
  timeline: [
    { kind: "tool", id: "agent-1" },
    { kind: "text", text: "三个探子已派出。这轮问剩下的几条：\n❓ **Q13 补** — 右栏结构？" },
    { kind: "thinking", text: "first agent back" },
    { kind: "text", text: "右栏探子回来了：右栏是一排可开关的模块。" },
    { kind: "tool", id: "agent-2" },
    { kind: "text", text: "版本探子回来了：版本机制已有。" },
  ],
}

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1

describe("TuiMessage — ask 回合的正文", () => {
  it("问题前后的正文都显示，展开 meta 不重复", () => {
    const { container } = render(<TuiMessage message={ASK_MESSAGE} />)
    const text = container.textContent ?? ""
    expect(text).toContain("收到，接口契约按 auth 独立控制器。")
    expect(text).toContain("等 麻子哥 确认验收起法。")
    expect(count(text, "收到，接口契约按 auth 独立控制器。")).toBe(1)

    const toggle = container.querySelector("[data-tui-meta]") as HTMLElement
    fireEvent.click(toggle)
    const expanded = container.textContent ?? ""
    // 正文段已在 body，展开的 meta 只剩思考 / 工具——不再出现 ✎ 正文副本。
    expect(expanded).not.toContain("✎")
    expect(count(expanded, "收到，接口契约按 auth 独立控制器。")).toBe(1)
  })

  it("普通回合也保留全部正文段（不再只显最后一段）", () => {
    const { container } = render(<TuiMessage message={NORMAL_MESSAGE} />)
    const text = container.textContent ?? ""
    expect(text).toContain("第一段")
    expect(text).toContain("最后一段")
  })

  it("多 Agent 返回后，第一段正文（含待答问题）仍在正文区，展开 meta 不重复", () => {
    const { container } = render(<TuiMessage message={MULTI_AGENT_MESSAGE} />)
    const text = container.textContent ?? ""
    expect(text).toContain("Q13 补")
    expect(text).toContain("右栏探子回来了")
    expect(text).toContain("版本探子回来了")

    fireEvent.click(container.querySelector("[data-tui-meta]") as HTMLElement)
    const expanded = container.textContent ?? ""
    expect(expanded).not.toContain("✎")
    expect(count(expanded, "Q13 补")).toBe(1)
  })
})
