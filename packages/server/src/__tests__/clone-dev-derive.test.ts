// packages/server/src/__tests__/clone-dev-derive.test.ts
//
// clone-dev 派生视图：与 workflow-dev 同构的轻量生命周期。

import { describe, it, expect } from "vitest"
import { deriveTaskView } from "../services/tasks/derive-task-view"

function task(status: string, spec: Record<string, unknown>) {
  return { id: "t", status, task_spec: JSON.stringify({ format: "v4", kind: "clone-dev", ...spec }) }
}

describe("deriveTaskView · clone-dev", () => {
  it("研发中 → ready（无 phase）", () => {
    const v = deriveTaskView(task("draft", { clone_dev: { clone_name: "x", complete: false } }), [], [])
    expect(v.taskStatus).toBe("ready")
    expect(v.phaseViews).toEqual([])
  })

  it("clone_dev.complete → awaiting_archive", () => {
    const v = deriveTaskView(task("ready", { clone_dev: { clone_name: "x", complete: true } }), [], [])
    expect(v.taskStatus).toBe("awaiting_archive")
  })

  it("archiving / done 原样保留", () => {
    expect(
      deriveTaskView(task("archiving", { clone_dev: { clone_name: "x", complete: true } }), [], []).taskStatus,
    ).toBe("archiving")
    expect(
      deriveTaskView(task("done", { clone_dev: { clone_name: "x", complete: true } }), [], []).taskStatus,
    ).toBe("done")
  })
})
