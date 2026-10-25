import { describe, it, expect } from "vitest"
import { getActivityBus } from "../services/activity/activity-bus"

describe("ActivityBus", () => {
  it("fans out to subscribers and filters by workspace", () => {
    const bus = getActivityBus()
    const seen: string[] = []
    const off = bus.subscribe((event) => seen.push(event.kind))

    bus.publish({
      kind: "workflow.started",
      severity: "info",
      title: "wf start",
      workspaceId: "ws-activity-test-a",
      executionId: "exec-a",
    })
    bus.publish({
      kind: "workflow.failed",
      severity: "critical",
      title: "wf failed",
      workspaceId: "ws-activity-test-b",
      executionId: "exec-b",
    })

    expect(seen).toEqual(["workflow.started", "workflow.failed"])
    expect(bus.list({ workspaceId: "ws-activity-test-a" }).map((e) => e.title)).toEqual(["wf start"])
    expect(bus.list({ limit: 1 })[0].executionId).toBe("exec-b")

    off()
    bus.publish({
      kind: "task.completed",
      severity: "info",
      title: "after unsubscribe",
      workspaceId: "ws-activity-test-a",
    })
    expect(seen).toHaveLength(2)
  })
})
