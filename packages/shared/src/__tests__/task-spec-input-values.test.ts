import { describe, it, expect } from "vitest"
import { taskSpecSchema } from "../types/scheduler-job"

/** task-workflow-presets (T1): input_values on taskSpecSchema.
 *  Backward compat: existing tasks without input_values must still parse.
 *  New: tasks with input_values validate keys/values as non-empty strings ≤ 2048. */

const baseSpec = {
  goal: "test goal",
  ac: ["acceptance criterion 1"],
}

describe("taskSpecSchema.input_values (T1)", () => {
  it("parses without input_values (backward compat)", () => {
    const result = taskSpecSchema.parse(baseSpec)
    expect(result.input_values).toBeUndefined()
  })

  it("parses with valid input_values", () => {
    const result = taskSpecSchema.parse({
      ...baseSpec,
      input_values: { requirement: "${goal}", base_branch: "main" },
    })
    expect(result.input_values).toEqual({
      requirement: "${goal}",
      base_branch: "main",
    })
  })

  it("parses with empty input_values object", () => {
    const result = taskSpecSchema.parse({
      ...baseSpec,
      input_values: {},
    })
    expect(result.input_values).toEqual({})
  })

  it("fails when input_values key is empty string", () => {
    expect(() =>
      taskSpecSchema.parse({
        ...baseSpec,
        input_values: { "": "value" },
      }),
    ).toThrow()
  })

  it("fails when input_values value is empty string", () => {
    expect(() =>
      taskSpecSchema.parse({
        ...baseSpec,
        input_values: { key: "" },
      }),
    ).toThrow()
  })

  it("fails when input_values value exceeds 2048 chars", () => {
    expect(() =>
      taskSpecSchema.parse({
        ...baseSpec,
        input_values: { key: "x".repeat(2049) },
      }),
    ).toThrow()
  })

  it("accepts input_values value at exactly 2048 chars", () => {
    const result = taskSpecSchema.parse({
      ...baseSpec,
      input_values: { key: "x".repeat(2048) },
    })
    expect(result.input_values?.key).toBe("x".repeat(2048))
  })

  it("fails when input_values is not an object", () => {
    expect(() =>
      taskSpecSchema.parse({
        ...baseSpec,
        input_values: "not-an-object",
      }),
    ).toThrow()
  })

  it("fails when input_values value is not a string", () => {
    expect(() =>
      taskSpecSchema.parse({
        ...baseSpec,
        input_values: { key: 123 },
      }),
    ).toThrow()
  })
})
