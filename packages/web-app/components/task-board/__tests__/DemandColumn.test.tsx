import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { DemandColumn } from "../DemandColumn"
import type { Demand, DemandStatus } from "@octopus/shared"

function makeDemand(overrides: Partial<Demand> = {}): Demand {
  return {
    id: "d1",
    title: "Test demand",
    status: "draft",
    priority: "normal",
    project_ids: ["p1"],
    demand_workflow_ref: "wf-1",
    exec_workflow_chain: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

describe("DemandColumn", () => {
  it("renders the status label", () => {
    render(
      <DemandColumn status="draft" demands={[]} count={0} onSelect={() => {}} />
    )
    expect(screen.getByText("Draft")).toBeInTheDocument()
  })

  it("renders the count badge", () => {
    render(
      <DemandColumn status="ready" demands={[]} count={5} onSelect={() => {}} />
    )
    expect(screen.getByText("5")).toBeInTheDocument()
  })

  it("renders demand cards for each demand", () => {
    const demands = [
      makeDemand({ id: "d1", title: "Demand 1" }),
      makeDemand({ id: "d2", title: "Demand 2" }),
    ]
    render(
      <DemandColumn status="draft" demands={demands} count={2} onSelect={() => {}} />
    )
    expect(screen.getByText("Demand 1")).toBeInTheDocument()
    expect(screen.getByText("Demand 2")).toBeInTheDocument()
  })

  it("renders empty state when no demands", () => {
    const { container } = render(
      <DemandColumn status="draft" demands={[]} count={0} onSelect={() => {}} />
    )
    const cards = container.querySelectorAll('[data-slot="demand-card"]')
    expect(cards.length).toBe(0)
  })

  it("applies correct status color for draft (gray)", () => {
    const { container } = render(
      <DemandColumn status="draft" demands={[]} count={0} onSelect={() => {}} />
    )
    const header = container.querySelector('[data-slot="demand-column-header"]')
    expect(header?.className).toContain("gray")
  })

  it("applies correct status color for failed (red)", () => {
    const { container } = render(
      <DemandColumn status="failed" demands={[]} count={0} onSelect={() => {}} />
    )
    const header = container.querySelector('[data-slot="demand-column-header"]')
    expect(header?.className).toContain("red")
  })

  it("applies correct status color for ready (green)", () => {
    const { container } = render(
      <DemandColumn status="ready" demands={[]} count={0} onSelect={() => {}} />
    )
    const header = container.querySelector('[data-slot="demand-column-header"]')
    expect(header?.className).toContain("green")
  })

  it("passes onSelect to demand cards", () => {
    const onSelect = vi.fn()
    const demand = makeDemand({ id: "d1", title: "Clickable" })
    render(
      <DemandColumn status="draft" demands={[demand]} count={1} onSelect={onSelect} />
    )
    screen.getByText("Clickable").click()
    expect(onSelect).toHaveBeenCalledWith(demand)
  })
})
