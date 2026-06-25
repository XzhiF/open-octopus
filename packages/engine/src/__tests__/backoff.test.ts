import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { calculateBackoff } from "../pipeline/backoff"
import type { Backoff } from "@octopus/shared"

describe("calculateBackoff", () => {
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0.5) // zero jitter for deterministic tests
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe("fixed mode", () => {
    it("returns constant delay regardless of attempt", () => {
      const policy: Backoff = {
        type: "fixed",
        initial_delay: 10,
        multiplier: 2,
        increment: 5,
        max_delay: 300,
      }

      expect(calculateBackoff(policy, 1)).toBe(10)
      expect(calculateBackoff(policy, 2)).toBe(10)
      expect(calculateBackoff(policy, 3)).toBe(10)
      expect(calculateBackoff(policy, 10)).toBe(10)
    })

    it("clamps to max_delay", () => {
      const policy: Backoff = {
        type: "fixed",
        initial_delay: 100,
        multiplier: 2,
        increment: 5,
        max_delay: 50,
      }

      expect(calculateBackoff(policy, 1)).toBe(50)
    })
  })

  describe("exponential mode", () => {
    it("doubles delay with default multiplier of 2", () => {
      const policy: Backoff = {
        type: "exponential",
        initial_delay: 5,
        multiplier: 2,
        increment: 5,
        max_delay: 300,
      }

      expect(calculateBackoff(policy, 1)).toBe(5)   // 5 * 2^0 = 5
      expect(calculateBackoff(policy, 2)).toBe(10)  // 5 * 2^1 = 10
      expect(calculateBackoff(policy, 3)).toBe(20)  // 5 * 2^2 = 20
      expect(calculateBackoff(policy, 4)).toBe(40)  // 5 * 2^3 = 40
    })

    it("respects custom multiplier", () => {
      const policy: Backoff = {
        type: "exponential",
        initial_delay: 10,
        multiplier: 3,
        increment: 5,
        max_delay: 300,
      }

      expect(calculateBackoff(policy, 1)).toBe(10)  // 10 * 3^0 = 10
      expect(calculateBackoff(policy, 2)).toBe(30)  // 10 * 3^1 = 30
      expect(calculateBackoff(policy, 3)).toBe(90)  // 10 * 3^2 = 90
    })

    it("clamps to max_delay", () => {
      const policy: Backoff = {
        type: "exponential",
        initial_delay: 5,
        multiplier: 2,
        increment: 5,
        max_delay: 30,
      }

      // 5 * 2^3 = 40, clamped to 30
      expect(calculateBackoff(policy, 4)).toBe(30)
      // 5 * 2^4 = 80, clamped to 30
      expect(calculateBackoff(policy, 5)).toBe(30)
    })
  })

  describe("linear mode", () => {
    it("increments delay linearly", () => {
      const policy: Backoff = {
        type: "linear",
        initial_delay: 5,
        multiplier: 2,
        increment: 5,
        max_delay: 300,
      }

      expect(calculateBackoff(policy, 1)).toBe(5)   // 5 + 5*0 = 5
      expect(calculateBackoff(policy, 2)).toBe(10)  // 5 + 5*1 = 10
      expect(calculateBackoff(policy, 3)).toBe(15)  // 5 + 5*2 = 15
      expect(calculateBackoff(policy, 4)).toBe(20)  // 5 + 5*3 = 20
    })

    it("clamps to max_delay", () => {
      const policy: Backoff = {
        type: "linear",
        initial_delay: 10,
        multiplier: 2,
        increment: 10,
        max_delay: 25,
      }

      // 10 + 10*2 = 30, clamped to 25
      expect(calculateBackoff(policy, 3)).toBe(25)
    })
  })

  describe("jitter", () => {
    it("applies ±10% jitter", () => {
      const policy: Backoff = {
        type: "fixed",
        initial_delay: 100,
        multiplier: 2,
        increment: 5,
        max_delay: 300,
      }

      // Test with zero jitter (random = 0.5)
      vi.mocked(Math.random).mockReturnValue(0.5)
      const noJitter = calculateBackoff(policy, 1)
      expect(noJitter).toBe(100) // 100 + 0% jitter

      // Test with negative jitter (random = 0)
      vi.mocked(Math.random).mockReturnValue(0)
      const negativeJitter = calculateBackoff(policy, 1)
      // jitter = 100 * 0.1 * (0*2 - 1) = -10, delay = 100 - 10 = 90
      expect(negativeJitter).toBe(90)

      // Test with positive jitter (random = 1)
      vi.mocked(Math.random).mockReturnValue(1)
      const positiveJitter = calculateBackoff(policy, 1)
      // jitter = 100 * 0.1 * (1*2 - 1) = 10, delay = 100 + 10 = 110
      expect(positiveJitter).toBe(110)
    })

    it("produces varied results across calls", () => {
      const policy: Backoff = {
        type: "fixed",
        initial_delay: 100,
        multiplier: 2,
        increment: 5,
        max_delay: 300,
      }

      const results = new Set<number>()
      let callCount = 0
      vi.mocked(Math.random).mockImplementation(() => {
        callCount++
        return (callCount % 10) / 10
      })

      for (let i = 0; i < 10; i++) {
        results.add(calculateBackoff(policy, 1))
      }

      // Should have varied results due to jitter
      expect(results.size).toBeGreaterThan(1)
    })
  })

  describe("edge cases", () => {
    it("handles zero initial_delay", () => {
      const policy: Backoff = {
        type: "exponential",
        initial_delay: 0,
        multiplier: 2,
        increment: 5,
        max_delay: 300,
      }

      expect(calculateBackoff(policy, 1)).toBe(0)
      expect(calculateBackoff(policy, 5)).toBe(0)
    })

    it("returns integer values", () => {
      const policy: Backoff = {
        type: "exponential",
        initial_delay: 7,
        multiplier: 2,
        increment: 5,
        max_delay: 300,
      }

      vi.mocked(Math.random).mockReturnValue(0.5)
      expect(calculateBackoff(policy, 1)).toBe(7)
      expect(calculateBackoff(policy, 2)).toBe(14)
      expect(calculateBackoff(policy, 3)).toBe(28)

      // All results should be integers
      expect(Number.isInteger(calculateBackoff(policy, 1))).toBe(true)
      expect(Number.isInteger(calculateBackoff(policy, 2))).toBe(true)
    })
  })
})
