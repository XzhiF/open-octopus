"use client"

import { BaseEdge, getSmoothStepPath, type EdgeProps, MarkerType } from "@xyflow/react"
import type { ExecutionStatus } from "@/lib/types"

const edgeStyleMap: Record<ExecutionStatus, { stroke: string; strokeWidth: number; dashed: boolean }> = {
  pending: { stroke: "#d1d5db", strokeWidth: 2, dashed: true },
  running: { stroke: "#f59e0b", strokeWidth: 3, dashed: false },
  completed: { stroke: "#10b981", strokeWidth: 2, dashed: false },
  completed_with_failures: { stroke: "#f97316", strokeWidth: 2, dashed: false },
  failed: { stroke: "#ef4444", strokeWidth: 2, dashed: false },
  cancelled: { stroke: "#d1d5db", strokeWidth: 2, dashed: true },
  paused: { stroke: "#8b5cf6", strokeWidth: 2, dashed: true },
  skipped: { stroke: "#9ca3af", strokeWidth: 1, dashed: true },
  rejected: { stroke: "#ea580c", strokeWidth: 2, dashed: true },
  pending_approval: { stroke: "#f59e0b", strokeWidth: 2, dashed: true },
}

export function ExecutionEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd }: EdgeProps) {
  const parentStatus = (data?.executionStatus as ExecutionStatus) || "pending" as ExecutionStatus
  const style = edgeStyleMap[parentStatus] || edgeStyleMap.pending

  const [edgePath] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 8 })

  // Use markerEnd if provided, otherwise add arrow
  const arrowMarker = markerEnd ? undefined : {
    type: MarkerType.ArrowClosed,
    color: style.stroke,
    width: 15,
    height: 15,
    orient: 'auto-start-reverse',
  }

  return <BaseEdge id={id} path={edgePath} style={{ stroke: style.stroke, strokeWidth: style.strokeWidth, strokeDasharray: style.dashed ? "5,5" : "none" }} markerEnd={typeof markerEnd === "string" ? markerEnd : undefined} />
}