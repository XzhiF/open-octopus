import { describe, it, expect } from "vitest"
import { HookSchema, WorkflowHooksSchema, WorkflowSchema } from "../types/workflow"

describe("HookSchema", () => {
  it("validates minimal agent hook with default type", () => {
    const result = HookSchema.parse({ prompt: "notify success" })
    expect(result.type).toBe("agent")
    expect(result.prompt).toBe("notify success")
  })

  it("validates bash hook", () => {
    const result = HookSchema.parse({ type: "bash", bash: "echo done" })
    expect(result.type).toBe("bash")
    expect(result.bash).toBe("echo done")
  })

  it("validates hook with nodes filter and condition", () => {
    const result = HookSchema.parse({
      type: "agent",
      prompt: "review",
      nodes: ["build", "test"],
      condition: "$vars.env == 'prod'",
    })
    expect(result.nodes).toEqual(["build", "test"])
    expect(result.condition).toBe("$vars.env == 'prod'")
  })

  it("rejects invalid type", () => {
    expect(() => HookSchema.parse({ type: "invalid" })).toThrow()
  })
})

describe("WorkflowHooksSchema", () => {
  it("validates full config", () => {
    const result = WorkflowHooksSchema.parse({
      on_node_success: [{ prompt: "log success" }],
      on_node_failure: [{ type: "bash", bash: "echo fail" }],
      on_workflow_failure: [{ prompt: "alert" }],
      on_cancel: [{ prompt: "cleanup" }],
      on_interrupt: [{ prompt: "save state" }],
      on_retry: [{ prompt: "retry log" }],
      on_success: [{ prompt: "final success" }],
      on_complete: [{ prompt: "done" }],
    })
    expect(result.on_node_success).toHaveLength(1)
    expect(result.on_complete).toHaveLength(1)
  })

  it("validates empty hooks", () => {
    const result = WorkflowHooksSchema.parse({})
    expect(result.on_node_success).toBeUndefined()
    expect(result.on_complete).toBeUndefined()
  })

  it("validates partial hooks", () => {
    const result = WorkflowHooksSchema.parse({
      on_success: [{ prompt: "celebrate" }],
    })
    expect(result.on_success).toHaveLength(1)
    expect(result.on_failure).toBeUndefined()
  })
})

describe("WorkflowSchema with hooks", () => {
  const baseWorkflow = {
    apiVersion: "octopus/v1",
    kind: "Workflow" as const,
    name: "test-flow",
    nodes: [{ id: "step1", type: "bash" as const, bash: "echo hello" }],
  }

  it("validates workflow with hooks", () => {
    const result = WorkflowSchema.parse({
      ...baseWorkflow,
      hooks: {
        on_success: [{ prompt: "notify" }],
        on_node_failure: [{ type: "bash", bash: "echo fail" }],
      },
    })
    expect(result.hooks?.on_success).toHaveLength(1)
    expect(result.hooks?.on_node_failure).toHaveLength(1)
  })

  it("validates workflow without hooks (backward compat)", () => {
    const result = WorkflowSchema.parse(baseWorkflow)
    expect(result.hooks).toBeUndefined()
  })
})
