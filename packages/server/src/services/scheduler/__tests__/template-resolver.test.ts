import { describe, it, expect } from "vitest"
import { resolveInputValues, parseWorkflowInputDefs } from "../template-resolver"

describe("resolveInputValues", () => {
  it("replaces ${goal} with actual goal", () => {
    const { values } = resolveInputValues(
      { requirement: "${goal}" },
      "Build a widget",
      ["works", "is fast"],
    )
    expect(values.requirement).toBe("Build a widget")
  })

  it("replaces ${ac} with ac.join('\\n')", () => {
    const { values } = resolveInputValues(
      { acceptance: "${ac}" },
      "goal",
      ["criterion 1", "criterion 2"],
    )
    expect(values.acceptance).toBe("criterion 1\ncriterion 2")
  })

  it("handles mixed text with placeholders", () => {
    const { values } = resolveInputValues(
      { summary: "Goal: ${goal} | AC: ${ac}" },
      "test",
      ["a", "b"],
    )
    expect(values.summary).toBe("Goal: test | AC: a\nb")
  })

  it("reports unknown placeholder as unresolved (empty value, no throw)", () => {
    const { values, unresolved } = resolveInputValues(
      { key: "${unknown}" },
      "goal",
      ["ac"],
    )
    expect(values.key).toBe("")
    expect(unresolved).toEqual(["key"])
  })

  it("reports multiple unresolved placeholders", () => {
    const { unresolved } = resolveInputValues(
      { a: "${foo}", b: "x ${bar} y" },
      "goal",
      ["ac"],
    )
    expect(unresolved).toEqual(["a", "b"])
  })

  it("returns empty values for undefined input_values", () => {
    const result = resolveInputValues(undefined, "goal", ["ac"])
    expect(result).toEqual({ values: {}, unresolved: [] })
  })

  it("returns empty values for empty input_values", () => {
    const result = resolveInputValues({}, "goal", ["ac"])
    expect(result).toEqual({ values: {}, unresolved: [] })
  })

  it("passes through values without placeholders", () => {
    const { values, unresolved } = resolveInputValues(
      { key: "literal value", num: "42" },
      "goal",
      ["ac"],
    )
    expect(values).toEqual({ key: "literal value", num: "42" })
    expect(unresolved).toEqual([])
  })

  it("handles multiple placeholders in same value", () => {
    const { values } = resolveInputValues(
      { combined: "${goal} + ${ac}" },
      "do thing",
      ["ok"],
    )
    expect(values.combined).toBe("do thing + ok")
  })

  it("flags a placeholder referencing an EMPTY WHAT field as unresolved (non-empty value impossible)", () => {
    const { values, unresolved } = resolveInputValues(
      { req: "${goal}", acc: "${ac}", direct: "literal" },
      "",
      [],
    )
    expect(values.req).toBe("")
    expect(values.acc).toBe("")
    expect(values.direct).toBe("literal")
    // reg/acc carry a placeholder but its source is empty → surfaced so the
    // caller (ready-gate) can reject; direct literal is untouched.
    expect(unresolved.sort()).toEqual(["acc", "req"])
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