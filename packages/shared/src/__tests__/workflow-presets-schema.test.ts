import { describe, it, expect } from "vitest"
import {
  workflowPresetSchema,
  workflowPresetsCatalogSchema,
} from "../types/workflow-presets"

describe("workflowPresetSchema (binding-catalog shape)", () => {
  it("parses a valid preset with all fields", () => {
    const result = workflowPresetSchema.parse({
      name: "spec-dev",
      desc: "v4 主打：直读批次执行",
      workflow: "built-in/matt-spec-dev",
      inputs: { batch_dir: "${phase.batch_rel}" },
    })
    expect(result.name).toBe("spec-dev")
    expect(result.desc).toBe("v4 主打：直读批次执行")
    expect(result.workflow).toBe("built-in/matt-spec-dev")
    expect(result.inputs).toEqual({ batch_dir: "${phase.batch_rel}" })
  })

  it("desc is optional", () => {
    const result = workflowPresetSchema.parse({
      name: "general",
      workflow: "built-in/flow",
    })
    expect(result.desc).toBeUndefined()
  })

  it("defaults inputs to {} when omitted", () => {
    const result = workflowPresetSchema.parse({
      name: "general",
      workflow: "built-in/flow",
    })
    expect(result.inputs).toEqual({})
  })

  it("retired skills_group keys are ignored (pre-v3 hand-edited files still parse)", () => {
    const result = workflowPresetSchema.parse({
      name: "general-dev",
      skills_group: [],
      workflow: "built-in/task-dev",
      inputs: { goal: "${goal}" },
    })
    expect(result.workflow).toBe("built-in/task-dev")
    expect("skills_group" in result).toBe(false)
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
})

describe("workflowPresetsCatalogSchema", () => {
  it("parses a valid catalog", () => {
    const result = workflowPresetsCatalogSchema.parse({
      presets: [
        { name: "a", workflow: "built-in/a" },
        { name: "b", desc: "d", workflow: "built-in/b", inputs: { k: "${phase.slug}" } },
      ],
    })
    expect(result.presets).toHaveLength(2)
    expect(result.presets[0].inputs).toEqual({})
    expect(result.presets[1].inputs).toEqual({ k: "${phase.slug}" })
  })

  it("defaults presets to [] when omitted", () => {
    const result = workflowPresetsCatalogSchema.parse({})
    expect(result.presets).toEqual([])
  })

  it("parses an empty catalog", () => {
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
