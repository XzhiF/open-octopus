import { describe, it, expect } from "vitest"
import { VarPool } from "../variables/var-pool"

describe("VarPool.removePrefix", () => {
  it("removes all keys matching prefix", () => {
    const pool = new VarPool({
      "hook.event": "on_success",
      "hook.id": "h1",
      "vars.env": "prod",
      "vars.org": "xzf",
    })

    pool.removePrefix("hook.")

    expect(pool.get("hook.event")).toBeUndefined()
    expect(pool.get("hook.id")).toBeUndefined()
    expect(pool.get("vars.env")).toBe("prod")
    expect(pool.get("vars.org")).toBe("xzf")
  })

  it("does nothing when no keys match", () => {
    const pool = new VarPool({ a: 1, b: 2 })

    pool.removePrefix("hook.")

    expect(pool.get("a")).toBe(1)
    expect(pool.get("b")).toBe(2)
  })

  it("handles empty pool", () => {
    const pool = new VarPool()

    expect(() => pool.removePrefix("hook.")).not.toThrow()
  })

  it("only removes exact prefix matches", () => {
    const pool = new VarPool({
      "hook.event": "on_success",
      "hookx": "should stay",
      "not-hook.event": "should stay",
    })

    pool.removePrefix("hook.")

    expect(pool.get("hook.event")).toBeUndefined()
    expect(pool.get("hookx")).toBe("should stay")
    expect(pool.get("not-hook.event")).toBe("should stay")
  })
})
