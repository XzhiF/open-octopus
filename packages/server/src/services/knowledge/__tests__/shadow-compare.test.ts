// packages/server/src/services/knowledge/__tests__/shadow-compare.test.ts
//
// LLM-WIKI P1 ticket 12 — 影子对照导出四象限（story 31，P2 单向门的决策数据）。
// 输入 = executions.var_pool 持久化快照（历史形态：precompute 落 __relevant_rule_ids、
// KnowledgeInjector 落 __injected_rule_ids —— 均为 JSON 字符串形态；执行者经
// vars_update 落 wiki_refs 原始数组，含 stale: 前缀条目。知识中心票 08 已物理删除
// 注入侧生产者，新执行不再有 __ 键；本 fixture 冻结的是历史快照形态 = 证据链审计面，
// 读侧解析逻辑冻结只读，不随删除改动）。
// 期望形状 = fixture 冻结字面量，禁止从实现自证（票 12 S2 缝约定）：
//   hit        = injected ∩ queried       （注入且被查阅 = 双轨一致）
//   miss       = relevant \ injected      （预计算判相关但没进 prompt = 注入侧未命中/容量饥饿）
//   injectOnly = injected \ queried       （注入了没人查 = 注入侧冗余）
//   queryOnly  = queried \ injected       （自主查到注入没覆盖 = 注入盲区）
// stale 条目单独可筛（票 12 第 2 项）。

import { describe, it, expect } from "vitest"
import { buildShadowComparison, SHADOW_QUERY_KEY, SHADOW_RELEVANT_KEY, SHADOW_INJECTED_KEY } from "../shadow-compare"

// —— fixture（独立真相源：四象限手算如下）——
// relevant = [oct-001, oct-007, oct-009, oct-013]
// injected = [oct-001, oct-007]                      → miss = [oct-009, oct-013]
// wiki_refs = [oct-007, stale:oct-009, wf-sop-002]   → queried = {oct-007, oct-009, wf-sop-002}
// hit = [oct-007] · injectOnly = [oct-001] · queryOnly = [oct-009, wf-sop-002] · stale = [oct-009]
const SHADOW_POOL = {
  workflow_name: "shadow-wf",
  __user_preference_text: "tabs over spaces",
  __relevant_rule_ids: JSON.stringify(["oct-001", "oct-007", "oct-009", "oct-013"]),
  __injected_rule_ids: JSON.stringify(["oct-001", "oct-007"]),
  wiki_refs: ["oct-007", "stale:oct-009", "wf-sop-002"],
}

describe("buildShadowComparison — 四象限 fixture 冻结（票 12 · story 31）", () => {
  it("exports the four quadrants exactly as hand-computed from the fixture", () => {
    const out = buildShadowComparison("exec-shadow-1", SHADOW_POOL)

    expect(out.executionId).toBe("exec-shadow-1")
    expect(out.quadrants).toEqual({
      hit: ["oct-007"],
      miss: ["oct-009", "oct-013"],
      injectOnly: ["oct-001"],
      queryOnly: ["oct-009", "wf-sop-002"],
    })
  })

  it("echoes both tracks raw: inject side (relevant/injected) + query side (refs/stale)", () => {
    const out = buildShadowComparison("exec-shadow-1", SHADOW_POOL)

    expect(out.injectSide).toEqual({
      relevant: ["oct-001", "oct-007", "oct-009", "oct-013"],
      injected: ["oct-001", "oct-007"],
    })
    expect(out.querySide).toEqual({
      refs: ["oct-007", "stale:oct-009", "wf-sop-002"],
      queried: ["oct-007", "oct-009", "wf-sop-002"], // stale: 前缀归一后并入查阅集
      stale: ["oct-009"],                             // stale 上报单独可筛
    })
  })

  it("hit-rate primitives for the P1 acceptance rule（查阅命中率 ≥ 注入相关率）", () => {
    const out = buildShadowComparison("exec-shadow-1", SHADOW_POOL)
    expect(out.metrics).toEqual({
      injectedCount: 2,
      queriedCount: 3,
      hitCount: 1,
      staleCount: 1,
    })
  })

  it("VarPool-native array for __relevant_rule_ids/__injected_rule_ids is tolerated (pool shape from JSONL may arrive pre-parsed)", () => {
    const out = buildShadowComparison("exec-native", {
      __relevant_rule_ids: ["a", "b"],
      __injected_rule_ids: ["a"],
      wiki_refs: ["b"],
    })
    expect(out.quadrants).toEqual({ hit: [], miss: ["b"], injectOnly: ["a"], queryOnly: ["b"] })
  })

  it("pool without any inject-side keys → inject side empty, everything queried is queryOnly", () => {
    const out = buildShadowComparison("exec-query-only", { wiki_refs: ["wf-sop-002"] })
    expect(out.injectSide).toEqual({ relevant: [], injected: [] })
    expect(out.quadrants).toEqual({ hit: [], miss: [], injectOnly: [], queryOnly: ["wf-sop-002"] })
  })

  it("no wiki_refs (mode=inject 回滚态执行) → query side empty, injected all injectOnly", () => {
    const out = buildShadowComparison("exec-rolled-back", {
      __relevant_rule_ids: JSON.stringify(["oct-001"]),
      __injected_rule_ids: JSON.stringify(["oct-001"]),
    })
    expect(out.querySide).toEqual({ refs: [], queried: [], stale: [] })
    expect(out.quadrants).toEqual({ hit: [], miss: [], injectOnly: ["oct-001"], queryOnly: [] })
  })

  it("null pool (execution without persisted var_pool yet) → stable empty shape, never throws", () => {
    const out = buildShadowComparison("exec-empty", null)
    expect(out).toEqual({
      executionId: "exec-empty",
      injectSide: { relevant: [], injected: [] },
      querySide: { refs: [], queried: [], stale: [] },
      quadrants: { hit: [], miss: [], injectOnly: [], queryOnly: [] },
      metrics: { injectedCount: 0, queriedCount: 0, hitCount: 0, staleCount: 0 },
    })
  })

  it("corrupt key payloads degrade to empty side, never crash the export", () => {
    const out = buildShadowComparison("exec-corrupt", {
      __relevant_rule_ids: "{not json",
      __injected_rule_ids: JSON.stringify({ object: "not-array" }),
      wiki_refs: "not-an-array",
    })
    expect(out.quadrants).toEqual({ hit: [], miss: [], injectOnly: [], queryOnly: [] })
  })

  it("VarPool key contract matches the read-only inject-side producers + ticket 11 wiki_refs token", () => {
    expect(SHADOW_RELEVANT_KEY).toBe("__relevant_rule_ids")
    expect(SHADOW_INJECTED_KEY).toBe("__injected_rule_ids")
    expect(SHADOW_QUERY_KEY).toBe("wiki_refs")
  })
})
