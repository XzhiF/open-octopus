import { describe, it, expect } from "vitest"
import { toEpochMs, buildTurnBoundaries, deriveTurnForTs } from "../turn-index"

// 轮次派生单一真相源（P）：llm_calls 时间窗。写侧 replaceMergedEvents 与读侧
// assignTurnsToEvents 共用，杜绝「多回合塌成 turn_index=1」。

describe("toEpochMs", () => {
  it("int epoch-ms 原样", () => { expect(toEpochMs(1788053279227)).toBe(1788053279227) })
  it("数字字符串转数", () => { expect(toEpochMs("1788053279227")).toBe(1788053279227) })
  it("ISO 串解析", () => { expect(toEpochMs("2026-01-01T00:00:01.000Z")).toBe(Date.parse("2026-01-01T00:00:01.000Z")) })
  it("坏值 → 0", () => { expect(toEpochMs(undefined)).toBe(0); expect(toEpochMs("not-a-date")).toBe(0) })
})

describe("buildTurnBoundaries", () => {
  it("每回合取最早 ts、升序", () => {
    const b = buildTurnBoundaries([
      { turn_index: 2, timestamp: 2000 },
      { turn_index: 1, timestamp: 1000 },
      { turn_index: 2, timestamp: 2500 }, // 同回合并行 call
      { turn_index: 3, timestamp: 3000 },
    ])
    expect(b).toEqual([{ turn: 1, ts: 1000 }, { turn: 2, ts: 2000 }, { turn: 3, ts: 3000 }])
  })
  it("空 → []", () => { expect(buildTurnBoundaries([])).toEqual([]) })
})

describe("deriveTurnForTs", () => {
  const bounds = buildTurnBoundaries([
    { turn_index: 1, timestamp: 1000 },
    { turn_index: 2, timestamp: 2000 },
    { turn_index: 3, timestamp: 3000 },
  ])
  it("lead-in（早于首调用）归第 1 回合，不产 0", () => {
    expect(deriveTurnForTs(bounds, 500)).toBe(1)
  })
  it("精确命中回合起点", () => {
    expect(deriveTurnForTs(bounds, 2000)).toBe(2)
  })
  it("回合内后续事件顺延本回合", () => {
    expect(deriveTurnForTs(bounds, 2700)).toBe(2)
    expect(deriveTurnForTs(bounds, 99999)).toBe(3) // 末回合之后归末回合
  })
  it("无边界（非 agent 节点）→ 1", () => {
    expect(deriveTurnForTs([], 500)).toBe(1)
  })
})
