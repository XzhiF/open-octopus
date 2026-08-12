import { describe, it, expect } from "vitest"
import { computeErrorHash, simpleHash } from "../utils"

describe("utils", () => {
  describe("simpleHash", () => {
    it("produces consistent hash for same input", () => {
      const hash1 = simpleHash("test error message")
      const hash2 = simpleHash("test error message")
      expect(hash1).toBe(hash2)
    })

    it("produces different hash for different input", () => {
      const hash1 = simpleHash("error 1")
      const hash2 = simpleHash("error 2")
      expect(hash1).not.toBe(hash2)
    })

    it("returns a base-36 string", () => {
      const hash = simpleHash("test")
      expect(hash).toMatch(/^[0-9a-z]+$/)
    })

    it("handles empty string", () => {
      const hash = simpleHash("")
      expect(hash).toBe("0")
    })
  })

  describe("computeErrorHash", () => {
    it("extracts error features from NodeExecutionResult", () => {
      const result = {
        logLines: [
          "Starting process",
          "Error: Cannot find module 'xyz'",
          "Process failed",
        ],
        error: "Module not found",
        outputs: {
          exitCode: 1,
        },
      }

      const hash = computeErrorHash(result)
      expect(hash).toBeTruthy()
      expect(typeof hash).toBe("string")
    })

    it("produces same hash for same error pattern", () => {
      const result1 = {
        logLines: ["Error: Cannot find module"],
        error: "Module not found",
        outputs: { exitCode: 1 },
      }

      const result2 = {
        logLines: ["Error: Cannot find module"],
        error: "Module not found",
        outputs: { exitCode: 1 },
      }

      const hash1 = computeErrorHash(result1)
      const hash2 = computeErrorHash(result2)
      expect(hash1).toBe(hash2)
    })

    it("produces different hash for different errors", () => {
      const result1 = {
        logLines: ["Error: Cannot find module"],
        error: "Module not found",
        outputs: { exitCode: 1 },
      }

      const result2 = {
        logLines: ["Error: Permission denied"],
        error: "Permission denied",
        outputs: { exitCode: 1 },
      }

      const hash1 = computeErrorHash(result1)
      const hash2 = computeErrorHash(result2)
      expect(hash1).not.toBe(hash2)
    })

    it("handles missing logLines", () => {
      const result = {
        error: "Some error",
        outputs: { exitCode: 1 },
      }

      const hash = computeErrorHash(result)
      expect(hash).toBeTruthy()
    })

    it("handles missing error field", () => {
      const result = {
        logLines: ["Error in log"],
        outputs: { exitCode: 1 },
      }

      const hash = computeErrorHash(result)
      expect(hash).toBeTruthy()
    })

    it("handles missing outputs", () => {
      const result = {
        logLines: ["Error"],
        error: "Error message",
      }

      const hash = computeErrorHash(result)
      expect(hash).toBeTruthy()
    })

    it("truncates input to 500 characters", () => {
      const longError = "x".repeat(1000)
      const result = {
        logLines: [longError],
        error: longError,
        outputs: { exitCode: 1 },
      }

      const hash = computeErrorHash(result)
      expect(hash).toBeTruthy()
    })
  })
})
