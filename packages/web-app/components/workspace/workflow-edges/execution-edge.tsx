"use client"

import { BaseEdge, getSmoothStepPath, type EdgeProps, MarkerType } from "@xyflow/react"
import type { ExecutionStatus } from "@/lib/types"

const edgeStyleMap: Record<ExecutionStatus, { stroke: string; strokeWidth: number; dashed: boolean }> = {
  pending: { stroke: "#6e6862", strokeWidth: 2, dashed: true },
  running: { stroke: "#c9a35c", strokeWidth: 3, dashed: false },
  completed: { stroke: "#8ba88e", strokeWidth: 2, dashed: false },
  completed_with_failures: { stroke: "#d97757", strokeWidth: 2, dashed: false },
  failed: { stroke: "#b4534a", strokeWidth: 2, dashed: false },
  cancelled: { stroke: "#6e6862", strokeWidth: 2, dashed: true },
  paused: { stroke: "#d97757", strokeWidth: 2, dashed: true },
  skipped: { stroke: "#6e6862", strokeWidth: 1, dashed: true },
  rejected: { stroke: "#d97757", strokeWidth: 2, dashed: true },
  pending_approval: { stroke: "#c9a35c", strokeWidth: 2, dashed: true },
  pending_interaction: { stroke: "#d97757", strokeWidth: 2, dashed: true },
  pending_resume: { stroke: "#7fa3a8", strokeWidth: 2, dashed: true },
  budget_exceeded: { stroke: "#b4534a", strokeWidth: 2, dashed: false },
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