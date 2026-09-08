// packages/web-app/components/agent/chat/__tests__/find-unanswered-ask.test.ts
//
// ChatArea.findUnansweredAsk — 「回合结束后问题卡仍可见可点」的判据（纯函数）。
// 背景（2026-09-09 修复）：回合内 QuestionCard 仅 disabled 预览，onDone 清空
// streaming 状态后卡片随 timeline 卸载 —— 用户从没机会作答。现在回合结束
// 后由本判据从消息尾部恢复卡片（含刷新/重开弹窗后的持久化行恢复）。
import { describe, it, expect } from "vitest"
import { findUnansweredAsk } from "../ChatArea"
import type { AgentMessage, ToolCallRecord } from "@/lib/agent/types"

function msg(partial: Partial<AgentMessage> & { id: string; role: AgentMessage["role"] }): AgentMessage {
  return {
    session_id: "s1", content: "", created_at: "2026-09-09",
    is_summary: false, is_compressed: false, is_edited: false,
    ...partial,
  } as AgentMessage
}

const QUESTIONS = {
  questions: [
    { question: "币种？", header: "H", multiSelect: false, options: [{ label: "A", description: "a" }] },
  ],
}

const askTc: ToolCallRecord = {
  id: "tu-1", name: "AskUserQuestion", input: QUESTIONS, status: "start",
} as unknown as ToolCallRecord

describe("findUnansweredAsk", () => {
  it("尾部 assistant 带 AskUserQuestion(input) → 命中，key 唯一", () => {
    const got = findUnansweredAsk([
      msg({ id: "u1", role: "user", content: "开始" }),
      msg({ id: "a1", role: "assistant", tool_calls: [askTc] }),
    ])
    expect(got).not.toBeNull()
    expect(got!.key).toBe("a1:tu-1")
    expect(got!.input).toEqual(QUESTIONS)
  })

  it("问题后用户已发言（下一条 user 消息 = 已消费）→ null", () => {
    expect(findUnansweredAsk([
      msg({ id: "a1", role: "assistant", tool_calls: [askTc] }),
      msg({ id: "u2", role: "user", content: "我直接打字回答" }),
    ])).toBeNull()
  })

  it("input 缺失回退 result（旧回显形态；字符串 JSON 也可）→ 命中", () => {
    const tcStr = {
      id: "tu-2", name: "AskUserQuestion", status: "result",
      input: undefined, result: JSON.stringify(QUESTIONS),
    } as unknown as ToolCallRecord
    const got = findUnansweredAsk([msg({ id: "a1", role: "assistant", tool_calls: [tcStr] })])
    expect(got).not.toBeNull()
    expect((got!.input as { questions: unknown[] }).questions).toHaveLength(1)
  })

  it("questions 非非空数组（畸形 input）→ null（不渲染空卡）", () => {
    const bad = {
      id: "tu-3", name: "AskUserQuestion", input: { questions: [] }, status: "start",
    } as unknown as ToolCallRecord
    expect(findUnansweredAsk([msg({ id: "a1", role: "assistant", tool_calls: [bad] })])).toBeNull()
  })

  it("无 AskUserQuestion / 空列表 → null", () => {
    expect(findUnansweredAsk([
      msg({ id: "a1", role: "assistant", content: "hi", tool_calls: [{ id: "t", name: "Bash", status: "result" } as unknown as ToolCallRecord] }),
    ])).toBeNull()
    expect(findUnansweredAsk([])).toBeNull()
  })

  it("assistant 消息之间继续回溯（无 user 间隔仍算未答）", () => {
    const got = findUnansweredAsk([
      msg({ id: "u1", role: "user", content: "问题来" }),
      msg({ id: "a1", role: "assistant", tool_calls: [askTc] }),
      msg({ id: "a2", role: "assistant", content: "（模型补的一句收尾）" }),
    ])
    expect(got?.key).toBe("a1:tu-1")
  })
})
