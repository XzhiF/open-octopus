import { describe, it, expect } from "vitest"
import { computeAggregateStatus } from "./composite-status"

describe("computeAggregateStatus", () => {
  // Helper: build children with given statuses.
  const children = (statuses: string[]) =>
    statuses.map((s) => ({ status: s, name: "x", run_id: "x", workflow_ref: "x", subunit_name: "x" }))

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

  // ── ADR-0021 票03: children are executions rows, so the vocabulary is theirs now ──

  it("a pending (armed, waiting behind the cap) run keeps the composite in flight", () => {
    expect(computeAggregateStatus(children(["pending", "completed"]), "running")).toBe("running")
  })

  it("all runs completed + parent done → done", () => {
    expect(computeAggregateStatus(children(["completed", "completed"]), "done")).toBe("done")
  })

  it("cancelled counts as a terminal failure", () => {
    expect(computeAggregateStatus(children(["cancelled", "completed"]), "running")).toBe("aborted")
  })
})
