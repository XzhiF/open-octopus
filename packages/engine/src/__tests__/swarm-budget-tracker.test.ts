import { describe, it, expect, beforeEach, vi } from "vitest"
import { BudgetTracker } from "../executors/swarm/budget-tracker"

describe("BudgetTracker", () => {
  describe("checkBudget — token limits", () => {
    it("TC-029: returns warning when consumed >= 90% of limit", () => {
      const tracker = new BudgetTracker(100000)
      tracker.addTokens(95000)

      const status = tracker.checkBudget()
      expect(status.status).toBe("warning")
      expect(status.consumed).toBe(95000)
      expect(status.limit).toBe(100000)
      expect(status.percentage).toBe(0.95)
    })

    it("TC-030: returns exhausted when tokens exceed limit", () => {
      const tracker = new BudgetTracker(100000)
      tracker.addTokens(100000)

      const status = tracker.checkBudget()
      expect(status.status).toBe("exhausted")
      expect(status.consumed).toBe(100000)
      expect(status.limit).toBe(100000)
      expect(status.percentage).toBe(1)
    })

    it("returns ok when well under limit", () => {
      const tracker = new BudgetTracker(100000)
      tracker.addTokens(50000)

      const status = tracker.checkBudget()
      expect(status.status).toBe("ok")
      expect(status.percentage).toBe(0.5)
    })

    it("no limit → always ok", () => {
      const tracker = new BudgetTracker()
      tracker.addTokens(999999999)

      const status = tracker.checkBudget()
      expect(status.status).toBe("ok")
      expect(status.limit).toBeNull()
      expect(status.percentage).toBe(0)
    })
  })

  describe("addTokens accumulation", () => {
    it("accumulates correctly across multiple calls", () => {
      const tracker = new BudgetTracker()
      tracker.addTokens(100)
      tracker.addTokens(200)
      tracker.addTokens(300)

      expect(tracker.getConsumed()).toBe(600)
    })

    it("starts at zero", () => {
      const tracker = new BudgetTracker()
      expect(tracker.getConsumed()).toBe(0)
    })
  })

  describe("isTimedOut", () => {
    it("returns true when elapsed > timeoutSeconds", () => {
      const tracker = new BudgetTracker(undefined, 10) // 10 second timeout
      // Simulate a start time 15 seconds ago
      const startTime = Date.now() - 15000

      expect(tracker.isTimedOut(startTime)).toBe(true)
    })

    it("returns false when elapsed < timeoutSeconds", () => {
      const tracker = new BudgetTracker(undefined, 60) // 60 second timeout
      const startTime = Date.now() - 1000 // 1 second ago

      expect(tracker.isTimedOut(startTime)).toBe(false)
    })

    it("no timeout → always false", () => {
      const tracker = new BudgetTracker()
      const startTime = Date.now() - 999999999

      expect(tracker.isTimedOut(startTime)).toBe(false)
    })
  })

  describe("exhausted when over limit", () => {
    it("returns exhausted when consumed exceeds limit", () => {
      const tracker = new BudgetTracker(100)
      tracker.addTokens(150)

      const status = tracker.checkBudget()
      expect(status.status).toBe("exhausted")
      expect(status.percentage).toBe(1.5)
    })
  })
})
