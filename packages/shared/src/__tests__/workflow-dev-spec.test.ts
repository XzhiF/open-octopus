// workflow-dev task kind (2026-11-06): the kind + state must survive Zod parse
// so a PUT/spec-field round-trip never strips them.

import { describe, expect, it } from "vitest"
import { taskSpecSchema } from "../types/scheduler-job"

describe("taskSpecSchema — workflow-dev kind", () => {
  it("parses kind + workflow_dev state", () => {
    const spec = taskSpecSchema.parse({
      format: "v4",
      kind: "workflow-dev",
      workflow_dev: {
        active_ref: "my-flow.yaml",
        completed_refs: ["old.yaml"],
        stage: "release",
        validation: { ref: "my-flow.yaml", hash: "h", valid: true, at: "now", errors: [] },
        simulation: { ref: "my-flow.yaml", hash: "h", passed: true, at: "now", scenarios: ["basic"] },
        complete: true,
      },
    })
    expect(spec.kind).toBe("workflow-dev")
    expect(spec.workflow_dev?.active_ref).toBe("my-flow.yaml")
    expect(spec.workflow_dev?.completed_refs).toEqual(["old.yaml"])
    expect(spec.workflow_dev?.simulation?.passed).toBe(true)
  })

  it("defaults completed_refs for a partial state object", () => {
    const spec = taskSpecSchema.parse({ format: "v4", kind: "workflow-dev", workflow_dev: {} })
    expect(spec.workflow_dev?.completed_refs).toEqual([])
  })

  it("keeps ordinary v4 specs unchanged", () => {
    const spec = taskSpecSchema.parse({ format: "v4" })
    expect(spec.kind).toBeUndefined()
    expect(spec.workflow_dev).toBeUndefined()
  })

  it("rejects an unknown kind", () => {
    expect(taskSpecSchema.safeParse({ format: "v4", kind: "other" }).success).toBe(false)
  })
})
