// packages/web-app/components/tasks/run-console/__tests__/signal-build.test.ts
//
// 「大事报」信号合成器单测（2026-09-20 定稿，取代 flow-build 测试）。
// fixtures 形状照抄验收C 真事件（exec 077578ec 实拉审计）：
// isError 行 input 空串 + result 首行 "Exit code 1"、后续同工具成功=自愈、
// Write/Edit input 与 result.filePath 双格式、loopIterations 两代形状。
// 主用例是反向的：**全绿 → 一条信号都没有**（那块 UI 整行不存在）。

import { describe, it, expect } from "vitest"
import type { AgentEvent, LoopIterationSummary } from "@/lib/types"
import { buildSignals } from "../signal-build"

const T0 = Date.parse("2026-09-20T06:00:00.000Z")
const at = (ms: number) => new Date(T0 + ms).toISOString()
const ev = (nodeId: string, event: string, offMs: number, extra: Partial<AgentEvent> = {}): AgentEvent =>
  ({ nodeId, event, timestamp: at(offMs), ...extra } as AgentEvent)
const NO = { live: false }

describe("✗ 挂过 —— 真格式：isError 聚合 + 自愈判定 + result 兜底", () => {
  // C 实测两条：input 是空串，命令没了，只剩 result 首行
  const C_ERR: AgentEvent[] = [
    ev("e2e-verify", "tool_call", 1000, { toolName: "Bash", input: "", isError: true, result: "Exit code 1\n===== java-common-util deps (does it need -am?) =====\n<?xml…" }),
    ev("e2e-verify", "tool_call", 42000, { toolName: "Bash", input: "", isError: true, result: "Exit code 1\n===== PROVIDER: targeted install =====\n…" }),
    ev("e2e-verify", "tool_call", 83000, { toolName: "Bash", input: { command: "mvn -B -pl util install -am" }, result: "BUILD SUCCESS" }),
  ]
  it("同节点两次 Bash 挂 → 一行「挂过 2 次 Bash（均已自愈）」，详情吃 result 首行", () => {
    const l = buildSignals(C_ERR, T0, NO)
    expect(l).toHaveLength(1)
    expect(l[0].text).toBe("e2e-verify 挂过 2 次 Bash（均已自愈）")
    expect(l[0].detail).toMatch(/^Exit code 1/)
  })
  it("后面没有同工具成功 → 「未见恢复」不粉饰", () => {
    const l = buildSignals(C_ERR.slice(0, 1), T0, NO)
    expect(l[0].text).toContain("未见恢复")
  })
  it("input 可解析的新行 → 详情优先命令摘要；引擎内部节点的错不算事", () => {
    const l = buildSignals([
      ev("x", "tool_call", 0, { toolName: "Bash", input: { command: "pnpm build\n-ts" }, isError: true, result: "TS2345" }),
      ev("__engine_init__", "tool_call", 0, { toolName: "Bash", isError: true, result: "boom" }),
    ], T0, NO)
    expect(l).toHaveLength(1)
    expect(l[0].detail).toBe("pnpm build")
  })
})

describe("主用例 —— 全绿不渲染", () => {
  it("节点全 completed、无 isError、无在跑：[] （大事报这块 UI 不存在）", () => {
    const l = buildSignals([
      ev("spec-resolve", "start", 0), ev("spec-resolve", "end", 48, { status: "completed", durationMs: 48 }),
      ev("e2e-verify", "start", 100),
      ev("e2e-verify", "tool_call", 900, { toolName: "Bash", input: { command: "curl -sf :18082/demo" }, result: "ok" }),
      ev("e2e-verify", "tool_call", 1900, { toolName: "Write", input: { file_path: "/w/e2e-data/walkthrough-true.json" } }),
      ev("e2e-verify", "end", 579337, { status: "completed", durationMs: 579337 }),
    ], T0, NO)
    expect(l).toEqual([])
  })
  it("完结态（live=false）即使有 Write/在跑行也不出 📦/▷ —— 履历归账本", () => {
    const l = buildSignals([
      ev("n", "tool_start", 0, { toolCallId: "a", toolName: "Bash", input: { command: "sleep 999" } }),
      ev("n", "tool_call", 1, { toolName: "Edit", input: { file_path: "/x/A.java" } }),
    ], T0 + 5000, NO)
    expect(l).toEqual([])
  })
})

describe("▷ 在跑 —— tool_start 配对（缺 start 行的流自然无此线）", () => {
  const RUN = { live: true }
  it("tool_start 未等到结果 → 「在跑：Bash 已 2m5s（until curl…）」", () => {
    const l = buildSignals([
      ev("e2e", "tool_start", 0, { toolCallId: "t1", toolName: "Bash", input: { command: "until curl -sf :18082; do sleep 2; done" } }),
    ], T0 + 125_000, RUN)
    expect(l[0].kind).toBe("stall")
    expect(l[0].text).toContain("Bash 已 2m 5s")
    expect(l[0].text).toContain("until curl")
  })
  it("有 tool_result / merged tool_call 收口 → 不在跑", () => {
    const l = buildSignals([
      ev("e2e", "tool_start", 0, { toolCallId: "t1", toolName: "Bash", input: { command: "mvn" } }),
      ev("e2e", "tool_result", 5000, { toolCallId: "t1", result: "done" }),
      ev("e2e", "tool_start", 6000, { toolCallId: "t2", toolName: "Read" }),
      ev("e2e", "tool_call", 7000, { toolCallId: "t2", toolName: "Read", result: "x" }),
    ], T0 + 20_000, RUN)
    expect(l.filter((x) => x.kind === "stall")).toEqual([])
  })
  it("C 类流（0 条 tool_start 行，实测）→ 该线缺席而非乱猜", () => {
    const l = buildSignals([ev("e2e", "tool_call", 0, { toolName: "Bash", input: { command: "ls" } })], T0 + 60_000, RUN)
    expect(l.filter((x) => x.kind === "stall")).toEqual([])
  })
})

describe("♻ 修复轮 —— 只有 Loop 节点的流才存在（agent 内部自愈不假装）", () => {
  it("fixed 模式真形状（8月单实拉）：第 cur/total + 挂计数 + 上轮挂因", () => {
    const loops: Record<string, LoopIterationSummary> = {
      "fix-loop": { mode: "fixed", total: 3, completed: 1, failed: 1, current: 3, iterations: [
        { iteration: 1, status: "failed", startedAt: at(0), error: "预览 ready 超时 90s", nodes: [] },
        { iteration: 2, status: "completed", startedAt: at(0), nodes: [] },
        { iteration: 3, status: "running", startedAt: at(0), nodes: [] },
      ] },
    }
    const l = buildSignals([], T0, { live: true, loopIterations: loops })
    expect(l[0].text).toBe("fix-loop 第 3/3 轮 · 已挂 1 轮")
    expect(l[0].detail).toBe("预览 ready 超时 90s")
  })
  it("dynamic 无 total（实测 shape）→ 「第 N 轮」不硬编分母；live 结束=completed+failed+1", () => {
    const l = buildSignals([], T0, { live: false, loopIterations: { execution: { mode: "dynamic", completed: 1, failed: 0, iterations: [] } as unknown as LoopIterationSummary } })
    expect(l[0].text).toBe("execution 第 1 轮")
  })
  it("C 实测 {} / 无 loop 字段 → 绝不出 ♻ 行", () => {
    expect(buildSignals([], T0, { live: true, loopIterations: {} })).toEqual([])
    expect(buildSignals([], T0, { live: true })).toEqual([])
  })
})

describe("📦 产出 —— 仅 live，Write/Edit 去重（真数据 26 调用 → 13 文件口径）", () => {
  it("多工具名 input/result 双格式全吃，重复文件只算一次，前 3 名 +N", () => {
    const l = buildSignals([
      ev("t1", "tool_call", 0, { toolName: "Write", input: { file_path: "/w/LuhnUtils.java" } }),
      ev("t1", "tool_call", 1, { toolName: "Edit", input: { file_path: "/w/LuhnUtils.java" } }),
      ev("t1", "tool_call", 2, { toolName: "Write", input: "", result: '{"file":{"filePath":"/w/LuhnController.java"}}' }),
      ev("t1", "tool_call", 3, { toolName: "Edit", input: { file_path: "/w/A.java" } }),
      ev("t1", "tool_call", 4, { toolName: "Edit", input: { file_path: "/w/B.java" } }),
      ev("t1", "tool_call", 5, { toolName: "Bash", input: { command: "mvn package" } }),
    ], T0, { live: true })
    const o = l.find((x) => x.kind === "out")!
    expect(o.text).toContain("已落 4 个文件")
    expect(o.text).toContain("LuhnUtils.java")
    expect(o.text).toContain("+1")
  })
})
