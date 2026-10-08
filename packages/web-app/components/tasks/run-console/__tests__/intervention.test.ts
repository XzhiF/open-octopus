// 票 06 · intervention.ts 纯逻辑单测 —— 三块被组件依赖的判断全在这里：
//   ① ⚑ 行抽取（形状 = GET agent-events 的 intervention 事件，见
//      server/__tests__/agent-events-intervention.test.ts 钉死的契约）；
//   ② 恢复弹框三分支状态机（原型 taskboard-v2.html openInject/resume 文案逐字：
//      取消（保持暂停）= 只关窗；直接继续 = 不带干预；注入并继续 = 带 trim 后原文，
//      空文本按原样继续并给提示）；
//   ③ LIVE 卡 ⚑ 干预×N 的「当前节点」口径 —— 最近一次干预的目标节点及其累计数。
// 期望全部来自票面/原型/服务端契约这些独立事实（防自证）。

import { describe, it, expect } from "vitest"
import {
  INTERVENTION_MAX, decideResume, extractInterventions, interventionLineText, interventionStats, isOverLimit,
} from "../intervention"
import type { AgentEvent } from "@/lib/types"

// ── ① ⚑ 行抽取 ───────────────────────────────────────────────────────

const iv = (over: Partial<AgentEvent> = {}): AgentEvent => ({
  nodeId: "impl",
  event: "intervention",
  timestamp: "2026-10-08T02:00:00.000Z",
  data: { nodeId: "impl", nodeName: "开发/修复", prompt: "别动 Dialog 尺寸逻辑" },
  ...over,
})

describe("extractInterventions — GET agent-events → ⚑ 行", () => {
  it("picks intervention events with node name + verbatim prompt + ISO time", () => {
    const rows = extractInterventions([
      { nodeId: "impl", event: "start", timestamp: "2026-10-08T01:59:00.000Z" } as AgentEvent,
      iv(),
      { nodeId: "impl", event: "end", timestamp: "2026-10-08T02:10:00.000Z" } as AgentEvent,
    ])
    expect(rows).toEqual([
      { nodeId: "impl", nodeName: "开发/修复", text: "别动 Dialog 尺寸逻辑", at: "2026-10-08T02:00:00.000Z" },
    ])
  })

  it("multiple injections keep chronological order (server sorts; we do not reshuffle)", () => {
    const a = iv({ timestamp: "2026-10-08T02:00:00.000Z", data: { prompt: "第一刀" } })
    const b = iv({ timestamp: "2026-10-08T02:05:00.000Z", data: { prompt: "第二刀" } })
    const rows = extractInterventions([a, b])
    expect(rows.map((r) => r.text)).toEqual(["第一刀", "第二刀"])
  })

  it("name falls back to the node id when the row lacks nodeName; blank prompt rows are noise → skipped", () => {
    const rows = extractInterventions([
      iv({ data: { prompt: "只给原文" } }),
      iv({ data: { prompt: "   " } }),
      iv({ data: undefined }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].nodeName).toBe("impl")
    expect(rows[0].text).toBe("只给原文")
  })

  it("an empty stream has no ⚑ rows (不打扰：没有干预就一个字不占)", () => {
    expect(extractInterventions([])).toEqual([])
  })
})

describe("interventionLineText — ⚑ 行文案（原型逐字）", () => {
  it("renders ⚑ 人工干预 → 节点「name」：text", () => {
    expect(interventionLineText({ nodeId: "impl", nodeName: "开发/修复", text: "别动 Dialog", at: "x" }))
      .toBe("⚑ 人工干预 → 节点「开发/修复」：别动 Dialog")
  })
})

// ── ② 恢复弹框状态机 ────────────────────────────────────────────────

describe("decideResume — 三分支（取消 / 直接继续 / 注入并继续）", () => {
  it("取消（保持暂停）= close only — no API call, state untouched", () => {
    expect(decideResume("cancel", "写了一半的话")).toEqual({ kind: "close" })
  })

  it("直接继续 ▶ = resume WITHOUT the intervention whatever the textarea holds", () => {
    expect(decideResume("plain", "就算写了字")).toEqual({ kind: "resume" })
  })

  it("⚑ 注入干预并继续 = resume with the trimmed prompt (verbatim content, no reshaping)", () => {
    expect(decideResume("inject", "  不要动 Dialog 尺寸逻辑，直接换固定壳  ")).toEqual({
      kind: "resume",
      intervention: "不要动 Dialog 尺寸逻辑，直接换固定壳",
    })
  })

  it("inject with empty/whitespace text degrades to plain resume + the prototype's notice", () => {
    expect(decideResume("inject", "")).toEqual({ kind: "resume", notice: "没写干预内容 — 按原样继续" })
    expect(decideResume("inject", "   \n ")).toEqual({ kind: "resume", notice: "没写干预内容 — 按原样继续" })
  })
})

// ── 长度上限 ────────────────────────────────────────────────────────

describe("isOverLimit — ≤4000 契约（服务端 routes/tasks.ts resume 同额）", () => {
  it("the cap is exactly 4000 (server 400s at 4001)", () => {
    expect(INTERVENTION_MAX).toBe(4000)
    expect(isOverLimit("x".repeat(INTERVENTION_MAX))).toBe(false)
    expect(isOverLimit("x".repeat(INTERVENTION_MAX + 1))).toBe(true)
  })
})

// ── ③ LIVE 卡 ⚑ 干预×N ─────────────────────────────────────────────

describe("interventionStats — 当前节点累计口径（US16，票10 review-7 定版）", () => {
  const rows = [
    { nodeId: "a", nodeName: "节点A", text: "1", at: "2026-10-08T01:00:00.000Z" },
    { nodeId: "a", nodeName: "节点A", text: "2", at: "2026-10-08T01:10:00.000Z" },
    { nodeId: "b", nodeName: "节点B", text: "3", at: "2026-10-08T01:20:00.000Z" },
  ]
  it("给了当前节点 → ×N = 该节点的累计（同节点多次注入全部计入）", () => {
    expect(interventionStats(rows, "a")).toEqual({ total: 3, currentNodeName: "节点A", currentNodeCount: 2 })
    expect(interventionStats(rows, "b")).toEqual({ total: 3, currentNodeName: "节点B", currentNodeCount: 1 })
  })
  it("执行推进到零干预的新节点 → 当前节点计数归 0（卡片按 >0 才挂 chip，即 0/不显示）", () => {
    expect(interventionStats(rows, "c")).toEqual({ total: 3, currentNodeName: null, currentNodeCount: 0 })
    expect(interventionStats(rows, null)).toEqual({ total: 3, currentNodeName: null, currentNodeCount: 0 })
  })
  it("省略当前节点（调用方无节点现场知识）→ 兜底旧口径：最近一次干预的目标节点", () => {
    expect(interventionStats(rows)).toEqual({ total: 3, currentNodeName: "节点B", currentNodeCount: 1 })
  })
  it("empty rows render nothing", () => {
    expect(interventionStats([], "a")).toEqual({ total: 0, currentNodeName: null, currentNodeCount: 0 })
    expect(interventionStats([])).toEqual({ total: 0, currentNodeName: null, currentNodeCount: 0 })
  })
})
