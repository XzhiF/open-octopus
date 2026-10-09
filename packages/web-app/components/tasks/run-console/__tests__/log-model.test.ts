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

// ── 票11 双轴 review 收口① — 既有 SSE 通道的 wire → AgentEvent 映射 ──────────
// 通道 = GET /api/workspaces/:ws/executions/events（engine 经 EngineCallbacks.onAgentEvent
// 以 "agent_event" emit，载荷 {executionId, nodeId, event}，event = engine
// agent-types.ts 联合）。实时追加只转「结构性事实」：tool_result ⚙/✗、error ✗、
// intervention/intervention_result ⚑、harness_directive ⚑；text/thinking 增量碎片、
// turn_usage/status/heartbeat 等噪声跳过 —— 合并形（text_block/thinking_block/带输入
// 摘要的 tool_call）由轮询权威补全，防单流被 token 碎片刷屏。

import { agentEventFromWire, retainNewerThan } from "../log-model"

describe("agentEventFromWire — SSE agent_event 实时追加映射（票11 收口①）", () => {
  const wire = (event: Record<string, unknown>, nodeId = "dev") => ({ nodeId, event })

  it("tool_result → tool_call 形（⚙ 成功 / ✗ isError），timestamp epoch ms → ISO", () => {
    const ok = agentEventFromWire("dev", { type: "tool_result", toolCallId: "t1", toolName: "Write", content: "created x.ts", isError: false, timestamp: Date.parse("2026-10-08T03:00:00.000Z") })
    expect(ok).toMatchObject({ nodeId: "dev", event: "tool_call", toolName: "Write", toolCallId: "t1", result: "created x.ts", isError: false, timestamp: "2026-10-08T03:00:00.000Z" })
    const bad = agentEventFromWire("dev", { type: "tool_result", toolName: "Bash", content: "Exit code 1", isError: true, timestamp: Date.parse("2026-10-08T03:00:01.000Z") })
    expect(bad).toMatchObject({ event: "tool_call", isError: true })
  })

  it("error / intervention / intervention_result → 包装形（nodes-model 既有分类行认）", () => {
    const err = agentEventFromWire("dev", { type: "error", code: "E", message: "SDK 连接断裂", timestamp: 1760000000000 })
    expect(err).toMatchObject({ event: "agent_event", event_data: { type: "error", message: "SDK 连接断裂" } })
    const iv = agentEventFromWire("dev", { type: "intervention_result", content: "已注入", timestamp: 1760000000000 })
    expect(iv?.event).toBe("agent_event")
    expect(iv?.event_data?.type).toBe("intervention_result")
  })

  it("harness_directive → data 携指令（⚑ pink 行既有分支）", () => {
    const h = agentEventFromWire("dev", { type: "harness_directive", data: { directive: "停", reason: "烧钱" } })
    expect(h).toMatchObject({ event: "harness_directive", data: { directive: "停", reason: "烧钱" } })
    expect(h?.timestamp).toBeTruthy() // 无 timestamp 字段时落当下时刻（可排序）
  })

  it("噪声 wire（thinking/text_delta/status/turn_usage/heartbeat/active_goal/tool_start/tool_input）→ null 不落行", () => {
    for (const t of ["thinking", "text_delta", "status", "turn_usage", "heartbeat", "heartbeat_stall", "active_goal", "tool_start", "tool_input"]) {
      expect(agentEventFromWire("dev", { type: t, timestamp: 1760000000000 })).toBeNull()
    }
    expect(agentEventFromWire("dev", null)).toBeNull()
    expect(agentEventFromWire("dev", undefined)).toBeNull()
    expect(agentEventFromWire("dev", {})).toBeNull()
    expect(agentEventFromWire("dev", { type: 42 })).toBeNull()
  })

  it("映射行经 buildLogLines 直接成分类行（与轮询快照同一词表 —— 同一事实源）", () => {
    const line = agentEventFromWire("dev", { type: "tool_result", toolName: "Edit", content: "ok", isError: false, timestamp: Date.parse("2026-10-08T03:00:00.000Z") })
    expect(line).toBeTruthy()
    const lines = buildLogLines([line!])
    expect(lines[0]).toMatchObject({ glyph: "⚙" })
    expect(lines[0]!.text).toContain("Edit")
    expect(lines[0]!.at).toBe("2026-10-08T03:00:00.000Z")
  })
})

describe("retainNewerThan — 轮询快照自愈实时追加（票11 收口①：兜底不双现）", () => {
  const snap = (ts: string): AgentEvent => ({ nodeId: "dev", event: "tool_call", timestamp: ts })
  it("时刻 ≤ 快照最晚事件的追加被丢（已被权威快照覆盖）；严格更晚保留", () => {
    const snapshot = [snap("2026-10-08T03:00:00.000Z"), snap("2026-10-08T03:05:00.000Z")]
    const appended = [
      { nodeId: "dev", event: "tool_call", timestamp: "2026-10-08T03:00:00.000Z" }, // 双现同刻 → 丢
      { nodeId: "dev", event: "tool_call", timestamp: "2026-10-08T02:59:00.000Z" }, // 更旧 → 丢
      { nodeId: "dev", event: "tool_call", timestamp: "2026-10-08T03:06:00.000Z" }, // 更新 → 留
    ]
    expect(retainNewerThan(appended, snapshot).map((e) => e.timestamp)).toEqual(["2026-10-08T03:06:00.000Z"])
  })
  it("空快照 → 全保留；缺 timestamp 的追加行保守保留（不误删）", () => {
    const a = { nodeId: "dev", event: "x", timestamp: "2026-10-08T03:00:00.000Z" } as AgentEvent
    const b = { nodeId: "dev", event: "y" } as AgentEvent
    expect(retainNewerThan([a, b], [])).toHaveLength(2)
    expect(retainNewerThan([a, b], [snap("2026-10-08T04:00:00.000Z")])).toHaveLength(1)
  })
})
