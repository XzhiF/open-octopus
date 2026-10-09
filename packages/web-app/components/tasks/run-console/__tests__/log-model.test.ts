// 票 11 ⑩回补 — 「▶ 日志」页签的事件流映射纯逻辑（agent_events → 展示行）。
//
// 分类行词表复用 票04 nodes-model 的单源（buildEventLines 家族），这里只补日志
// 形态特有的两件事：时间正序 + 逐行时刻（原型 consoleHtml 的 .ts 前缀）。
// 期望值为独立手拼 fixture（防自证）：
//   start=· dim · end completed=✓ green · tool_call=⚙（失败 ✗ red）·
//   bash_output=$ · intervention=⚑ pink（intervention 标记）· heartbeat=噪声剔除。

import { describe, it, expect } from "vitest"
import type { AgentEvent } from "@/lib/types"
import { buildLogLines } from "../log-model"

const ev = (over: Partial<AgentEvent> & { event: string }): AgentEvent =>
  ({ nodeId: "dev", timestamp: "2026-10-08T01:00:00.000Z", ...over }) as AgentEvent

describe("buildLogLines — 时间正序分类行（票11 日志归位）", () => {
  it("乱序输入 → 按 timestamp 正序输出；噪声事件（heartbeat）不占行", () => {
    const lines = buildLogLines([
      ev({ event: "intervention", timestamp: "2026-10-08T02:00:00.000Z", data: { nodeId: "dev", nodeName: "开发/修复", prompt: "别动 Dialog 尺寸逻辑" } }),
      ev({ event: "text_block", timestamp: "2026-10-08T01:40:00.000Z", content: "分析上下文" }),
      ev({ event: "heartbeat", timestamp: "2026-10-08T01:30:00.000Z" }),
      ev({ event: "tool_call", timestamp: "2026-10-08T01:10:00.000Z", toolName: "Edit", input: { file_path: "a.tsx" } }),
      ev({ event: "end", timestamp: "2026-10-08T01:00:00.000Z", status: "completed", durationMs: 90_000 }),
    ])
    expect(lines.map((l) => l.glyph)).toEqual(["✓", "⚙", "▸", "⚑"])
    expect(lines.map((l) => l.at)).toEqual([
      "2026-10-08T01:00:00.000Z",
      "2026-10-08T01:10:00.000Z",
      "2026-10-08T01:40:00.000Z",
      "2026-10-08T02:00:00.000Z",
    ])
  })

  it("工具/编辑/成败/警告分类词表：失败工具行 ✗ red，成功 ⚙；bash 输出 $ 行", () => {
    const lines = buildLogLines([
      ev({ event: "tool_call", toolName: "Bash", isError: true, input: "pnpm test" }),
      ev({ event: "bash_output", content: "41 passed" }),
    ])
    expect(lines[0]!.glyph).toBe("✗")
    expect(lines[0]!.tone).toBe("red")
    expect(lines[1]!.glyph).toBe("$")
  })

  it("⚑ 人工干预行 = intervention 标记 + pink 语义（票06 落库形状一等直通）", () => {
    const lines = buildLogLines([
      ev({ event: "intervention", data: { nodeId: "dev", nodeName: "开发/修复", prompt: "直接换固定壳" } }),
    ])
    expect(lines).toHaveLength(1)
    expect(lines[0]!.intervention).toBe(true)
    expect(lines[0]!.tone).toBe("pink")
    expect(lines[0]!.glyph).toBe("⚑")
    expect(lines[0]!.text).toContain("人工干预")
    expect(lines[0]!.text).toContain("直接换固定壳")
  })

  it("limit 取尾部（最新事件保留）；空输入 → 空数组", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      ev({ event: "bash_log", line: `l${i}`, timestamp: `2026-10-08T00:00:${String(i).padStart(2, "0")}.000Z` }),
    )
    const lines = buildLogLines(many, 5)
    expect(lines).toHaveLength(5)
    expect(lines[4]!.text).toBe("l29")
    expect(buildLogLines([])).toEqual([])
  })

  it("缺 timestamp 的行不炸，且排在有时刻行之后（追加语义）", () => {
    const lines = buildLogLines([
      ev({ event: "tool_call", toolName: "Read", timestamp: undefined }),
      ev({ event: "end", status: "completed", timestamp: "2026-10-08T01:00:00.000Z" }),
    ])
    expect(lines.map((l) => l.glyph)).toEqual(["✓", "⚙"])
    expect(lines[0]!.at).toBe("2026-10-08T01:00:00.000Z")
    expect(lines[1]!.at).toBeNull()
  })
})
