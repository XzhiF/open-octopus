// Dock 「调试」 inspector:
//   ① opens on the NEWEST turn and lists newest-first;
//   ② shows only the latest 10 and collapses the rest behind one button;
//   ③ filters (all / switch / anomaly) drive both the list and counts;
//   ④ clicking the ruler jumps to an old turn, expands the list and loads it;
//   ⑤ tabs render the recorded payload (raw vs actual prompt).

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { TurnDebugDetail, TurnDebugListResponse, TurnDebugSummary } from "@/lib/agent/debug-types"

const listSessionDebugTurns = vi.fn()
const getSessionDebugTurn = vi.fn()

vi.mock("@/lib/agent/debug-api", () => ({
  listSessionDebugTurns: (...args: unknown[]) => listSessionDebugTurns(...args),
  getSessionDebugTurn: (...args: unknown[]) => getSessionDebugTurn(...args),
}))

vi.mock("@/lib/billing-currency", () => ({
  useBillingCurrency: () => ({ currency: "USD", rate: 1 }),
}))

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import { DebugInspectorWindow } from "../debug-inspector-window"

const BASE_TIME = Date.parse("2026-11-01T10:00:00.000Z")

function makeTurn(index: number): TurnDebugSummary {
  const identity = index >= 9
    ? { id: "workspace", kind: "clone" as const, name: "工作区专家", revision: 2 }
    : index >= 4
      ? { id: "scheduler", kind: "clone" as const, name: "调度专家", revision: 1 }
      : { id: null, kind: "base" as const, name: "主 Agent", revision: 0 }
  return {
    id: `row-${index}`,
    turn_index: index,
    status: index === 5 ? "error" : index === 7 ? "interrupted" : "ok",
    model: "pro",
    effort: "high",
    started_at: new Date(BASE_TIME + index * 60_000).toISOString(),
    ended_at: new Date(BASE_TIME + index * 60_000 + 9_800).toISOString(),
    duration_ms: 9_800,
    ttft_ms: 1_200,
    identity,
    role_revision: identity.revision,
    has_switch: index === 4 || index === 9,
    usage: {
      inputTokens: 1200,
      outputTokens: 400,
      cacheReadTokens: 2000,
      cacheCreationTokens: 100,
      totalTokens: 3700,
      costUsd: 0.038,
    },
    error: index === 5 ? "boom" : null,
    user_message_id: `user-${index}`,
    assistant_message_id: `assistant-${index}`,
  }
}

const TURNS: TurnDebugSummary[] = Array.from({ length: 12 }, (_, i) => makeTurn(12 - i))

function makeDetail(turn: number): TurnDebugDetail {
  const summary = makeTurn(turn)
  return {
    ...summary,
    user_message: `原始消息 T${turn}`,
    provider_message: turn === 9 ? `原始消息 T${turn}\n\n<system-reminder>\n角色卡\n</system-reminder>` : `原始消息 T${turn}`,
    system_prompt: "你是主 Agent。\n\n记忆快照",
    system_prompt_hash: "abcdef1234567890",
    system_prompt_frozen: true,
    role_card: summary.has_switch ? "[服务端角色切换 · revision 2]\n岗位包全文" : null,
    cwd: "/tmp/ws",
    sdk_options: {
      systemPrompt: { type: "preset", preset: "claude_code", appendChars: 900 },
      model: "pro",
      effort: "high",
      resume: "resume-1",
      cwd: "/tmp/ws",
      agents: ["workspace"],
      mcpServers: ["octopus-workflow"],
      plugins: [],
      interruptible: true,
      settingSources: ["project", "user"],
      transientReminder: summary.has_switch,
    },
    context_usage: {
      categories: [
        { name: "System prompt", tokens: 6000, color: "#D2A8FF" },
        { name: "Messages", tokens: 1200, color: "#4FD1D9" },
        { name: "Free space", tokens: 192800, color: "#26262E" },
      ],
      totalTokens: 7200,
      maxTokens: 200000,
      percentage: 3.6,
      model: "pro",
      systemPromptSections: [{ name: "append", tokens: 900 }],
    },
    system_init: {
      claudeCodeVersion: "2.1.250",
      model: "pro",
      cwd: "/tmp/ws",
      permissionMode: "default",
      tools: ["Read", "Bash"],
      mcpServers: [{ name: "octopus-workflow", status: "connected" }],
      agents: ["workspace"],
      skills: ["octo-ui-review"],
      plugins: [{ name: "task-author", path: "/tmp/task-author" }],
      slashCommands: ["compact"],
    },
    events: [
      { off: 0, type: "init", label: "SDK init", det: "2.1.250 · 2 tools" },
      { off: 1200, type: "llm", label: "message_start" },
      { off: 9800, type: "res", label: "turn done", det: "9.80s" },
    ],
    ledger_calls: [{
      model: "pro",
      stop_reason: "end_turn",
      duration_ms: 9800,
      ttft_ms: 1200,
      input_tokens: 1200,
      output_tokens: 400,
      cache_read_tokens: 2000,
      cache_creation_tokens: 100,
      cost_usd: 0.038,
      timestamp: BASE_TIME,
    }],
    previous: null,
  }
}

beforeEach(() => {
  listSessionDebugTurns.mockReset()
  getSessionDebugTurn.mockReset()
  listSessionDebugTurns.mockResolvedValue({ session_id: "s-1", total: TURNS.length, turns: TURNS } satisfies TurnDebugListResponse)
  getSessionDebugTurn.mockImplementation(async (_sid: string, turn: number) => makeDetail(turn))
})

describe("DebugInspectorWindow — 多轮调试", () => {
  it("默认选中最新一轮、倒序列表、只展开最近 10 轮", async () => {
    const { container } = render(<DebugInspectorWindow sessionId="s-1" />)

    await waitFor(() => expect(getSessionDebugTurn).toHaveBeenCalledWith("s-1", 12))
    expect(listSessionDebugTurns).toHaveBeenCalledWith("s-1")

    // ruler: one tick per recorded turn
    expect(container.querySelectorAll("[data-debug-turn]")).toHaveLength(12)
    // list: latest 10 only + one expand button
    expect(container.querySelectorAll("[data-debug-row]")).toHaveLength(10)
    expect(screen.getByText("显示更早的 2 轮")).toBeTruthy()
    // newest-first: T12 row precedes T3
    const rows = [...container.querySelectorAll<HTMLElement>("[data-debug-row]")]
    expect(rows[0].getAttribute("data-debug-row")).toBe("12")
    expect(rows[rows.length - 1].getAttribute("data-debug-row")).toBe("3")
  })

  it("过滤「异常」只留错误 / 中止轮，并跳到匹配轮", async () => {
    const { container } = render(<DebugInspectorWindow sessionId="s-1" />)
    await waitFor(() => expect(getSessionDebugTurn).toHaveBeenCalled())

    fireEvent.click(screen.getByRole("button", { name: /异常 2/ }))

    await waitFor(() => {
      expect(container.querySelectorAll("[data-debug-row]")).toHaveLength(2)
    })
    const rows = [...container.querySelectorAll<HTMLElement>("[data-debug-row]")]
    expect(rows.map((r) => r.getAttribute("data-debug-row"))).toEqual(["7", "5"])
    await waitFor(() => expect(getSessionDebugTurn).toHaveBeenCalledWith("s-1", 7))
  })

  it("点轮次尺上的旧轮 → 展开列表并加载该轮", async () => {
    const { container } = render(<DebugInspectorWindow sessionId="s-1" />)
    await waitFor(() => expect(getSessionDebugTurn).toHaveBeenCalledWith("s-1", 12))

    fireEvent.click(container.querySelector('[data-debug-turn="1"]') as HTMLElement)

    await waitFor(() => expect(getSessionDebugTurn).toHaveBeenCalledWith("s-1", 1))
    await waitFor(() => {
      expect(container.querySelectorAll("[data-debug-row]")).toHaveLength(12)
    })
    const selected = container.querySelector('[data-debug-row="1"]')
    expect(selected?.getAttribute("data-debug-turn-on")).toBe("true")
  })

  it("Prompt 页签区分原始 / 实际发送；SDK 页展示 init 装载面", async () => {
    render(<DebugInspectorWindow sessionId="s-1" />)
    await waitFor(() => expect(getSessionDebugTurn).toHaveBeenCalled())

    fireEvent.click(screen.getByRole("tab", { name: "Prompt" }))
    expect(await screen.findByText("原始消息 T12")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "实际发送" }))
    expect(await screen.findByText("原始消息 T12")).toBeTruthy()

    fireEvent.click(screen.getByRole("tab", { name: "SDK" }))
    expect(await screen.findByText("claude_code")).toBeTruthy()
    expect(await screen.findByText("2.1.250")).toBeTruthy()
  })

  it("身份页签展示岗位包 diff（切换轮）", async () => {
    const { container } = render(<DebugInspectorWindow sessionId="s-1" />)
    await waitFor(() => expect(getSessionDebugTurn).toHaveBeenCalledWith("s-1", 12))

    fireEvent.click(container.querySelector('[data-debug-turn="9"]') as HTMLElement)
    await waitFor(() => expect(getSessionDebugTurn).toHaveBeenCalledWith("s-1", 9))
    fireEvent.click(screen.getByRole("tab", { name: /身份/ }))

    expect(await screen.findByText("为什么 system prompt 没变：")).toBeTruthy()
    await waitFor(() => expect(screen.getAllByText(/岗位包全文/).length).toBeGreaterThan(0))
    expect(await screen.findByText("role_revision 2")).toBeTruthy()
  })

  it("没有记录时给出空态，不发详情请求", async () => {
    listSessionDebugTurns.mockResolvedValue({ session_id: "s-1", total: 0, turns: [] } satisfies TurnDebugListResponse)
    const { container } = render(<DebugInspectorWindow sessionId="s-1" />)

    expect(await screen.findByText(/还没有调试记录/)).toBeTruthy()
    expect(container.querySelectorAll("[data-debug-row]")).toHaveLength(0)
    expect(getSessionDebugTurn).not.toHaveBeenCalled()
  })
})