import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { DemandDetail } from "../DemandDetail"
import type { Demand } from "@octopus/shared"

// Mock the API client
vi.mock("@/lib/demand-api", () => ({
  markDemandReady: vi.fn().mockResolvedValue({ id: "d1", status: "ready" }),
  retryDemand: vi.fn().mockResolvedValue({ id: "d1", status: "ready" }),
}))

function makeDemand(overrides: Partial<Demand> = {}): Demand {
  return {
    id: "d1",
    title: "Implement auth module",
    description: "Add JWT-based authentication",
    status: "draft",
    priority: "normal",
    project_ids: ["proj-alpha"],
    demand_workflow_ref: "wf-1",
    exec_workflow_chain: [],
    created_at: "2026-08-10T10:00:00Z",
    updated_at: "2026-08-14T10:00:00Z",
    ...overrides,
  }
}

describe("DemandDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("renders null when demand is null", () => {
    const { container } = render(
      <DemandDetail demand={null} onClose={() => {}} onRefresh={() => {}} />
    )
    expect(container.innerHTML).toBe("")
  })

  it("renders demand title", () => {
    render(
      <DemandDetail demand={makeDemand()} onClose={() => {}} onRefresh={() => {}} />
    )
    expect(screen.getByText("Implement auth module")).toBeInTheDocument()
  })

  it("renders demand description", () => {
    render(
      <DemandDetail demand={makeDemand()} onClose={() => {}} onRefresh={() => {}} />
    )
    expect(screen.getByText("Add JWT-based authentication")).toBeInTheDocument()
  })

  it("renders status badge", () => {
    render(
      <DemandDetail demand={makeDemand({ status: "draft" })} onClose={() => {}} onRefresh={() => {}} />
    )
    expect(screen.getByText("draft")).toBeInTheDocument()
  })

  it("renders priority badge", () => {
    render(
      <DemandDetail demand={makeDemand({ priority: "critical" })} onClose={() => {}} onRefresh={() => {}} />
    )
    expect(screen.getByText("critical")).toBeInTheDocument()
  })

  it("shows 'Mark Ready' button for incubated status", () => {
    render(
      <DemandDetail
        demand={makeDemand({ status: "incubated" })}
        onClose={() => {}}
        onRefresh={() => {}}
      />
    )
    expect(screen.getByText("Mark Ready")).toBeInTheDocument()
  })

  it("shows 'Retry' button for failed status", () => {
    render(
      <DemandDetail
        demand={makeDemand({ status: "failed" })}
        onClose={() => {}}
        onRefresh={() => {}}
      />
    )
    expect(screen.getByText("Retry")).toBeInTheDocument()
  })

  it("does not show action buttons for draft status", () => {
    render(
      <DemandDetail
        demand={makeDemand({ status: "draft" })}
        onClose={() => {}}
        onRefresh={() => {}}
      />
    )
    expect(screen.queryByText("Mark Ready")).toBeNull()
    expect(screen.queryByText("Retry")).toBeNull()
  })

  it("calls markDemandReady API when 'Mark Ready' clicked", async () => {
    const { markDemandReady } = await import("@/lib/demand-api")
    const onRefresh = vi.fn()
    render(
      <DemandDetail
        demand={makeDemand({ status: "incubated" })}
        onClose={() => {}}
        onRefresh={onRefresh}
      />
    )
    fireEvent.click(screen.getByText("Mark Ready"))
    await waitFor(() => {
      expect(markDemandReady).toHaveBeenCalledWith("d1")
    })
  })

  it("calls retryDemand API when 'Retry' clicked", async () => {
    const { retryDemand } = await import("@/lib/demand-api")
    const onRefresh = vi.fn()
    render(
      <DemandDetail
        demand={makeDemand({ status: "failed" })}
        onClose={() => {}}
        onRefresh={onRefresh}
      />
    )
    fireEvent.click(screen.getByText("Retry"))
    await waitFor(() => {
      expect(retryDemand).toHaveBeenCalledWith("d1")
    })
  })

  it("calls onRefresh after successful action", async () => {
    const { markDemandReady } = await import("@/lib/demand-api")
    const onRefresh = vi.fn()
    render(
      <DemandDetail
        demand={makeDemand({ status: "incubated" })}
        onClose={() => {}}
        onRefresh={onRefresh}
      />
    )
    fireEvent.click(screen.getByText("Mark Ready"))
    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalled()
    })
  })

  it("shows chat stub message", () => {
    render(
      <DemandDetail demand={makeDemand()} onClose={() => {}} onRefresh={() => {}} />
    )
    expect(screen.getByText(/chat feature coming soon/i)).toBeInTheDocument()
  })

  it("shows execution stub message", () => {
    render(
      <DemandDetail demand={makeDemand()} onClose={() => {}} onRefresh={() => {}} />
    )
    expect(screen.getByText(/no execution data/i)).toBeInTheDocument()
  })

  it("renders project_ids", () => {
    render(
      <DemandDetail
        demand={makeDemand({ project_ids: ["proj-alpha", "proj-beta"] })}
        onClose={() => {}}
        onRefresh={() => {}}
      />
    )
    expect(screen.getByText("proj-alpha")).toBeInTheDocument()
    expect(screen.getByText("proj-beta")).toBeInTheDocument()
  })

  it("shows close button that calls onClose", () => {
    const onClose = vi.fn()
    render(
      <DemandDetail demand={makeDemand()} onClose={onClose} onRefresh={() => {}} />
    )
    fireEvent.click(screen.getByText("Close"))
    expect(onClose).toHaveBeenCalled()
  })
})
