"use client"

import { useState, useEffect, useCallback } from "react"
import { listDemands, getPoolStatus } from "@/lib/demand-api"
import type { DemandFilterValues } from "./DemandFilters"
import { DemandFilters } from "./DemandFilters"
import { DemandColumn } from "./DemandColumn"
import { DemandDetail } from "./DemandDetail"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import type { Demand, DemandStatus } from "@octopus/shared"

const ALL_STATUSES: DemandStatus[] = [
  "draft", "discussing", "incubated", "ready",
  "dispatched", "executing", "done", "failed",
]

export function DemandBoard() {
  const [demands, setDemands] = useState<Demand[]>([])
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedDemand, setSelectedDemand] = useState<Demand | null>(null)
  const [filters, setFilters] = useState<DemandFilterValues>({
    status: "",
    priority: "",
    search: "",
    createdAtFrom: "",
    createdAtTo: "",
  })

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params: Record<string, unknown> = {}
      if (filters.status) params.status = filters.status
      if (filters.priority) params.priority = filters.priority
      if (filters.createdAtFrom) params.createdAtFrom = filters.createdAtFrom
      if (filters.createdAtTo) params.createdAtTo = filters.createdAtTo

      const [demandsRes, poolStatus] = await Promise.all([
        listDemands(params as Parameters<typeof listDemands>[0]),
        getPoolStatus(),
      ])

      let demandList = demandsRes.demands

      // Client-side search filter (on title + description)
      if (filters.search) {
        const q = filters.search.toLowerCase()
        demandList = demandList.filter(
          (d) =>
            d.title.toLowerCase().includes(q) ||
            d.description?.toLowerCase().includes(q)
        )
      }

      setDemands(demandList)
      setStatusCounts(poolStatus)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch demands")
    } finally {
      setLoading(false)
    }
  }, [filters])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Group demands by status
  const demandsByStatus = ALL_STATUSES.reduce(
    (acc, status) => {
      acc[status] = demands.filter((d) => d.status === status)
      return acc
    },
    {} as Record<DemandStatus, Demand[]>
  )

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-muted-foreground">Loading demands...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-20">
        <p className="text-destructive">Error: {error}</p>
        <button
          onClick={fetchData}
          className="text-sm underline text-primary hover:no-underline"
        >
          Retry
        </button>
      </div>
    )
  }

  return (
    <div data-slot="demand-board" className="flex flex-col gap-4">
      {/* Filters */}
      <DemandFilters onFilterChange={setFilters} />

      {/* Board (7 columns) */}
      <div className="flex gap-3 overflow-x-auto pb-4" style={{ minHeight: "400px" }}>
        {ALL_STATUSES.map((status) => (
          <div key={status} data-testid="demand-column-wrapper">
            <DemandColumn
              status={status}
              demands={demandsByStatus[status]}
              count={statusCounts[status] ?? demandsByStatus[status].length}
              onSelect={setSelectedDemand}
            />
          </div>
        ))}
      </div>

      {/* Detail side panel */}
      <Sheet
        open={!!selectedDemand}
        onOpenChange={(open) => {
          if (!open) setSelectedDemand(null)
        }}
      >
        <SheetContent side="right" className="sm:max-w-md w-full p-0">
          <SheetTitle className="sr-only">Demand Detail</SheetTitle>
          <DemandDetail
            demand={selectedDemand}
            onClose={() => setSelectedDemand(null)}
            onRefresh={fetchData}
          />
        </SheetContent>
      </Sheet>
    </div>
  )
}
