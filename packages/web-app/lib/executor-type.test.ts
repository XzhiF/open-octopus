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
})
