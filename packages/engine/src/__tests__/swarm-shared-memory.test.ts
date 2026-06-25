import { describe, it, expect, beforeEach } from "vitest"
import { SharedMemory } from "../executors/swarm/shared-memory"

describe("SharedMemory", () => {
  let mem: SharedMemory

  beforeEach(() => {
    mem = new SharedMemory()
  })

  it("returns undefined for missing keys", () => {
    expect(mem.get("nonexistent")).toBeUndefined()
  })

  it("stores and retrieves a value", () => {
    mem.set("key1", "value1", "expert-a")
    expect(mem.get("key1")).toBe("value1")
  })

  it("overwrites existing values", () => {
    mem.set("key1", "v1", "expert-a")
    mem.set("key1", "v2", "expert-b")
    expect(mem.get("key1")).toBe("v2")
  })

  it("supports various value types", () => {
    mem.set("str", "hello", "a")
    mem.set("num", 42, "a")
    mem.set("arr", [1, 2, 3], "a")
    mem.set("obj", { nested: true }, "a")
    mem.set("null", null, "a")

    expect(mem.get("str")).toBe("hello")
    expect(mem.get("num")).toBe(42)
    expect(mem.get("arr")).toEqual([1, 2, 3])
    expect(mem.get("obj")).toEqual({ nested: true })
    expect(mem.get("null")).toBeNull()
  })

  describe("has", () => {
    it("returns false for missing keys", () => {
      expect(mem.has("x")).toBe(false)
    })

    it("returns true for existing keys", () => {
      mem.set("x", 1, "a")
      expect(mem.has("x")).toBe(true)
    })
  })

  describe("keys", () => {
    it("returns empty array when no entries", () => {
      expect(mem.keys()).toEqual([])
    })

    it("returns all key names", () => {
      mem.set("alpha", 1, "a")
      mem.set("beta", 2, "b")
      mem.set("gamma", 3, "c")
      expect(mem.keys().sort()).toEqual(["alpha", "beta", "gamma"])
    })
  })

  describe("snapshot", () => {
    it("returns a read-only copy of the store", () => {
      mem.set("k1", "v1", "expert-a")
      mem.set("k2", "v2", "expert-b")

      const snap = mem.snapshot()
      expect(snap.size).toBe(2)

      // Verify entries contain author and timestamp metadata
      const entry = snap.get("k1")
      expect(entry).toBeDefined()
      expect(entry!.value).toBe("v1")
      expect(entry!.author).toBe("expert-a")
      expect(typeof entry!.timestamp).toBe("number")
    })

    it("snapshot is independent of subsequent mutations", () => {
      mem.set("k1", "v1", "a")
      const snap = mem.snapshot()

      mem.set("k1", "v2", "b")
      mem.set("k2", "new", "b")

      // Snapshot should still reflect old state
      expect(snap.size).toBe(1)
      expect(snap.get("k1")!.value).toBe("v1")
    })
  })
})
