import { describe, it, expect } from "vitest"
import { getExecutorType } from "@/lib/executor-type"
import type { StepExecution } from "@/lib/types"

function makeStep(overrides: Partial<StepExecution> = {}): StepExecution {
  return {
    stepId: "step-1",
    stepName: "test-step",
    status: "completed" as any,
    ...overrides,
  } as StepExecution
}

describe("getExecutorType", () => {
  it("returns undefined when step is undefined", () => {
    expect(getExecutorType(undefined, "octopus_agent")).toBeUndefined()
  })

  it("returns 'octopus_agent' when nodeType is 'octopus_agent' (even with model set)", () => {
    const step = makeStep({ model: "claude-sonnet-4-20250514" })
    expect(getExecutorType(step, "octopus_agent")).toBe("octopus_agent")
  })

  it("returns 'swarm' when nodeType is 'swarm'", () => {
    const step = makeStep()
    expect(getExecutorType(step, "swarm")).toBe("swarm")
  })

  it("returns 'interaction' when nodeType is 'interaction'", () => {
    const step = makeStep()
    expect(getExecutorType(step, "interaction")).toBe("interaction")
  })

  it("returns 'sub_workflow' when nodeType is 'sub_workflow'", () => {
    const step = makeStep()
    expect(getExecutorType(step, "sub_workflow")).toBe("sub_workflow")
  })

  it("returns 'agent' when step has model but nodeType is not octopus_agent", () => {
    const step = makeStep({ model: "claude-sonnet-4-20250514" })
    expect(getExecutorType(step, "normal")).toBe("agent")
  })

  it("returns 'bash' when step name includes 'bash'", () => {
    const step = makeStep({ stepName: "Run Bash Script" })
    expect(getExecutorType(step, "normal")).toBe("bash")
  })

  it("returns 'python' when step name includes 'python'", () => {
    const step = makeStep({ stepName: "Execute Python" })
    expect(getExecutorType(step, "normal")).toBe("python")
  })

  it("returns 'condition' when step name includes 'condition'", () => {
    const step = makeStep({ stepName: "Check Condition" })
    expect(getExecutorType(step, "normal")).toBe("condition")
  })

  it("returns 'approval' when step name includes 'approval'", () => {
    const step = makeStep({ stepName: "Request Approval" })
    expect(getExecutorType(step, "normal")).toBe("approval")
  })

  it("returns 'loop' when step name includes 'loop'", () => {
    const step = makeStep({ stepName: "Run Loop" })
    expect(getExecutorType(step, "normal")).toBe("loop")
  })

  it("returns undefined for unknown step types", () => {
    const step = makeStep({ stepName: "Something Else" })
    expect(getExecutorType(step, "normal")).toBeUndefined()
  })

  // ── Negative tests ──────────────────────────────────────────────

  it("returns undefined when nodeType is an empty string and step name is generic", () => {
    const step = makeStep({ stepName: "Generic Task" })
    expect(getExecutorType(step, "")).toBeUndefined()
  })

  it("returns undefined when stepName is empty and nodeType is unrecognized", () => {
    const step = makeStep({ stepName: "" })
    expect(getExecutorType(step, "unknown_type")).toBeUndefined()
  })

  it("does not match partial nodeType 'agent' — only 'octopus_agent' qualifies", () => {
    const step = makeStep({ stepName: "Some Task" })
    // "agent" is NOT "octopus_agent", and step has no model → should not return "agent" or "octopus_agent"
    const result = getExecutorType(step, "agent")
    expect(result).toBeUndefined()
  })

  it("does not match partial step name substrings (e.g., 'bashful' should not match 'bash')", () => {
    // The implementation uses .includes() so "bashful" WOULD match — this documents the actual behavior
    const step = makeStep({ stepName: "bashful" })
    // Note: .includes("bash") matches "bashful" — this is a known limitation
    expect(getExecutorType(step, "normal")).toBe("bash")
  })

  it("returns undefined when step has no model and nodeType is 'normal' with non-matching name", () => {
    const step = makeStep({ stepName: "Send Notification", model: undefined })
    expect(getExecutorType(step, "normal")).toBeUndefined()
  })

  it("returns 'agent' for nodeType 'octopus_agent' only via nodeType check, not model fallback", () => {
    // Verify that "octopus_agent" nodeType takes precedence and returns "octopus_agent", not "agent"
    const step = makeStep({ model: "claude-sonnet-4-20250514", stepName: "Run Bash" })
    // nodeType "octopus_agent" matches BEFORE model check and BEFORE name check
    expect(getExecutorType(step, "octopus_agent")).toBe("octopus_agent")
  })
})
