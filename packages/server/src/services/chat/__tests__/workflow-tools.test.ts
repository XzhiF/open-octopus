import { describe, it, expect } from "vitest"
import { selectReleasedWorkflows } from "../workflow-release"
import type { WorkflowInfo } from "../../../types/workflow-api"

function wf(ref: string, stage: WorkflowInfo["stage"], version?: string): WorkflowInfo {
  return { ref, name: ref.split("/").pop()!, group: "built-in", stage, version }
}

describe("selectReleasedWorkflows", () => {
  it("keeps only released workflows from both scopes", () => {
    const local = [wf("released.yaml", "release", "1.0.0"), wf("draft.yaml", "snapshot")]
    const builtIn = [wf("built-in/matt-spec-dev", "release", "1.0.0"), wf("built-in/dev-flow", "snapshot")]

    const selected = selectReleasedWorkflows(local, builtIn)

    expect(selected.map((w) => w.ref)).toEqual(["released.yaml", "built-in/matt-spec-dev"])
    expect(selected.map((w) => w.scope)).toEqual(["workspace", "built-in"])
  })

  it("preserves version for display", () => {
    const selected = selectReleasedWorkflows([], [wf("built-in/matt-spec-dev", "release", "3.4.5")])
    expect(selected[0].version).toBe("3.4.5")
  })

  it("returns nothing when every workflow is a snapshot", () => {
    expect(selectReleasedWorkflows([wf("a.yaml", "snapshot")], [wf("built-in/b", "snapshot")])).toEqual([])
  })
})
