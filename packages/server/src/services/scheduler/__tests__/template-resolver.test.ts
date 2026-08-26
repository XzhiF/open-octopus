import { describe, it, expect } from "vitest"
import { resolveInputValues, parseWorkflowInputDefs } from "../template-resolver"

describe("resolveInputValues", () => {
  it("replaces ${goal} with actual goal", () => {
    const result = resolveInputValues(
      { requirement: "${goal}" },
      "Build a widget",
      ["works", "is fast"],
    )
    expect(result.requirement).toBe("Build a widget")
  })

  it("replaces ${ac} with ac.join('\\n')", () => {
    const result = resolveInputValues(
      { acceptance: "${ac}" },
      "goal",
      ["criterion 1", "criterion 2"],
    )
    expect(result.acceptance).toBe("criterion 1\ncriterion 2")
  })

  it("handles mixed text with placeholders", () => {
    const result = resolveInputValues(
      { summary: "Goal: ${goal} | AC: ${ac}" },
      "test",
      ["a", "b"],
    )
    expect(result.summary).toBe("Goal: test | AC: a\nb")
  })

  it("throws on unknown placeholder", () => {
    expect(() =>
      resolveInputValues(
        { key: "${unknown}" },
        "goal",
        ["ac"],
      ),
    ).toThrow(/unknown placeholder/i)
  })

  it("throws on multiple unknown placeholders (reports first)", () => {
    expect(() =>
      resolveInputValues(
        { key: "${foo}" },
        "goal",
        ["ac"],
      ),
    ).toThrow(/\$\{foo\}/)
  })

  it("returns empty object for undefined input_values", () => {
    const result = resolveInputValues(undefined, "goal", ["ac"])
    expect(result).toEqual({})
  })

  it("returns empty object for empty input_values", () => {
    const result = resolveInputValues({}, "goal", ["ac"])
    expect(result).toEqual({})
  })

  it("passes through values without placeholders", () => {
    const result = resolveInputValues(
      { key: "literal value", num: "42" },
      "goal",
      ["ac"],
    )
    expect(result).toEqual({ key: "literal value", num: "42" })
  })

  it("handles multiple placeholders in same value", () => {
    const result = resolveInputValues(
      { combined: "${goal} + ${ac}" },
      "do thing",
      ["ok"],
    )
    expect(result.combined).toBe("do thing + ok")
  })

  it("handles empty goal/ac gracefully", () => {
    const result = resolveInputValues(
      { req: "${goal}", acc: "${ac}" },
      "",
      [],
    )
    expect(result.req).toBe("")
    expect(result.acc).toBe("")
  })
})

describe("parseWorkflowInputDefs", () => {
  it("parses required inputs from workflow YAML", () => {
    const content = `
apiVersion: octopus/v1
kind: Workflow
name: test
inputs:
  idea:
    description: "The idea"
    required: true
  feature:
    description: "Optional feature"
    required: false
    default: ""
`
    const defs = parseWorkflowInputDefs(content)
    expect(defs).toEqual([
      { name: "idea", required: true },
      { name: "feature", required: false },
    ])
  })

  it("returns empty for missing inputs section", () => {
    const content = `
apiVersion: octopus/v1
kind: Workflow
name: test
variables:
  foo: ""
`
    const defs = parseWorkflowInputDefs(content)
    expect(defs).toEqual([])
  })

  it("returns empty for invalid YAML", () => {
    const defs = parseWorkflowInputDefs("invalid: yaml: [[")
    expect(defs).toEqual([])
  })

  it("returns empty for empty string", () => {
    const defs = parseWorkflowInputDefs("")
    expect(defs).toEqual([])
  })

  it("treats input without required field as not required", () => {
    const content = `
inputs:
  option:
    description: "Something"
`
    const defs = parseWorkflowInputDefs(content)
    expect(defs).toEqual([{ name: "option", required: false }])
  })
})
