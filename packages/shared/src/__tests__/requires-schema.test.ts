import { describe, it, expect } from "vitest"
import { WorkflowSchema } from "../types/workflow"

describe("WorkflowSchema requires field", () => {
  const baseWorkflow = {
    apiVersion: "octopus/v1",
    kind: "Workflow" as const,
    name: "test-workflow",
    nodes: [],
  }

  it("accepts requires with both skills and agent_files", () => {
    const result = WorkflowSchema.safeParse({
      ...baseWorkflow,
      requires: {
        skills: ["octo-test-skill", "octo-lint"],
        agent_files: ["code-reviewer.md", "planner.md"],
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.requires?.skills).toEqual(["octo-test-skill", "octo-lint"])
      expect(result.data.requires?.agent_files).toEqual(["code-reviewer.md", "planner.md"])
    }
  })

  it("accepts requires with only skills", () => {
    const result = WorkflowSchema.safeParse({
      ...baseWorkflow,
      requires: {
        skills: ["octo-test-skill"],
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.requires?.skills).toEqual(["octo-test-skill"])
      expect(result.data.requires?.agent_files).toBeUndefined()
    }
  })

  it("accepts requires with only agent_files", () => {
    const result = WorkflowSchema.safeParse({
      ...baseWorkflow,
      requires: {
        agent_files: ["planner.md"],
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.requires?.agent_files).toEqual(["planner.md"])
      expect(result.data.requires?.skills).toBeUndefined()
    }
  })

  it("accepts empty requires object", () => {
    const result = WorkflowSchema.safeParse({
      ...baseWorkflow,
      requires: {},
    })
    expect(result.success).toBe(true)
  })

  it("accepts workflow without requires (backward compatible)", () => {
    const result = WorkflowSchema.safeParse(baseWorkflow)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.requires).toBeUndefined()
    }
  })

  it("rejects requires.skills with non-string array elements", () => {
    const result = WorkflowSchema.safeParse({
      ...baseWorkflow,
      requires: {
        skills: [123, "valid"],
      },
    })
    expect(result.success).toBe(false)
  })

  it("rejects requires.agent_files with non-string array elements", () => {
    const result = WorkflowSchema.safeParse({
      ...baseWorkflow,
      requires: {
        agent_files: [true],
      },
    })
    expect(result.success).toBe(false)
  })

  it("rejects requires with non-array skills", () => {
    const result = WorkflowSchema.safeParse({
      ...baseWorkflow,
      requires: {
        skills: "not-an-array",
      },
    })
    expect(result.success).toBe(false)
  })
})
