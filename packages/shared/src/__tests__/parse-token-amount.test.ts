import { describe, it, expect } from "vitest"
import { parseTokenAmount } from "../parse-token-amount"

describe("parseTokenAmount", () => {
  it("passes through positive integers", () => {
    expect(parseTokenAmount(50000)).toBe(50000)
    expect(parseTokenAmount(1)).toBe(1)
    expect(parseTokenAmount(999999)).toBe(999999)
  })

  it("parses K suffix (case-insensitive)", () => {
    expect(parseTokenAmount("50K")).toBe(50000)
    expect(parseTokenAmount("50k")).toBe(50000)
    expect(parseTokenAmount("100K")).toBe(100000)
    expect(parseTokenAmount("1.5K")).toBe(1500)
  })

  it("parses M suffix (case-insensitive)", () => {
    expect(parseTokenAmount("1M")).toBe(1000000)
    expect(parseTokenAmount("1m")).toBe(1000000)
    expect(parseTokenAmount("1.5M")).toBe(1500000)
    expect(parseTokenAmount("0.5M")).toBe(500000)
  })

  it("parses plain number strings", () => {
    expect(parseTokenAmount("50000")).toBe(50000)
    expect(parseTokenAmount("100")).toBe(100)
  })

  it("trims whitespace", () => {
    expect(parseTokenAmount("  50K  ")).toBe(50000)
    expect(parseTokenAmount(" 100 ")).toBe(100)
  })

  it("rejects invalid inputs", () => {
    expect(() => parseTokenAmount("abc")).toThrow()
    expect(() => parseTokenAmount("")).toThrow()
    expect(() => parseTokenAmount("50G")).toThrow()
    expect(() => parseTokenAmount(-1)).toThrow()
    expect(() => parseTokenAmount(0)).toThrow()
    expect(() => parseTokenAmount(NaN)).toThrow()
  })
})
