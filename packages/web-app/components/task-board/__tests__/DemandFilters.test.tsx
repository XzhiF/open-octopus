import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { DemandFilters } from "../DemandFilters"
import type { DemandFilterValues } from "../DemandFilters"

describe("DemandFilters", () => {
  it("renders status dropdown with all statuses", () => {
    render(<DemandFilters onFilterChange={() => {}} />)
    const statusSelect = screen.getByLabelText(/status/i) as HTMLSelectElement
    expect(statusSelect).toBeInTheDocument()
    // Check all status options exist within the status select
    const options = Array.from(statusSelect.options).map((o) => o.text)
    expect(options).toContain("All")
    expect(options).toContain("Draft")
    expect(options).toContain("Discussing")
    expect(options).toContain("Incubated")
    expect(options).toContain("Ready")
    expect(options).toContain("Dispatched")
    expect(options).toContain("Executing")
    expect(options).toContain("Done")
    expect(options).toContain("Failed")
    expect(options.length).toBe(9) // All + 8 statuses
  })

  it("renders priority dropdown with all priorities", () => {
    render(<DemandFilters onFilterChange={() => {}} />)
    const prioritySelect = screen.getByLabelText(/priority/i)
    expect(prioritySelect).toBeInTheDocument()
  })

  it("renders search input", () => {
    render(<DemandFilters onFilterChange={() => {}} />)
    expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument()
  })

  it("renders date range inputs", () => {
    render(<DemandFilters onFilterChange={() => {}} />)
    expect(screen.getByLabelText(/from/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/to/i)).toBeInTheDocument()
  })

  it("calls onFilterChange when status changes", () => {
    const onFilterChange = vi.fn()
    render(<DemandFilters onFilterChange={onFilterChange} />)
    const statusSelect = screen.getByLabelText(/status/i)
    fireEvent.change(statusSelect, { target: { value: "draft" } })
    expect(onFilterChange).toHaveBeenCalledWith(
      expect.objectContaining({ status: "draft" })
    )
  })

  it("calls onFilterChange when priority changes", () => {
    const onFilterChange = vi.fn()
    render(<DemandFilters onFilterChange={onFilterChange} />)
    const prioritySelect = screen.getByLabelText(/priority/i)
    fireEvent.change(prioritySelect, { target: { value: "critical" } })
    expect(onFilterChange).toHaveBeenCalledWith(
      expect.objectContaining({ priority: "critical" })
    )
  })

  it("calls onFilterChange when search text changes", () => {
    const onFilterChange = vi.fn()
    render(<DemandFilters onFilterChange={onFilterChange} />)
    const searchInput = screen.getByPlaceholderText(/search/i)
    fireEvent.change(searchInput, { target: { value: "auth module" } })
    expect(onFilterChange).toHaveBeenCalledWith(
      expect.objectContaining({ search: "auth module" })
    )
  })

  it("calls onFilterChange when date range changes", () => {
    const onFilterChange = vi.fn()
    render(<DemandFilters onFilterChange={onFilterChange} />)
    const fromInput = screen.getByLabelText(/from/i)
    fireEvent.change(fromInput, { target: { value: "2026-01-01" } })
    expect(onFilterChange).toHaveBeenCalledWith(
      expect.objectContaining({ createdAtFrom: "2026-01-01" })
    )
  })

  it("emits empty string for 'All' status selection", () => {
    const onFilterChange = vi.fn()
    render(<DemandFilters onFilterChange={onFilterChange} />)
    const statusSelect = screen.getByLabelText(/status/i)
    fireEvent.change(statusSelect, { target: { value: "" } })
    expect(onFilterChange).toHaveBeenCalledWith(
      expect.objectContaining({ status: "" })
    )
  })
})
