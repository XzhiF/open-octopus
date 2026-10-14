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
import fs from "fs"
import path from "path"
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

// 票08 清理账 · spec 故事33：shadow-compare 冻结只读的「零新增消费者」负断言（grep 面）。
// 端点/服务保留=有意历史审计面，删除留 P4 后议；此测试把「勿新增消费者」钉成机器闸——
// 任何源码（非测试）文件引用 buildShadowComparison，除唯一授权消费点 routes/execution.ts
// 与服务自身外，一律判红。
describe("shadow-compare 冻结面 — 零新增消费者（票08 · 故事33）", () => {
  const packagesRoot = path.resolve(__dirname, "../../../../..")
  const ALLOWED_BASENAMES = new Set(["shadow-compare.ts", "execution.ts"])
  const SKIP_DIRS = new Set(["node_modules", "dist", ".next", ".turbo", "e2e", "__tests__", ".git", "coverage"])

  function walk(dir: string, out: string[]): void {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        walk(abs, out)
      } else if (/\.(ts|tsx)$/.test(e.name)) {
        out.push(abs)
      }
    }
  }

  it("只有 routes/execution.ts（+ 服务自身）引用 buildShadowComparison，无新增消费者", () => {
    const files: string[] = []
    walk(packagesRoot, files)

    const offenders = files
      .filter((f) => {
        const base = path.basename(f)
        if (ALLOWED_BASENAMES.has(base)) return false
        const text = fs.readFileSync(f, "utf-8")
        // 只认对导出符号的真实引用，排除纯注释/文档串里的巧合提及。
        return (
          text.includes("buildShadowComparison") ||
          /from ["'][^"']*knowledge\/shadow-compare["']/.test(text) ||
          /from ["']\.\.?\/[^"']*shadow-compare["']/.test(text)
        )
      })
      .map((f) => path.relative(packagesRoot, f))

    expect(offenders).toEqual([])

    // 正断言：唯一授权消费点 routes/execution.ts 确实 import 本服务（冻结端点在位）。
    const routeFile = path.join(packagesRoot, "server/src/routes/execution.ts")
    expect(fs.existsSync(routeFile)).toBe(true)
    expect(fs.readFileSync(routeFile, "utf-8")).toContain("buildShadowComparison")
  })
})
