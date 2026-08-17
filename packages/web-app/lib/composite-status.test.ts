import { describe, it, expect } from "vitest"
import { computeAggregateStatus } from "./composite-status"

describe("computeAggregateStatus", () => {
  // Helper: build children with given statuses.
  const children = (statuses: string[]) =>
    statuses.map((s) => ({ status: s, name: "x", schedule_id: "x", workflow_ref: "x", subunit_name: "x" }))

  it("returns failed if any child failed", () => {
    const kids = children(["done", "failed", "running"])
    expect(computeAggregateStatus(kids, "running")).toBe("failed")
  })

  it("returns aborted if any child aborted", () => {
    const kids = children(["done", "aborted", "done"])
    expect(computeAggregateStatus(kids, "running")).toBe("aborted")
  })

  it("returns running while any child is queued/claimed/running", () => {
    expect(computeAggregateStatus(children(["queued", "done"]), "running")).toBe("running")
    expect(computeAggregateStatus(children(["claimed", "done"]), "running")).toBe("running")
    expect(computeAggregateStatus(children(["running", "done"]), "running")).toBe("running")
  })

  it("returns done when all children done and parent done (integration complete)", () => {
    const kids = children(["done", "done", "done"])
    expect(computeAggregateStatus(kids, "done")).toBe("done")
  })

  it("returns running when all children done but parent not done (integration in-flight)", () => {
    const kids = children(["done", "done"])
    expect(computeAggregateStatus(kids, "running")).toBe("running")
  })

  it("returns parent status when no children dispatched yet", () => {
    expect(computeAggregateStatus([], "running")).toBe("running")
    expect(computeAggregateStatus([], "queued")).toBe("queued")
  })

  it("failed takes precedence over aborted", () => {
    const kids = children(["failed", "aborted"])
    expect(computeAggregateStatus(kids, "running")).toBe("failed")
  })

  it("failed takes precedence over running", () => {
    const kids = children(["failed", "running"])
    expect(computeAggregateStatus(kids, "running")).toBe("failed")
  })
})
