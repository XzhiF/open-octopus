// TUI 过程 meta（2026-10-29 用户第三轮反馈后定稿）：
//   收起 = 已完成 · 时长 · N 步 · 工具 · 思考 · token · 费用（纯文字，无图形、无底色）；
//   展开 = 上面那行摘要保持不动，正文只补非重复明细（输入/输出、缓存读/写、请求、失败、模型）。

import { describe, it, expect, vi } from "vitest"
import { render, fireEvent } from "@testing-library/react"
import { TuiMessage, briefValue, toolBrief } from "../TuiTranscript"
import type { AgentMessage, MessageTimelineEntry, ToolCallRecord } from "@/lib/agent/types"
import type { TurnStats } from "@/lib/turn-stats"

vi.mock("@/lib/billing-currency", () => ({
  useBillingCurrency: () => ({ currency: "CNY", rate: 7 }),
}))

const STATS: TurnStats = {
  durationMs: 94_000,
  calls: 2,
  tokens: 12_300,
  inputTokens: 12_100,
  outputTokens: 200,
  cacheReadTokens: 9_800,
  cacheCreationTokens: 1_100,
  cacheHitRate: 0.82,
  costUsd: 0.084,
  costComplete: true,
  models: ["claude-opus-5", "claude-haiku-5-5"],
}

function assistant(
  timeline: MessageTimelineEntry[],
  toolCalls: ToolCallRecord[],
  stats?: TurnStats,
  extra?: Partial<AgentMessage>,
): AgentMessage {
  return {
    id: "a-1",
    session_id: "s1",
    role: "assistant",
    content: "done",
    timeline,
    tool_calls: toolCalls,
    created_at: "2026-10-29T02:01:34.000Z",
    is_summary: false,
    is_compressed: false,
    is_edited: false,
    ...(stats ? { turnStats: stats } : {}),
    ...extra,
  }
}

const TWELEVE: MessageTimelineEntry[] = [
  { kind: "thinking", text: "plan" },
  { kind: "tool", id: "t1" },
  { kind: "thinking", text: "again" },
  { kind: "tool", id: "t2" },
  { kind: "tool", id: "t3" },
  { kind: "text", text: "note" },
  { kind: "tool", id: "t4" },
  { kind: "tool", id: "t5" },
  { kind: "tool", id: "t6" },
  { kind: "thinking", text: "x" },
  { kind: "tool", id: "t7" },
  { kind: "thinking", text: "y" },
]
const TOOLS: ToolCallRecord[] = Array.from({ length: 7 }, (_, i) => ({
  id: `t${i + 1}`,
  name: "Bash",
  input: {},
  status: i === 2 ? "fail" : "success",
}))

describe("TuiMessage 过程 meta — 收起态", () => {
  it("已完成 · 时长 · N 步 · 工具/思考/token/费用（纯文字、无底色）", () => {
    const { container } = render(<TuiMessage message={assistant(TWELEVE, TOOLS, STATS)} />)
    const text = container.textContent ?? ""
    expect(text).toContain("已完成")
    expect(text).toContain("12 步")
    expect(text).toContain("1m 34s")
    expect(text).toContain("工具 7")
    expect(text).toContain("思考 4")
    expect(text).toContain("12.3K tok")
    // 费用跟随计费设置：0.084 USD × 7 = 0.588 → ¥0.59
    expect(text).toContain("¥0.59")
    // 2026-10-29 用户反馈：不要任何看不懂的图形（点阵 / 构成条一律不渲染）
    expect(container.querySelector("[data-tui-bar]")).toBeNull()
    expect(container.querySelector("[data-tui-dots]")).toBeNull()
    // 也不要底色
    const row = container.querySelector('[data-tui-meta="closed"]') as HTMLElement
    expect(row.className).not.toMatch(/bg-/)
  })

  it("无统计（旧轮 / 账本未落）→ 仍显示状态、步数、工具、思考，不显示 0s / 0 tok / 费用", () => {
    const { container } = render(<TuiMessage message={assistant(TWELEVE, TOOLS)} />)
    const text = container.textContent ?? ""
    expect(text).toContain("已完成")
    expect(text).toContain("12 步")
    expect(text).not.toContain("0s")
    expect(text).not.toContain("0 tok")
    expect(text).not.toContain("¥")
    expect(container.querySelector("[data-tui-duration]")).toBeNull()
  })

  it("中断的轮 → 状态词「已中断」", () => {
    const { container } = render(<TuiMessage message={assistant(TWELEVE, TOOLS, STATS, { interrupted: true })} />)
    expect(container.textContent).toContain("已中断")
    expect(container.textContent).not.toContain("已完成")
  })

  it("部分模型未定价 → 金额带 ≈ 前缀", () => {
    const stats: TurnStats = { ...STATS, costComplete: false }
    const { container } = render(<TuiMessage message={assistant(TWELEVE, TOOLS, stats)} />)
    expect(container.textContent).toContain("≈¥0.59")
  })

  it("步数再多也只占一行文字（不再渲染点阵/构成条）", () => {
    const many = Array.from({ length: 45 }, (_, i): MessageTimelineEntry => ({ kind: "tool", id: `t${i}` }))
    const tools = Array.from({ length: 45 }, (_, i): ToolCallRecord => ({
      id: `t${i}`, name: "Bash", input: {}, status: "success",
    }))
    const { container } = render(<TuiMessage message={assistant(many, tools)} />)
    expect(container.textContent).toContain("45 步")
    expect(container.textContent).toContain("工具 45")
    expect(container.querySelector("[data-tui-bar]")).toBeNull()
  })
})

describe("TuiMessage 过程 meta — 展开态", () => {
  it("上面的摘要保持不动，正文只剩步骤列表（不再显示输入/输出/缓存/模型明细）", () => {
    const { container } = render(<TuiMessage message={assistant(TWELEVE, TOOLS, STATS)} />)
    fireEvent.click(container.querySelector('[data-tui-meta="closed"]') as HTMLElement)
    const header = container.querySelector('[data-tui-meta="open"]') as HTMLElement
    expect(header).toBeTruthy()
    // 「上面的信息保持」：展开后摘要一行原样保留
    expect(header.textContent).toContain("已完成")
    expect(header.textContent).toContain("1m 34s")
    expect(header.textContent).toContain("12 步")
    expect(header.textContent).toContain("工具 7")
    expect(header.textContent).toContain("12.3K tok")
    expect(header.textContent).toContain("¥0.59")
    const body = container.querySelector("[data-tui-meta-body]")!
    // 2026-10-29 用户：输入/输出、缓存命中、模型这些明细没必要了 → 展开只有步骤列表
    expect(body.querySelector("[data-tui-stats-line]")).toBeNull()
    expect(body.textContent).not.toContain("输入")
    expect(body.textContent).not.toContain("缓存命中")
    expect(body.textContent).not.toContain("claude-opus-5")
    // 摘要行已有的信息不在正文重复
    expect(body.textContent).not.toContain("1m 34s")
    expect(body.textContent).not.toContain("12.3K tok")
    // 原步骤列表仍在：工具简报
    expect(body.textContent).toContain("Bash")
    // 展开态同样不出现任何图形化元素
    expect(body.querySelectorAll("[data-tui-bar]").length).toBe(0)
  })
})

describe("工具简报 — 长路径中段省略（头尾都留，整体长度接近）", () => {
  const TASK_ROOT = "C:\\Users\\EDY\\.octopus\\workspaces\\task-m-1029-133431-55fdb6"
  const LONG_WIN = `${TASK_ROOT}\\.task-author\\SKILL.md`

  it("Windows 长路径：保留盘符 + 前几级目录 + 末几级目录/文件名，中间变「…」", () => {
    const out = briefValue(LONG_WIN)
    expect(out).toBe("C:\\Users\\EDY\\.octopus…\\task-m-1029-133431-55fdb6\\.task-author\\SKILL.md")
    // 不再是只剩末两级的极短形式
    expect(out.length).toBeGreaterThan("C:\\…\\.task-author\\SKILL.md".length)
  })

  it("短路径原样保留；普通长命令保留开头", () => {
    expect(briefValue("C:\\repo\\a.ts")).toBe("C:\\repo\\a.ts")
    const cmd = "rg --line-number --hidden --glob '!node_modules' 'turnStats' packages/web-app"
    const out = briefValue(cmd, 40)
    expect(out.length).toBeLessThanOrEqual(41)
    expect(out.startsWith("rg --line-number")).toBe(true)
    expect(out.endsWith("…")).toBe(true)
  })

  it("尾从文件名往前逐级吃：目录层级比切一半的名字更有信息量", () => {
    const repo = "C:\\Users\\EDY\\.octopus\\orgs\\xzf\\repos\\projects\\xzf\\octopus-demo-service-user\\userservice\\impl\\UserServiceImpl.java"
    const out = briefValue(repo)
    expect(out).toContain("\\userservice\\impl\\UserServiceImpl.java")
    expect(out.startsWith("C:\\Users\\EDY\\.octopus")).toBe(true)
    expect(out.length).toBeLessThanOrEqual(72)
  })

  it("尾段太长导致浪费时退一级头，把长度补回来", () => {
    const out = briefValue(`${TASK_ROOT}\\.task-directory-with-a-quite-long-name\\some-file.md`)
    expect(out.endsWith("\\.task-directory-with-a-quite-long-name\\some-file.md")).toBe(true)
    expect(out.length).toBeGreaterThan(60)
  })

  it("末级太长时只保文件名，不把扩展名切掉", () => {
    const out = briefValue(`${TASK_ROOT}\\${"a".repeat(80)}.java`)
    expect(out.endsWith(".java")).toBe(true)
    expect(out.length).toBeLessThanOrEqual(72)
  })
})

describe("工具简报 — 不只 Read，所有工具同一套规则", () => {
  const TASK_ROOT = "C:\\Users\\EDY\\.octopus\\workspaces\\task-m-1029-133431-55fdb6"
  const IMPL = `${TASK_ROOT}\\impl\\UserServiceImpl.java`

  it("Read / Edit / Write 的 file_path 都做中段省略，整行宽度接近", () => {
    const read = toolBrief({ id: "1", name: "Read", input: { file_path: IMPL }, status: "success" })
    const edit = toolBrief({ id: "2", name: "Edit", input: { file_path: IMPL, old_string: "a", new_string: "bb" }, status: "success" })
    const write = toolBrief({ id: "3", name: "Write", input: { file_path: IMPL, content: "x" }, status: "success" })
    for (const line of [read, edit, write]) {
      expect(line.endsWith("\\task-m-1029-133431-55fdb6\\impl\\UserServiceImpl.java")).toBe(true)
      expect(line).toContain("…")
      expect(line.length).toBeLessThanOrEqual(76)
      expect(line.length).toBeGreaterThan(60)
    }
    // 工具名长度不同 → 参数预算倒扣，整行右缘对齐
    expect(Math.abs(read.length - write.length)).toBeLessThanOrEqual(1)
  })

  it("Grep / Glob：首参是 pattern 时，尾部附上路径参数", () => {
    expect(toolBrief({ id: "4", name: "Grep", input: { pattern: "turnStats", path: "packages/web-app" }, status: "success" }))
      .toBe("Grep turnStats · packages/web-app")
    expect(toolBrief({ id: "5", name: "Glob", input: { pattern: "**/*.tsx", path: "packages/web-app/components" }, status: "success" }))
      .toBe("Glob **/*.tsx · packages/web-app/components")
  })

  it("没有可读参数时只显示工具名", () => {
    expect(toolBrief({ id: "6", name: "TodoWrite", input: { todos: [] }, status: "success" })).toBe("TodoWrite")
    expect(toolBrief({ id: "7", name: "Bash", input: {}, status: "success" })).toBe("Bash")
  })
})
