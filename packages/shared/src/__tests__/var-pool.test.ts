import { describe, it, expect } from "vitest"
import { VarPool } from "../variables/var-pool"

describe("VarPool", () => {
  it("read and write", () => {
    const pool = new VarPool({ org: "xzf", count: 0 })
    expect(pool.get("org")).toBe("xzf")
    pool.set("count", 1)
    expect(pool.get("count")).toBe(1)
  })

  it("update from dict", () => {
    const pool = new VarPool({ x: 1 })
    pool.update({ x: 2, y: 3 })
    expect(pool.get("x")).toBe(2)
    expect(pool.get("y")).toBe(3)
  })

  it("snapshot preserves state", () => {
    const pool = new VarPool({ a: 10 })
    const snap = pool.snapshot()
    pool.set("a", 20)
    expect(snap.a).toBe(10)
    expect(pool.get("a")).toBe(20)
  })

  it("asRecord returns current values", () => {
    const pool = new VarPool({ a: 1 })
    expect(pool.asRecord().a).toBe(1)
  })

  it("fork dirty tracking: merge only applies actually changed keys", () => {
    const pool = new VarPool({ counter: 0, search_found: false, even_count: 0, odd_count: 0 })
    const fork1 = pool.fork()
    const fork2 = pool.fork()
    const fork3 = pool.fork()

    // fork1 only modifies counter
    fork1.set("counter", 5)
    // fork2 only modifies search_found
    fork2.set("search_found", true)
    fork2.set("search_iteration", 3)
    // fork3 only modifies even_count and odd_count
    fork3.set("even_count", 5)
    fork3.set("odd_count", 5)

    pool.merge([fork1, fork2, fork3])

    // All changes should be preserved — unmodified keys in sibling forks
    // must NOT overwrite each other
    expect(pool.get("counter")).toBe(5)
    expect(pool.get("search_found")).toBe(true)
    expect(pool.get("search_iteration")).toBe(3)
    expect(pool.get("even_count")).toBe(5)
    expect(pool.get("odd_count")).toBe(5)
  })

  it("merge with last-writer still wins when both forks modify the same key", () => {
    const pool = new VarPool({ x: 1 })
    const fork1 = pool.fork()
    const fork2 = pool.fork()

    fork1.set("x", 10)
    fork2.set("x", 99)

    pool.merge([fork1, fork2])

    // Both forks explicitly set x — last fork wins
    expect(pool.get("x")).toBe(99)
  })

  it("fork child does not inherit parent dirty state", () => {
    const pool = new VarPool({ a: 1 })
    pool.set("a", 2)
    pool.set("b", 3)
    // pool.dirty = {a, b}

    const fork = pool.fork()
    // fork inherits a=2, b=3 but starts with empty dirty set
    // fork doesn't change anything
    pool.merge([fork])

    // fork didn't modify anything, so merge is a no-op
    expect(pool.get("a")).toBe(2)
    expect(pool.get("b")).toBe(3)
  })
})

describe("VarPool refResolver", () => {
  it("resolveRef returns undefined without resolver", () => {
    const pool = new VarPool({})
    expect(pool.hasRefResolver()).toBe(false)
    expect(pool.resolveRef("workflow.node.output")).toBeUndefined()
  })

  it("resolveRef delegates to resolver function", () => {
    const pool = new VarPool({})
    pool.setRefResolver((refPath: string) => {
      if (refPath === "security-scan.scan.vulnerabilities") return "3 critical issues"
      return undefined
    })

    expect(pool.hasRefResolver()).toBe(true)
    expect(pool.resolveRef("security-scan.scan.vulnerabilities")).toBe("3 critical issues")
    expect(pool.resolveRef("unknown.workflow.key")).toBeUndefined()
  })

  it("resolveRef handles resolver errors gracefully", () => {
    const pool = new VarPool({})
    pool.setRefResolver(() => {
      throw new Error("DB connection failed")
    })

    expect(pool.resolveRef("any.path")).toBeUndefined()
  })

  it("fork propagates refResolver to child pools", () => {
    const pool = new VarPool({})
    pool.setRefResolver((refPath: string) => {
      if (refPath === "wf.node.key") return "resolved-value"
      return undefined
    })

    const fork = pool.fork()
    expect(fork.hasRefResolver()).toBe(true)
    expect(fork.resolveRef("wf.node.key")).toBe("resolved-value")
  })
})