import { describe, it, expect } from "vitest"
import {
  workflowPresetSchema,
  workflowPresetsCatalogSchema,
} from "../types/workflow-presets"

describe("workflowPresetSchema", () => {
  it("parses a valid preset with all fields", () => {
    const result = workflowPresetSchema.parse({
      name: "basic-dev",
      skills_group: ["octo-backend"],
      workflow: "built-in/basic-dev-flow",
      inputs: { requirement: "${goal}" },
    })
    expect(result.name).toBe("basic-dev")
    expect(result.skills_group).toEqual(["octo-backend"])
    expect(result.workflow).toBe("built-in/basic-dev-flow")
    expect(result.inputs).toEqual({ requirement: "${goal}" })
  })

  it("defaults skills_group to [] when omitted", () => {
    const result = workflowPresetSchema.parse({
      name: "general",
      workflow: "built-in/flow",
    })
    expect(result.skills_group).toEqual([])
  })

  it("defaults inputs to {} when omitted", () => {
    const result = workflowPresetSchema.parse({
      name: "general",
      workflow: "built-in/flow",
    })
    expect(result.inputs).toEqual({})
  })

  it("fails when name is missing", () => {
    expect(() =>
      workflowPresetSchema.parse({ workflow: "built-in/flow" }),
    ).toThrow()
  })

  it("fails when name is empty string", () => {
    expect(() =>
      workflowPresetSchema.parse({ name: "", workflow: "built-in/flow" }),
    ).toThrow()
  })

  it("fails when workflow is missing", () => {
    expect(() =>
      workflowPresetSchema.parse({ name: "test" }),
    ).toThrow()
  })

  it("fails when workflow is empty string", () => {
    expect(() =>
      workflowPresetSchema.parse({ name: "test", workflow: "" }),
    ).toThrow()
  })

  it("accepts empty skills_group array", () => {
    const result = workflowPresetSchema.parse({
      name: "general",
      skills_group: [],
      workflow: "built-in/flow",
    })
    expect(result.skills_group).toEqual([])
  })
})

describe("workflowPresetsCatalogSchema", () => {
  it("parses a valid catalog", () => {
    const result = workflowPresetsCatalogSchema.parse({
      presets: [
        { name: "a", workflow: "built-in/a" },
        { name: "b", skills_group: ["x"], workflow: "built-in/b", inputs: { k: "${goal}" } },
      ],
    })
    expect(result.presets).toHaveLength(2)
    expect(result.presets[0].skills_group).toEqual([])
    expect(result.presets[1].inputs).toEqual({ k: "${goal}" })
  })

  it("defaults presets to [] when omitted", () => {
    const result = workflowPresetsCatalogSchema.parse({})
    expect(result.presets).toEqual([])
  })

  it("defaults presets to [] for empty object", () => {
    const result = workflowPresetsCatalogSchema.parse({ presets: [] })
    expect(result.presets).toEqual([])
  })

  it("fails when a preset is invalid", () => {
    expect(() =>
      workflowPresetsCatalogSchema.parse({
        presets: [{ name: "", workflow: "built-in/a" }],
      }),
    ).toThrow()
  })
})
