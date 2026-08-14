import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { DemandCard } from "../DemandCard"
import type { Demand } from "@octopus/shared"

function makeDemand(overrides: Partial<Demand> = {}): Demand {
  return {
    id: "d1",
    title: "Implement auth module",
    description: "Add JWT-based auth",
    status: "draft",
    priority: "normal",
    project_ids: ["proj-alpha"],
    demand_workflow_ref: "wf-1",
    exec_workflow_chain: [],
    created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

describe("DemandCard", () => {
  it("renders the demand title", () => {
    render(<DemandCard demand={makeDemand()} onSelect={() => {}} />)
    expect(screen.getByText("Implement auth module")).toBeInTheDocument()
  })

  it("renders priority badge with correct color class", () => {
    const { container } = render(
      <DemandCard demand={makeDemand({ priority: "critical" })} onSelect={() => {}} />
    )
    const badge = container.querySelector('[data-slot="badge"]')
    expect(badge).toBeTruthy()
    expect(badge?.className).toContain("bg-red")
  })

  it("renders high priority with orange color", () => {
    const { container } = render(
      <DemandCard demand={makeDemand({ priority: "high" })} onSelect={() => {}} />
    )
    const badge = container.querySelector('[data-slot="badge"]')
    expect(badge?.className).toContain("bg-orange")
  })

  it("renders normal priority with blue color", () => {
    const { container } = render(
      <DemandCard demand={makeDemand({ priority: "normal" })} onSelect={() => {}} />
    )
    const badge = container.querySelector('[data-slot="badge"]')
    expect(badge?.className).toContain("bg-blue")
  })

  it("renders low priority with gray color", () => {
    const { container } = render(
      <DemandCard demand={makeDemand({ priority: "low" })} onSelect={() => {}} />
    )
    const badge = container.querySelector('[data-slot="badge"]')
    expect(badge?.className).toContain("bg-gray")
  })

  it("shows the first project_id", () => {
    render(
      <DemandCard
        demand={makeDemand({ project_ids: ["proj-alpha", "proj-beta"] })}
        onSelect={() => {}}
      />
    )
    expect(screen.getByText("proj-alpha")).toBeInTheDocument()
  })

  it("truncates long titles", () => {
    const longTitle = "A".repeat(100)
    const { container } = render(
      <DemandCard demand={makeDemand({ title: longTitle })} onSelect={() => {}} />
    )
    const titleEl = container.querySelector('[data-slot="demand-card-title"]')
    expect(titleEl?.className).toContain("truncate")
  })

  it("calls onSelect when clicked", () => {
    const onSelect = vi.fn()
    const demand = makeDemand()
    render(<DemandCard demand={demand} onSelect={onSelect} />)
    fireEvent.click(screen.getByText("Implement auth module"))
    expect(onSelect).toHaveBeenCalledWith(demand)
  })

  it("renders created_at as relative time", () => {
    render(<DemandCard demand={makeDemand()} onSelect={() => {}} />)
    // Should show something like "2h ago" or "2 hours ago"
    expect(screen.getByText(/ago/)).toBeInTheDocument()
  })
})
