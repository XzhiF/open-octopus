"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import type { DemandStatus, DemandPriority } from "@octopus/shared"

export interface DemandFilterValues {
  status: string
  priority: string
  search: string
  createdAtFrom: string
  createdAtTo: string
}

interface DemandFiltersProps {
  onFilterChange: (filters: DemandFilterValues) => void
}

const STATUSES: { value: string; label: string }[] = [
  { value: "", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "discussing", label: "Discussing" },
  { value: "incubated", label: "Incubated" },
  { value: "ready", label: "Ready" },
  { value: "dispatched", label: "Dispatched" },
  { value: "executing", label: "Executing" },
  { value: "done", label: "Done" },
  { value: "failed", label: "Failed" },
]

const PRIORITIES: { value: string; label: string }[] = [
  { value: "", label: "All" },
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "normal", label: "Normal" },
  { value: "low", label: "Low" },
]

const selectClass =
  "border-input bg-background h-9 rounded-md border px-3 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] outline-none"

export function DemandFilters({ onFilterChange }: DemandFiltersProps) {
  const [filters, setFilters] = useState<DemandFilterValues>({
    status: "",
    priority: "",
    search: "",
    createdAtFrom: "",
    createdAtTo: "",
  })

  function handleChange(key: keyof DemandFilterValues, value: string) {
    const updated = { ...filters, [key]: value }
    setFilters(updated)
    onFilterChange(updated)
  }

  return (
    <div data-slot="demand-filters" className="flex flex-wrap items-center gap-3">
      {/* Status dropdown */}
      <div className="flex flex-col gap-1">
        <label htmlFor="filter-status" className="text-xs text-muted-foreground">
          Status
        </label>
        <select
          id="filter-status"
          aria-label="Status"
          className={cn(selectClass, "min-w-[130px]")}
          value={filters.status}
          onChange={(e) => handleChange("status", e.target.value)}
        >
          {STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {/* Priority dropdown */}
      <div className="flex flex-col gap-1">
        <label htmlFor="filter-priority" className="text-xs text-muted-foreground">
          Priority
        </label>
        <select
          id="filter-priority"
          aria-label="Priority"
          className={cn(selectClass, "min-w-[120px]")}
          value={filters.priority}
          onChange={(e) => handleChange("priority", e.target.value)}
        >
          {PRIORITIES.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      {/* Search input */}
      <div className="flex flex-col gap-1">
        <label htmlFor="filter-search" className="text-xs text-muted-foreground">
          Search
        </label>
        <Input
          id="filter-search"
          placeholder="Search demands..."
          className="min-w-[200px]"
          value={filters.search}
          onChange={(e) => handleChange("search", e.target.value)}
        />
      </div>

      {/* Date range */}
      <div className="flex items-end gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="filter-from" className="text-xs text-muted-foreground">
            From
          </label>
          <Input
            id="filter-from"
            type="date"
            aria-label="From"
            className="w-[140px]"
            value={filters.createdAtFrom}
            onChange={(e) => handleChange("createdAtFrom", e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="filter-to" className="text-xs text-muted-foreground">
            To
          </label>
          <Input
            id="filter-to"
            type="date"
            aria-label="To"
            className="w-[140px]"
            value={filters.createdAtTo}
            onChange={(e) => handleChange("createdAtTo", e.target.value)}
          />
        </div>
      </div>
    </div>
  )
}
