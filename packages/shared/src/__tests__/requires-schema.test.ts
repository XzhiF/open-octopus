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

  // ── New fields: commands, rules, clones ──

  it("accepts requires with commands field", () => {
    const result = WorkflowSchema.safeParse({
      ...baseWorkflow,
      requires: {
        commands: ["cmd-review", "deploy-check"],
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.requires?.commands).toEqual(["cmd-review", "deploy-check"])
    }
  })

  it("accepts requires with rules field", () => {
    const result = WorkflowSchema.safeParse({
      ...baseWorkflow,
      requires: {
        rules: ["code-style", "naming-convention"],
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.requires?.rules).toEqual(["code-style", "naming-convention"])
    }
  })

  it("accepts requires with clones field", () => {
    const result = WorkflowSchema.safeParse({
      ...baseWorkflow,
      requires: {
        clones: ["workspace", "custom-clone"],
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.requires?.clones).toEqual(["workspace", "custom-clone"])
    }
  })

  it("accepts requires with all 5 resource types", () => {
    const result = WorkflowSchema.safeParse({
      ...baseWorkflow,
      requires: {
        skills: ["octo-test-skill"],
        agent_files: ["code-reviewer.md"],
        commands: ["cmd-review"],
        rules: ["code-style"],
        clones: ["workspace"],
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.requires?.skills).toEqual(["octo-test-skill"])
      expect(result.data.requires?.agent_files).toEqual(["code-reviewer.md"])
      expect(result.data.requires?.commands).toEqual(["cmd-review"])
      expect(result.data.requires?.rules).toEqual(["code-style"])
      expect(result.data.requires?.clones).toEqual(["workspace"])
    }
  })

  it("rejects requires.commands with non-string array elements", () => {
    const result = WorkflowSchema.safeParse({
      ...baseWorkflow,
      requires: {
        commands: [42, "valid"],
      },
    })
    expect(result.success).toBe(false)
  })

  it("rejects requires.rules with non-string array elements", () => {
    const result = WorkflowSchema.safeParse({
      ...baseWorkflow,
      requires: {
        rules: [true],
      },
    })
    expect(result.success).toBe(false)
  })

  it("rejects requires.clones with non-string array elements", () => {
    const result = WorkflowSchema.safeParse({
      ...baseWorkflow,
      requires: {
        clones: [null],
      },
    })
    expect(result.success).toBe(false)
  })

  it("rejects requires with non-array commands", () => {
    const result = WorkflowSchema.safeParse({
      ...baseWorkflow,
      requires: {
        commands: "not-an-array",
      },
    })
    expect(result.success).toBe(false)
  })

  it("rejects requires with non-array rules", () => {
    const result = WorkflowSchema.safeParse({
      ...baseWorkflow,
      requires: {
        rules: "not-an-array",
      },
    })
    expect(result.success).toBe(false)
  })

  it("rejects requires with non-array clones", () => {
    const result = WorkflowSchema.safeParse({
      ...baseWorkflow,
      requires: {
        clones: "not-an-array",
      },
    })
    expect(result.success).toBe(false)
  })
})
