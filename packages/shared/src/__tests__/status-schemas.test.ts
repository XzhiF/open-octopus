import { describe, it, expect } from "vitest"
import { ExecutionStatusSchema, NodeExecutionStatusSchema } from "../types/workspace"

describe("ExecutionStatusSchema", () => {
  it("includes pending_approval", () => {
    const result = ExecutionStatusSchema.safeParse("pending_approval")
    expect(result.success).toBe(true)
  })

  it("includes paused", () => {
    const result = ExecutionStatusSchema.safeParse("paused")
    expect(result.success).toBe(true)
  })

  it("rejects invalid status", () => {
    const result = ExecutionStatusSchema.safeParse("invalid_status")
    expect(result.success).toBe(false)
  })
})

describe("NodeExecutionStatusSchema", () => {
  it("includes pending_approval", () => {
    const result = NodeExecutionStatusSchema.safeParse("pending_approval")
    expect(result.success).toBe(true)
  })

  it("includes all expected statuses", () => {
    const statuses = ["pending", "running", "completed", "failed", "skipped", "cancelled", "paused", "rejected", "pending_approval"]
    for (const status of statuses) {
      const result = NodeExecutionStatusSchema.safeParse(status)
      expect(result.success).toBe(true)
    }
  })
})
