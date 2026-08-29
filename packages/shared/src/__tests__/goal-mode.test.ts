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

  it("rejects planning with migration guidance — new field names + verify deleted", () => {
    expect(() =>
      parseWorkflow({
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
    ).toThrow(/planning 已废弃.*max_turns\/max_budget_usd\/disallowed_tools.*verify 删除/)
  })

  it("rejects planning nested inside loop body (recursive pre-Zod scan)", () => {
    expect(() =>
      parseWorkflow({
        apiVersion: "octopus/v1",
        kind: "Workflow",
        name: "nested-planning",
        nodes: [
          {
            id: "loop",
            type: "loop",
            max_iterations: 3,
            nodes: [
              {
                id: "inner",
                type: "agent",
                goal: "Do work",
                planning: { max_turns: 5 },
              },
            ],
          },
        ],
      })
    ).toThrow(/planning 已废弃/)
  })

  it("rejects planning on prompt-mode node with the same migration error (not the old requires-goal error)", () => {
    expect(() =>
      parseWorkflow({
        apiVersion: "octopus/v1",
        kind: "Workflow",
        name: "bad",
        nodes: [
          { id: "s1", type: "agent", prompt: "Do this", planning: { verify: true } },
        ],
      })
    ).toThrow(/planning 已废弃/)
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

  it("constraints and new node-level execution fields work with goal", () => {
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
          tools: ["Read"],
          max_turns: 10,
        },
      ],
    })
    expect(wf.nodes[0].constraints).toEqual(["only read src/"])
    expect(wf.nodes[0].tools).toEqual(["Read"])
    expect(wf.nodes[0].max_turns).toBe(10)
  })

  it("preserves tools field through parse — non-strict Zod must not strip it", () => {
    const wf = parseWorkflow({
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "tools-preserved",
      nodes: [
        { id: "s1", type: "agent", prompt: "Do this", tools: ["Read", "Bash"] },
      ],
    })
    expect(wf.nodes[0].tools).toEqual(["Read", "Bash"])
  })

  it("accepts max_turns/max_budget_usd as number or string; disallowed_tools as string[]", () => {
    const wf = parseWorkflow({
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "exec-fields",
      nodes: [
        {
          id: "s1",
          type: "agent",
          goal: "Fix it",
          max_turns: "$inputs.max_turns",
          max_budget_usd: 2.5,
          disallowed_tools: ["Write", "Edit"],
        },
        { id: "s2", type: "agent", goal: "Fix other", max_turns: 100, max_budget_usd: "5" },
      ],
    })
    expect(wf.nodes[0].max_turns).toBe("$inputs.max_turns")
    expect(wf.nodes[0].max_budget_usd).toBe(2.5)
    expect(wf.nodes[0].disallowed_tools).toEqual(["Write", "Edit"])
    expect(wf.nodes[1].max_turns).toBe(100)
    expect(wf.nodes[1].max_budget_usd).toBe("5")
  })
})

describe("validateWorkflow — engine capability warnings", () => {
  function wfWith(node: Record<string, unknown>, wfEngine?: string) {
    const doc: Record<string, unknown> = {
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "warn-test",
      nodes: [node],
    }
    if (wfEngine) doc.engine = wfEngine
    return parseWorkflow(doc)
  }

  it("returns { warnings } — non-claude engine node with claude-only fields gets 1 warning, no reject", () => {
    const wf = wfWith({ id: "dev", type: "agent", goal: "g", engine: "pi", max_turns: 10, tools: ["Read"] })
    const { warnings } = validateWorkflow(wf)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("dev")
    expect(warnings[0]).toContain("max_turns, tools")
  })

  it("claude engine with the same fields — zero warnings", () => {
    const wf = wfWith({ id: "dev", type: "agent", goal: "g", engine: "claude", max_turns: 10, tools: ["Read"], max_budget_usd: 1, disallowed_tools: ["Write"] })
    expect(validateWorkflow(wf).warnings).toEqual([])
  })

  it("claude-code alias counts as claude — zero warnings", () => {
    const wf = wfWith({ id: "dev", type: "agent", goal: "g", engine: "claude-code", max_turns: 10 })
    expect(validateWorkflow(wf).warnings).toEqual([])
  })

  it("workflow-level engine applies when node has no engine override", () => {
    const wf = wfWith({ id: "dev", type: "agent", goal: "g", disallowed_tools: ["Write"] }, "pi")
    const { warnings } = validateWorkflow(wf)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("pi")
  })

  it("nested loop node resolves engine chain (workflow-level engine) and warns too", () => {
    const wf = wfWith({
      id: "loop", type: "loop", max_iterations: 2,
      nodes: [{ id: "inner", type: "agent", goal: "g", max_budget_usd: 3 }],
    }, "pi")
    const { warnings } = validateWorkflow(wf)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("inner")
  })

  it("legacy file (no planning, no new fields) — zero warnings, structural checks still throw", () => {
    const wf = wfWith({ id: "s1", type: "agent", prompt: "do it" })
    expect(validateWorkflow(wf).warnings).toEqual([])
    expect(() => validateWorkflow(wfWith({ id: "b", type: "bash" }))).toThrow("bash content required")
  })
})
