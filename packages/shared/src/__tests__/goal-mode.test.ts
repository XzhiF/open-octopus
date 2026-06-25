import { describe, it, expect } from "vitest"
import { parseWorkflow, validateWorkflow, ValueError } from "../yaml/parser"

describe("Goal mode schema", () => {
  it("accepts agent node with goal field", () => {
    const wf = parseWorkflow({
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "goal-test",
      nodes: [
        { id: "analyze", type: "agent", goal: "Analyze the root cause of issue #42" },
      ],
    })
    expect(wf.nodes[0].goal).toBe("Analyze the root cause of issue #42")
    expect(() => validateWorkflow(wf)).not.toThrow()
  })

  it("accepts agent node with goal + constraints", () => {
    const wf = parseWorkflow({
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "goal-constraints",
      nodes: [
        {
          id: "analyze",
          type: "agent",
          goal: "Analyze issue",
          constraints: ["Cannot modify files", "Must complete in 5 turns"],
        },
      ],
    })
    expect(wf.nodes[0].constraints).toEqual(["Cannot modify files", "Must complete in 5 turns"])
  })

  it("accepts agent node with goal + planning", () => {
    const wf = parseWorkflow({
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "goal-planning",
      nodes: [
        {
          id: "analyze",
          type: "agent",
          goal: "Analyze issue",
          planning: {
            max_turns: 10,
            verify: true,
            tools: ["read", "grep"],
            disallowed_tools: ["write"],
          },
        },
      ],
    })
    expect(wf.nodes[0].planning?.max_turns).toBe(10)
    expect(wf.nodes[0].planning?.verify).toBe(true)
    expect(wf.nodes[0].planning?.tools).toEqual(["read", "grep"])
    expect(wf.nodes[0].planning?.disallowed_tools).toEqual(["write"])
  })

  it("rejects node with both goal and prompt", () => {
    expect(() =>
      parseWorkflow({
        apiVersion: "octopus/v1",
        kind: "Workflow",
        name: "bad",
        nodes: [
          { id: "s1", type: "agent", goal: "Do something", prompt: "Do this exactly" },
        ],
      })
    ).toThrow(/goal.*prompt.*mutually exclusive/)
  })

  it("rejects nested node with both goal and prompt", () => {
    expect(() =>
      parseWorkflow({
        apiVersion: "octopus/v1",
        kind: "Workflow",
        name: "bad",
        nodes: [
          {
            id: "loop",
            type: "loop",
            max_iterations: 3,
            nodes: [
              { id: "inner", type: "agent", goal: "Do something", prompt: "Do this" },
            ],
          },
        ],
      })
    ).toThrow(/goal.*prompt.*mutually exclusive/)
  })

  it("goal field is optional — prompt-only still works", () => {
    const wf = parseWorkflow({
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "prompt-only",
      nodes: [
        { id: "s1", type: "agent", prompt: "Do this exactly" },
      ],
    })
    expect(wf.nodes[0].goal).toBeUndefined()
    expect(wf.nodes[0].prompt).toBe("Do this exactly")
  })

  it("agent node with only goal (no prompt) passes validation", () => {
    const wf = parseWorkflow({
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "goal-only",
      nodes: [
        { id: "s1", type: "agent", goal: "Fix the bug" },
      ],
    })
    expect(() => validateWorkflow(wf)).not.toThrow()
  })

  it("rejects constraints without goal", () => {
    expect(() =>
      parseWorkflow({
        apiVersion: "octopus/v1",
        kind: "Workflow",
        name: "bad",
        nodes: [
          { id: "s1", type: "agent", prompt: "Do this", constraints: ["no files"] },
        ],
      })
    ).toThrow(/"constraints" requires "goal"/)
  })

  it("rejects planning without goal", () => {
    expect(() =>
      parseWorkflow({
        apiVersion: "octopus/v1",
        kind: "Workflow",
        name: "bad",
        nodes: [
          { id: "s1", type: "agent", prompt: "Do this", planning: { verify: true } },
        ],
      })
    ).toThrow(/"planning" requires "goal"/)
  })

  it("constraints and planning work with goal", () => {
    const wf = parseWorkflow({
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "ok",
      nodes: [
        {
          id: "s1",
          type: "agent",
          goal: "Fix the bug",
          constraints: ["only read src/"],
          planning: { verify: true, tools: ["Read"] },
        },
      ],
    })
    expect(wf.nodes[0].constraints).toEqual(["only read src/"])
    expect(wf.nodes[0].planning?.verify).toBe(true)
  })
})
