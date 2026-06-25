"use client"

import { BaseEdge, getSmoothStepPath, type EdgeProps } from "@xyflow/react"
import type { StepExecutionStatus } from "@/lib/types"

const edgeStyleMap: Record<StepExecutionStatus, { stroke: string; strokeWidth: number; dashed: boolean; opacity: number; animated: boolean }> = {
  pending: { stroke: "#d1d5db", strokeWidth: 2, dashed: true, opacity: 1, animated: false },
  running: { stroke: "#f59e0b", strokeWidth: 3, dashed: true, opacity: 1, animated: true },
  completed: { stroke: "#10b981", strokeWidth: 2, dashed: false, opacity: 1, animated: false },
  failed: { stroke: "#ef4444", strokeWidth: 2, dashed: false, opacity: 1, animated: false },
  skipped: { stroke: "#d1d5db", strokeWidth: 2, dashed: true, opacity: 0.5, animated: false },
  cancelled: { stroke: "#d1d5db", strokeWidth: 2, dashed: true, opacity: 0.6, animated: false },
  paused: { stroke: "#8b5cf6", strokeWidth: 2, dashed: true, opacity: 0.8, animated: false },
  rejected: { stroke: "#ea580c", strokeWidth: 2, dashed: true, opacity: 0.8, animated: false },
  pending_approval: { stroke: "#f59e0b", strokeWidth: 2, dashed: true, opacity: 0.8, animated: false },
}

export function WorkflowStepEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  style,
  markerEnd,
}: EdgeProps) {
  const sourceStepStatus = (data?.sourceStepStatus as StepExecutionStatus) || "pending"
  const config = edgeStyleMap[sourceStepStatus] || edgeStyleMap.pending

  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 8,
  })

  return (
    <>
      {config.animated && (
        <style>{`
          @keyframes dash-flow {
            to { stroke-dashoffset: -12; }
          }
        `}</style>
      )}
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          ...style,
          stroke: config.stroke,
          strokeWidth: config.strokeWidth,
          strokeDasharray: config.dashed ? (config.animated ? "6,6" : "5,5") : "none",
          opacity: config.opacity,
          animation: config.animated ? "dash-flow 0.6s linear infinite" : undefined,
        }}
        markerEnd={markerEnd}
      />
    </>
  )
}