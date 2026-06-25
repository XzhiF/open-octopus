import { describe, it, expect } from "vitest"
import { FailureHandler } from "../executors/swarm/failure-handler"
import type { ExpertResult } from "../executors/swarm/swarm-types"

function makeResult(overrides: Partial<ExpertResult> = {}): ExpertResult {
  return {
    role: "expert-a",
    status: "completed",
    output: "done",
    rounds: 1,
    tools_used: [],
    files_changed: [],
    source: "predefined",
    attempts: 1,
    ...overrides,
  }
}

describe("FailureHandler", () => {
  describe("handleFailure", () => {
    it("TC-039: continue_partial — expert fails, handler returns continue", () => {
      const handler = new FailureHandler("continue_partial")
      const results = [makeResult({ role: "expert-a", status: "failed" })]

      const decision = handler.handleFailure("expert-a", results)
      expect(decision.shouldStop).toBe(false)
      expect(decision.action).toBe("continue")
    })

    it("fail_fast — any failure → shouldStop true", () => {
      const handler = new FailureHandler("fail_fast")
      const results = [makeResult({ role: "expert-a", status: "failed" })]

      const decision = handler.handleFailure("expert-a", results)
      expect(decision.shouldStop).toBe(true)
      expect(decision.action).toBe("stop")
    })

    it("retry_failed — returns retry action", () => {
      const handler = new FailureHandler("retry_failed")
      const results = [makeResult({ role: "expert-a", status: "failed" })]

      const decision = handler.handleFailure("expert-a", results)
      expect(decision.shouldStop).toBe(false)
      expect(decision.action).toBe("retry")
    })
  })

  describe("shouldSkip — dependency chain", () => {
    it("TC-040: upstream fails, downstream skipped", () => {
      const handler = new FailureHandler("continue_partial")
      const results: ExpertResult[] = [
        makeResult({ role: "architect", status: "failed" }),
      ]

      const decision = handler.shouldSkip(
        { role: "implementer", depends_on: ["architect"] },
        results,
      )

      expect(decision.skip).toBe(true)
      expect(decision.reason).toBe('Dependency "architect" failed')
    })

    it("no dependencies → never skip", () => {
      const handler = new FailureHandler("fail_fast")
      const results: ExpertResult[] = [
        makeResult({ role: "architect", status: "failed" }),
      ]

      const decision = handler.shouldSkip(
        { role: "reviewer" },
        results,
      )

      expect(decision.skip).toBe(false)
      expect(decision.reason).toBeUndefined()
    })

    it("upstream succeeded → do not skip", () => {
      const handler = new FailureHandler("continue_partial")
      const results: ExpertResult[] = [
        makeResult({ role: "architect", status: "completed" }),
      ]

      const decision = handler.shouldSkip(
        { role: "implementer", depends_on: ["architect"] },
        results,
      )

      expect(decision.skip).toBe(false)
    })

    it("upstream skipped → downstream also skipped", () => {
      const handler = new FailureHandler("continue_partial")
      const results: ExpertResult[] = [
        makeResult({ role: "architect", status: "skipped" }),
      ]

      const decision = handler.shouldSkip(
        { role: "implementer", depends_on: ["architect"] },
        results,
      )

      expect(decision.skip).toBe(true)
      expect(decision.reason).toBe('Dependency "architect" skipped')
    })

    it("multiple dependencies — any failure triggers skip", () => {
      const handler = new FailureHandler("continue_partial")
      const results: ExpertResult[] = [
        makeResult({ role: "architect", status: "completed" }),
        makeResult({ role: "designer", status: "failed" }),
      ]

      const decision = handler.shouldSkip(
        { role: "implementer", depends_on: ["architect", "designer"] },
        results,
      )

      expect(decision.skip).toBe(true)
      expect(decision.reason).toBe('Dependency "designer" failed')
    })

    it("dependency not found in results → do not skip", () => {
      const handler = new FailureHandler("continue_partial")
      const results: ExpertResult[] = []

      const decision = handler.shouldSkip(
        { role: "implementer", depends_on: ["architect"] },
        results,
      )

      expect(decision.skip).toBe(false)
    })
  })

  describe("defaultPolicy", () => {
    it("dispatch → fail_fast", () => {
      expect(FailureHandler.defaultPolicy("dispatch")).toBe("fail_fast")
    })

    it("review → continue_partial", () => {
      expect(FailureHandler.defaultPolicy("review")).toBe("continue_partial")
    })

    it("debate → continue_partial", () => {
      expect(FailureHandler.defaultPolicy("debate")).toBe("continue_partial")
    })

    it("swarm → continue_partial", () => {
      expect(FailureHandler.defaultPolicy("swarm")).toBe("continue_partial")
    })
  })
})
