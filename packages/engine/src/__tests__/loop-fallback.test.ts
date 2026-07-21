import { describe, it, expect } from "vitest"
import { VarPool } from "@octopus/shared"
import { extractBreakWhenVars, forceAdvanceLoopVars } from "../executors/loop-fallback"

describe("extractBreakWhenVars", () => {
  it("extracts left-operand var from >= comparison", () => {
    expect(extractBreakWhenVars("$vars.current_spec >= $vars.spec_count"))
      .toEqual(["current_spec"])
  })

  it("extracts var from == comparison", () => {
    expect(extractBreakWhenVars("$vars.found == true"))
      .toEqual(["found"])
  })

  it("extracts multiple vars from && expression", () => {
    expect(extractBreakWhenVars("$vars.x >= 5 && $vars.y > 3"))
      .toEqual(["x", "y"])
  })

  it("extracts var from < comparison", () => {
    expect(extractBreakWhenVars("$vars.count < $vars.max"))
      .toEqual(["count"])
  })

  it("returns empty for expression without $vars", () => {
    expect(extractBreakWhenVars("true")).toEqual([])
    expect(extractBreakWhenVars("$iteration >= 5")).toEqual([])
  })

  it("deduplicates repeated vars", () => {
    expect(extractBreakWhenVars("$vars.x >= 1 && $vars.x <= 10"))
      .toEqual(["x"])
  })

  it("returns empty for $nodeId.output references", () => {
    expect(extractBreakWhenVars("$check.output.status == 'done'"))
      .toEqual([])
  })
})

describe("forceAdvanceLoopVars", () => {
  it("increments numeric variable that didn't change", () => {
    const pool = new VarPool({ count: 3 })
    const snapshot = new Map<string, unknown>([["count", 3]])
    const result = forceAdvanceLoopVars(pool, ["count"], snapshot)
    expect(result.applied).toBe(true)
    expect(result.changes).toEqual([{ key: "count", oldVal: 3, newVal: 4 }])
    expect(pool.get("count")).toBe(4)
  })

  it("skips variable that already changed", () => {
    const pool = new VarPool({ count: 5 })
    const snapshot = new Map<string, unknown>([["count", 3]])
    const result = forceAdvanceLoopVars(pool, ["count"], snapshot)
    expect(result.applied).toBe(false)
    expect(result.changes).toEqual([])
    expect(pool.get("count")).toBe(5)
  })

  it("increments numeric string preserving type", () => {
    const pool = new VarPool({ index: "2" })
    const snapshot = new Map<string, unknown>([["index", "2"]])
    const result = forceAdvanceLoopVars(pool, ["index"], snapshot)
    expect(result.applied).toBe(true)
    expect(pool.get("index")).toBe("3")
    expect(typeof pool.get("index")).toBe("string")
  })

  it("handles undefined variable (treats as 0 → 1)", () => {
    const pool = new VarPool({})
    const snapshot = new Map<string, unknown>([["counter", undefined]])
    const result = forceAdvanceLoopVars(pool, ["counter"], snapshot)
    expect(result.applied).toBe(true)
    expect(pool.get("counter")).toBe(1)
  })

  it("skips non-numeric string variable", () => {
    const pool = new VarPool({ status: "running" })
    const snapshot = new Map<string, unknown>([["status", "running"]])
    const result = forceAdvanceLoopVars(pool, ["status"], snapshot)
    expect(result.applied).toBe(false)
    expect(result.skippedVars).toEqual(["status"])
  })

  it("skips boolean variable", () => {
    const pool = new VarPool({ found: false })
    const snapshot = new Map<string, unknown>([["found", false]])
    const result = forceAdvanceLoopVars(pool, ["found"], snapshot)
    expect(result.applied).toBe(false)
    expect(result.skippedVars).toEqual(["found"])
  })

  it("handles mixed: some numeric, some not", () => {
    const pool = new VarPool({ count: 2, status: "pending" })
    const snapshot = new Map<string, unknown>([["count", 2], ["status", "pending"]])
    const result = forceAdvanceLoopVars(pool, ["count", "status"], snapshot)
    expect(result.applied).toBe(true)
    expect(result.changes).toHaveLength(1)
    expect(result.changes[0].key).toBe("count")
    expect(result.skippedVars).toEqual(["status"])
  })

  it("does not advance target variable in two-var comparison", () => {
    // break_when: "$vars.current >= $vars.total"
    // extractBreakWhenVars returns only ["current"]
    const pool = new VarPool({ current: 2, total: 5 })
    const snapshot = new Map<string, unknown>([["current", 2]])
    const result = forceAdvanceLoopVars(pool, ["current"], snapshot)
    expect(pool.get("current")).toBe(3)
    expect(pool.get("total")).toBe(5)
  })
})
