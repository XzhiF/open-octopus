import { describe, it, expect } from "vitest"
import { materializeTaskSpecToConfig } from "../scheduler-service"
import type { TaskSpec } from "@octopus/shared"

/** task-workflow-presets (T4): materializeTaskSpecToConfig integration with
 *  resolveInputValues. Verifies that ${goal}/${ac} in task_spec.input_values
 *  are resolved and management keys take priority. */

const baseSpec: TaskSpec = {
  goal: "Build a widget",
  ac: ["works correctly", "is performant"],
  resources: [],
  authoring_resources: [],
  skill_groups: [],
  decisions: [],
  ac_confirmed: [],
}

describe("materializeTaskSpecToConfig — input_values resolution (T4)", () => {
  it("resolves ${goal} in input_values", () => {
    const spec: TaskSpec = {
      ...baseSpec,
      input_values: { requirement: "${goal}" },
    }
    const config = materializeTaskSpecToConfig(
      spec, ["proj1"], "test-org", "built-in/flow",
    )
    const inputs = config.workflow_chain[0].input_values as Record<string, string>
    expect(inputs.requirement).toBe("Build a widget")
  })

  it("resolves ${ac} as newline-joined", () => {
    const spec: TaskSpec = {
      ...baseSpec,
      input_values: { acceptance: "${ac}" },
    }
    const config = materializeTaskSpecToConfig(
      spec, ["proj1"], "test-org", "built-in/flow",
    )
    const inputs = config.workflow_chain[0].input_values as Record<string, string>
    expect(inputs.acceptance).toBe("works correctly\nis performant")
  })

  it("task_artifacts_dir takes priority over input_values with same key", () => {
    const spec: TaskSpec = {
      ...baseSpec,
      input_values: { task_artifacts_dir: "user-value" },
    }
    const config = materializeTaskSpecToConfig(
      spec, ["proj1"], "test-org", "built-in/flow",
      undefined, undefined, "/real/artifacts/dir",
    )
    const inputs = config.workflow_chain[0].input_values as Record<string, string>
    expect(inputs.task_artifacts_dir).toBe("/real/artifacts/dir")
  })

  it("works without input_values (backward compat)", () => {
    const config = materializeTaskSpecToConfig(
      baseSpec, ["proj1"], "test-org", "built-in/flow",
    )
    const inputs = config.workflow_chain[0].input_values as Record<string, string>
    // Should not have any user inputs, just whatever management keys were injected
    expect(inputs.requirement).toBeUndefined()
  })

  it("materializes unknown placeholder as empty string (no throw; gate rejects)", () => {
    const spec: TaskSpec = {
      ...baseSpec,
      input_values: { key: "${unknown}" },
    }
    // Review fix 2026-08-27: dispatch must NOT throw on a stray placeholder — the
    // ready-gate surfaces it in missing ("input:key") BEFORE enqueue. If one
    // slips through, materialize keeps "" and warns instead of killing the run.
    const config = materializeTaskSpecToConfig(
      spec, ["proj1"], "test-org", "built-in/flow",
    )
    expect(config.workflow_chain[0].input_values.key).toBe("")
  })

  it("composite task does not include user input_values in chain", () => {
    const spec: TaskSpec = {
      ...baseSpec,
      input_values: { requirement: "${goal}" },
      subunits: [
        {
          name: "sub1",
          workspace_spec: { org: "test", branch_prefix: "test", projects: [{ name: "p", source_path: "", group: "" }] },
          workflow_ref: "flow1",
          input_values: {},
          skills: [],
          resources: [],
        },
        {
          name: "sub2",
          workspace_spec: { org: "test", branch_prefix: "test", projects: [{ name: "p", source_path: "", group: "" }] },
          workflow_ref: "flow2",
          input_values: {},
          skills: [],
          resources: [],
        },
      ],
    }
    const config = materializeTaskSpecToConfig(
      spec, ["proj1"], "test-org",
    )
    // Composite uses composition-task ref, not user's workflow
    expect(config.workflow_chain[0].workflow_ref).toBe("composition-task")
    const inputs = config.workflow_chain[0].input_values as Record<string, string>
    // Composite doesn't carry user input_values (they belong to subunits)
    expect(inputs.requirement).toBeUndefined()
    expect(inputs.subunit_count).toBe(2)
  })
})
