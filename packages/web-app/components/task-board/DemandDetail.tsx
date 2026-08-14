"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { markDemandReady, retryDemand } from "@/lib/demand-api"
import type { Demand, DemandPriority } from "@octopus/shared"

interface DemandDetailProps {
  demand: Demand | null
  onClose: () => void
  onRefresh: () => void
}

const PRIORITY_COLORS: Record<DemandPriority, string> = {
  critical: "bg-red-500/15 text-red-600 border-red-200 dark:bg-red-500/20 dark:text-red-400 dark:border-red-800",
  high: "bg-orange-500/15 text-orange-600 border-orange-200 dark:bg-orange-500/20 dark:text-orange-400 dark:border-orange-800",
  normal: "bg-blue-500/15 text-blue-600 border-blue-200 dark:bg-blue-500/20 dark:text-blue-400 dark:border-blue-800",
  low: "bg-gray-400/15 text-gray-600 border-gray-200 dark:bg-gray-400/20 dark:text-gray-400 dark:border-gray-700",
}

export function DemandDetail({ demand, onClose, onRefresh }: DemandDetailProps) {
  const [actionLoading, setActionLoading] = useState(false)

  if (!demand) return null

  async function handleMarkReady() {
    if (!demand) return
    setActionLoading(true)
    try {
      await markDemandReady(demand.id)
      onRefresh()
    } catch (err) {
      console.error("Failed to mark ready:", err)
    } finally {
      setActionLoading(false)
    }
  }

  async function handleRetry() {
    if (!demand) return
    setActionLoading(true)
    try {
      await retryDemand(demand.id)
      onRefresh()
    } catch (err) {
      console.error("Failed to retry:", err)
    } finally {
      setActionLoading(false)
    }
  }

  return (
    <div data-slot="demand-detail" className="flex h-full flex-col overflow-y-auto p-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-lg font-semibold">{demand.title}</h2>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>

      {/* Badges row */}
      <div className="mt-3 flex items-center gap-2 flex-wrap">
        <Badge variant="outline" className="text-xs">
          {demand.status}
        </Badge>
        <Badge
          variant="outline"
          className={cn("text-xs", PRIORITY_COLORS[demand.priority])}
        >
          {demand.priority}
        </Badge>
      </div>

      {/* Description */}
      {demand.description && (
        <div className="mt-4">
          <h3 className="text-sm font-medium text-muted-foreground">Description</h3>
          <p className="mt-1 text-sm">{demand.description}</p>
        </div>
      )}

      {/* Fields */}
      <div className="mt-4 space-y-3">
        <div>
          <span className="text-xs font-medium text-muted-foreground">ID</span>
          <p className="text-sm font-mono">{demand.id}</p>
        </div>
        <div>
          <span className="text-xs font-medium text-muted-foreground">Projects</span>
          <div className="mt-1 flex flex-wrap gap-1">
            {demand.project_ids.map((pid) => (
              <Badge key={pid} variant="secondary" className="text-[10px]">
                {pid}
              </Badge>
            ))}
          </div>
        </div>
        <div>
          <span className="text-xs font-medium text-muted-foreground">Workflow Ref</span>
          <p className="text-sm font-mono">{demand.demand_workflow_ref}</p>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <span className="text-xs font-medium text-muted-foreground">Created</span>
            <p className="text-sm">{new Date(demand.created_at).toLocaleString()}</p>
          </div>
          <div>
            <span className="text-xs font-medium text-muted-foreground">Updated</span>
            <p className="text-sm">{new Date(demand.updated_at).toLocaleString()}</p>
          </div>
        </div>
        {demand.ready_at && (
          <div>
            <span className="text-xs font-medium text-muted-foreground">Ready At</span>
            <p className="text-sm">{new Date(demand.ready_at).toLocaleString()}</p>
          </div>
        )}
        {demand.error_message && (
          <div>
            <span className="text-xs font-medium text-destructive">Error</span>
            <p className="text-sm text-destructive">{demand.error_message}</p>
          </div>
        )}
      </div>

      {/* Status Actions */}
      <div className="mt-6 border-t pt-4">
        <h3 className="text-sm font-medium mb-2">Actions</h3>
        {demand.status === "incubated" && (
          <Button
            size="sm"
            onClick={handleMarkReady}
            disabled={actionLoading}
          >
            {actionLoading ? "Processing..." : "Mark Ready"}
          </Button>
        )}
        {demand.status === "failed" && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleRetry}
            disabled={actionLoading}
          >
            {actionLoading ? "Processing..." : "Retry"}
          </Button>
        )}
        {demand.status !== "incubated" && demand.status !== "failed" && (
          <p className="text-xs text-muted-foreground">
            No actions available for status: {demand.status}
          </p>
        )}
      </div>

      {/* Chat section (stub) */}
      <div className="mt-6 border-t pt-4">
        <h3 className="text-sm font-medium mb-2">Chat</h3>
        <p className="text-xs text-muted-foreground italic">
          Chat feature coming soon
        </p>
      </div>

      {/* Execution section (stub) */}
      <div className="mt-6 border-t pt-4">
        <h3 className="text-sm font-medium mb-2">Execution</h3>
        <p className="text-xs text-muted-foreground italic">
          No execution data available
        </p>
      </div>
    </div>
  )
}
