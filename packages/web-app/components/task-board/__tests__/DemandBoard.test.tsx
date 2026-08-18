import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { DemandBoard } from "../DemandBoard"
import type { Demand } from "@octopus/shared"
import * as demandApi from "@/lib/demand-api"

// Mock API client
vi.mock("@/lib/demand-api", () => ({
  listDemands: vi.fn(),
  getPoolStatus: vi.fn(),
  markDemandReady: vi.fn().mockResolvedValue({ id: "d1", status: "ready" }),
  retryDemand: vi.fn().mockResolvedValue({ id: "d1", status: "ready" }),
}))

const mockedListDemands = vi.mocked(demandApi.listDemands)
const mockedGetPoolStatus = vi.mocked(demandApi.getPoolStatus)

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

const emptyPoolStatus = {
  draft: 0, discussing: 0, incubated: 0, ready: 0,
  dispatched: 0, executing: 0, done: 0, failed: 0,
}

describe("DemandBoard", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedListDemands.mockResolvedValue({ demands: [], total: 0 })
    mockedGetPoolStatus.mockResolvedValue(emptyPoolStatus)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("shows loading state initially", () => {
    render(<DemandBoard />)
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  it("renders 7+ columns after loading", async () => {
    render(<DemandBoard />)
    await waitFor(() => {
      // 8 statuses: draft, discussing, incubated, ready, dispatched, executing, done, failed
      const columns = screen.getAllByTestId("demand-column-wrapper")
      expect(columns.length).toBe(8)
    })
  })

  it("renders all status column labels", async () => {
    render(<DemandBoard />)
    await waitFor(() => {
      // Each status label appears in both the filter dropdown and column header
      // so we use getAllByText and check at least 2 matches
      expect(screen.getAllByText("Draft").length).toBeGreaterThanOrEqual(2)
      expect(screen.getAllByText("Discussing").length).toBeGreaterThanOrEqual(2)
      expect(screen.getAllByText("Incubated").length).toBeGreaterThanOrEqual(2)
      expect(screen.getAllByText("Ready").length).toBeGreaterThanOrEqual(2)
      expect(screen.getAllByText("Dispatched").length).toBeGreaterThanOrEqual(2)
      expect(screen.getAllByText("Executing").length).toBeGreaterThanOrEqual(2)
      expect(screen.getAllByText("Done").length).toBeGreaterThanOrEqual(2)
      expect(screen.getAllByText("Failed").length).toBeGreaterThanOrEqual(2)
    })
  })

  it("groups demands by status", async () => {
    mockedListDemands.mockResolvedValue({
      demands: [
        makeDemand({ id: "d1", title: "Draft Task", status: "draft" }),
        makeDemand({ id: "d2", title: "Ready Task", status: "ready" }),
        makeDemand({ id: "d3", title: "Done Task", status: "done" }),
      ],
      total: 3,
    })

    render(<DemandBoard />)

    await waitFor(() => {
      expect(screen.getByText("Draft Task")).toBeInTheDocument()
      expect(screen.getByText("Ready Task")).toBeInTheDocument()
      expect(screen.getByText("Done Task")).toBeInTheDocument()
    })
  })

  it("shows error state on fetch failure", async () => {
    mockedListDemands.mockRejectedValue(new Error("Network error"))

    render(<DemandBoard />)

    await waitFor(() => {
      expect(screen.getByText(/error/i)).toBeInTheDocument()
    })
  })

  it("fetches data from API on mount", async () => {
    render(<DemandBoard />)

    await waitFor(() => {
      expect(mockedListDemands).toHaveBeenCalled()
      expect(mockedGetPoolStatus).toHaveBeenCalled()
    })
  })

  it("shows demand count in column headers", async () => {
    mockedGetPoolStatus.mockResolvedValue({
      draft: 3, discussing: 1, incubated: 0, ready: 2,
      dispatched: 0, executing: 1, done: 5, failed: 0,
    })

    render(<DemandBoard />)

    await waitFor(() => {
      // At least one column should show count 3 (draft)
      expect(screen.getByText("3")).toBeInTheDocument()
    })
  })
})
