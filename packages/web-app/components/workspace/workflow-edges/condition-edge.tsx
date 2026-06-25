"use client"

import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from "@xyflow/react"
import { cn } from "@/lib/utils"

export function ConditionEdge({
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
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 8,
  })

  const labelText = data?.label as string | undefined

  const isSuccess = labelText?.includes("success") || labelText?.includes("== 0")
  const isFailure = labelText?.includes("failed") || labelText?.includes("!= 0")

  const edgeColor = isSuccess
    ? "#10b981"
    : isFailure
      ? "#ef4444"
      : "#f59e0b"

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          ...style,
          stroke: edgeColor,
          strokeWidth: 2,
        }}
        markerEnd={markerEnd}
      />
      {labelText && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              fontSize: 11,
              fontWeight: 500,
              color: edgeColor,
              background: "#fff",
              padding: "4px 8px",
              borderRadius: 4,
              pointerEvents: "all",
            }}
            className="nodrag nopan"
          >
            {labelText}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}