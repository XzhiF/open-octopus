import { describe, it, expect } from "vitest"
import { TASK_COLUMNS, groupTasksByStatus, type TaskBoardStatus } from "../task-board"
import type { Task } from "@octopus/shared"

function makeTask(partial: Partial<Task> & { id: string }): Task {
  return {
    org: "default",
    name: partial.id,
    status: "draft",
    task_spec: { goal: "g", ac: ["a"], resources: [], authoring_resources: [] },
    authoring_resources: [],
    resources: [],
    skills: [],
    project_ids: [],
    workflow_ref: undefined,
    version: 1,
    source_chat_session_id: null,
    deleted_at: null,
    created_at: "2026-08-17T00:00:00Z",
    updated_at: "2026-08-17T00:00:00Z",
    completed_at: null,
    ...partial,
  } as Task
}

describe("TASK_COLUMNS", () => {
  it("exposes the 6 first-class TaskStatus columns (claimed folded into running, v2-D14)", () => {
    const ids = TASK_COLUMNS.map((c) => c.id)
    expect(ids).toEqual(["draft", "ready", "running", "done", "failed", "aborted"])
  })

  it("labels each column in the spec lifecycle order", () => {
    const labels = TASK_COLUMNS.map((c) => c.label)
    expect(labels).toEqual(["草稿", "待执行", "执行中", "已完成", "失败", "已中止"])
  })
})

describe("groupTasksByStatus", () => {
  it("returns all 6 buckets even when input is empty (AC1 反假跑)", () => {
    const grouped = groupTasksByStatus([])
    const bucketKeys = Object.keys(grouped).sort()
    const expected = TASK_COLUMNS.map((c) => c.id).sort()
    expect(bucketKeys).toEqual(expected)
    for (const key of expected as TaskBoardStatus[]) {
      expect(grouped[key]).toEqual([])
    }
  })

  it("places tasks into matching status bucket (no schedule join needed)", () => {
    const tasks = [
      makeTask({ id: "a", status: "draft", name: "草稿A" }),
      makeTask({ id: "b", status: "ready", name: "待执行B" }),
      makeTask({ id: "c", status: "running", name: "执行中C" }),
    ]
    const grouped = groupTasksByStatus(tasks)
    expect(grouped.draft.map((t) => t.id)).toEqual(["a"])
    expect(grouped.ready.map((t) => t.id)).toEqual(["b"])
    expect(grouped.running.map((t) => t.id)).toEqual(["c"])
    expect(grouped.done).toEqual([])
    expect(grouped.failed).toEqual([])
    expect(grouped.aborted).toEqual([])
  })

  it("buckets terminal failed + aborted into their own columns (G2: no rollback)", () => {
    const tasks = [
      makeTask({ id: "f", status: "failed", name: "失败任务" }),
      makeTask({ id: "ab", status: "aborted", name: "中止任务" }),
      makeTask({ id: "d", status: "done", name: "完成任务" }),
    ]
    const grouped = groupTasksByStatus(tasks)
    expect(grouped.failed.map((t) => t.id)).toEqual(["f"])
    expect(grouped.aborted.map((t) => t.id)).toEqual(["ab"])
    expect(grouped.done.map((t) => t.id)).toEqual(["d"])
    // Must NOT leak into running (the stale-loop regression G2 fixes).
    expect(grouped.running).toEqual([])
  })

  it("does not mutate the input tasks array", () => {
    const tasks = [makeTask({ id: "a", status: "draft" })]
    const snapshot = [...tasks]
    groupTasksByStatus(tasks)
    expect(tasks).toEqual(snapshot)
  })
})
