"use client"

import { BaseEdge, getSmoothStepPath, type EdgeProps, MarkerType } from "@xyflow/react"
import type { ExecutionStatus } from "@/lib/types"

const edgeStyleMap: Record<ExecutionStatus, { stroke: string; strokeWidth: number; dashed: boolean }> = {
  pending: { stroke: "#9698A3", strokeWidth: 2, dashed: true },
  running: { stroke: "#FFC857", strokeWidth: 3, dashed: false },
  completed: { stroke: "#7EE787", strokeWidth: 2, dashed: false },
  completed_with_failures: { stroke: "#FF855C", strokeWidth: 2, dashed: false },
  failed: { stroke: "#FF5C5C", strokeWidth: 2, dashed: false },
  cancelled: { stroke: "#9698A3", strokeWidth: 2, dashed: true },
  paused: { stroke: "#FF855C", strokeWidth: 2, dashed: true },
  skipped: { stroke: "#9698A3", strokeWidth: 1, dashed: true },
  rejected: { stroke: "#FF855C", strokeWidth: 2, dashed: true },
  pending_approval: { stroke: "#FFC857", strokeWidth: 2, dashed: true },
  pending_interaction: { stroke: "#FF855C", strokeWidth: 2, dashed: true },
  pending_resume: { stroke: "#4FD1D9", strokeWidth: 2, dashed: true },
  budget_exceeded: { stroke: "#FF5C5C", strokeWidth: 2, dashed: false },
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