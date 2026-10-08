// packages/web-app/components/tasks/files-tab/__tests__/files-tab-model.test.ts
//
// 票03「≡ 变更」纯逻辑单源：统计同源、刷新节流、比例条、分组序。
// 期望值全部来自票 03 / spec 故事 6/8/9 的字面口径与 fixture 手算，不重跑实现算式。
import { describe, it, expect } from "vitest"
import type { RoundDiffPayload } from "@/lib/tasks-api"
import {
  FILES_POLL_MS, FILES_EVENT_MIN_GAP_MS,
  scopeTotals, throttleDue, throttleWaitMs, canServeRoundDiff, addRatio, sortRepoGroups,
} from "../files-tab-model"

function payload(over: Partial<RoundDiffPayload> = {}): RoundDiffPayload {
  return {
    available: true,
    aggregate: { commits: 0, additions: 0, dels: 0, files: 0 },
    interventions: null,
    repos: [],
    ...over,
  }
}

describe("scopeTotals — 统计条与列表同源（只算在场仓库；票09 台账预览复用）", () => {
  it("多仓求和，expired 仓不入数（它被单独列警示，不是数字）", () => {
    const d = payload({
      interventions: 3,
      repos: [
        { name: "a", commits: 2, additions: 40, dels: 7, files: 3, truncated: false, groups: [] },
        { name: "b", expired: true, reason: "no_commits", commits: 9, additions: 99, dels: 99, files: 9, truncated: false, groups: [] },
        { name: "c", commits: 1, additions: 5, dels: 2, files: 1, truncated: false, groups: [] },
      ],
    })
    // 手算：commits 2+1、files 3+1、+40+5、−7+2；b 全弃。
    expect(scopeTotals(d)).toEqual({ commits: 3, files: 4, additions: 45, dels: 9, interventions: 3 })
  })

  it("无数据 = 全零 + interventions 未知（null，不是 0 —— 「—」与「0」两个口径）", () => {
    expect(scopeTotals(null)).toEqual({ commits: 0, files: 0, additions: 0, dels: 0, interventions: null })
    expect(scopeTotals(payload({ repos: [] })).interventions).toBeNull()
  })

  it("零变更轮（start==end 的诚实零）→ 数字为 0 且 interventions 透传", () => {
    const d = payload({ interventions: 0, aggregate: { commits: 0, additions: 0, dels: 0, files: 0 } })
    expect(scopeTotals(d)).toEqual({ commits: 0, files: 0, additions: 0, dels: 0, interventions: 0 })
  })
})

describe("刷新节流 — spec 故事9：事件触发 + ≤10s 兜底轮询", () => {
  it("轮询周期不得超过 10s 观测口径（spec 钉值，未来改大即红）", () => {
    expect(FILES_POLL_MS).toBeLessThanOrEqual(10_000)
    expect(FILES_EVENT_MIN_GAP_MS).toBeLessThan(FILES_POLL_MS)
  })

  it("throttleDue：首次恒可发；间隔内拒发；踩线（=minGap）放行", () => {
    expect(throttleDue(1000, null, 1500)).toBe(true)
    expect(throttleDue(1000, 0, 1500)).toBe(false) // 才过 1000 < 1500
    expect(throttleDue(1500, 0, 1500)).toBe(true)
    expect(throttleDue(1499, 0, 1500)).toBe(false)
  })

  it("throttleWaitMs：被拒的事件刷新 → 补足到 minGap 的尾巴延迟", () => {
    expect(throttleWaitMs(1000, 0, 1500)).toBe(500)
    expect(throttleWaitMs(2000, 0, 1500)).toBe(0)
  })

  it("可供货态 = running/paused/awaiting_review；ready/终态不拉（409 面上无货）", () => {
    for (const s of ["running", "paused", "awaiting_review"]) expect(canServeRoundDiff(s)).toBe(true)
    for (const s of ["draft", "ready", "archiving", "done", "failed", "aborted"]) expect(canServeRoundDiff(s)).toBe(false)
  })
})

describe("比例条与分组序 — 原型 fitem 的 dbar / repo 组排序", () => {
  it("addRatio = adds/(adds+dels)；零变更兜底全绿（原型 pct 口径）", () => {
    expect(addRatio(8, 2)).toBeCloseTo(0.8)
    expect(addRatio(0, 5)).toBe(0)
    expect(addRatio(0, 0)).toBe(1)
  })

  it("sortRepoGroups：churn 降序；同 churn 按 dir 字典序（去抖动，两轮渲染序一致）", () => {
    const out = sortRepoGroups([
      { dir: "lib", additions: 1, dels: 1 },
      { dir: "packages", additions: 9, dels: 0 },
      { dir: "docs", additions: 1, dels: 1 },
    ])
    expect(out.map((g) => g.dir)).toEqual(["packages", "docs", "lib"])
  })

  it("不改动入参（React 渲染安全）", () => {
    const src = [{ dir: "b", additions: 0, dels: 0 }, { dir: "a", additions: 0, dels: 0 }]
    sortRepoGroups(src)
    expect(src.map((g) => g.dir)).toEqual(["b", "a"])
  })
})
