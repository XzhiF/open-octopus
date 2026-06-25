"use client"

import type { Node, NodeProps } from "@xyflow/react"
import type { StatusOverlay } from "@/lib/types"
import { StatusShell } from "./status-shell"
import { TypeShell } from "./type-shell"

interface WorkflowNodeData {
  id: string
  type: string
  name: string
  command?: string
  script?: string
  prompt?: string
  risk_level?: string
  iterations?: number
  loop_body?: Array<Record<string, unknown>>
  cases?: Array<{ when: string; then: string }>
  statusOverlay?: StatusOverlay
  isCurrent?: boolean
  isActive?: boolean
  [key: string]: unknown
}

type WorkflowNode = Node<WorkflowNodeData>

export function LoopNode({ data, selected }: NodeProps<WorkflowNode>) {
  return (
    <StatusShell nodeType="loop" statusOverlay={data.statusOverlay} isCurrent={data.isCurrent} isActive={data.isActive} selected={selected}>
      <TypeShell nodeType="loop" name={data.name} statusOverlay={data.statusOverlay}>
        {data.iterations && (
          <p className="text-xs text-muted-foreground">
            Iterations: {data.iterations}
          </p>
        )}
        {data.loop_body && data.loop_body.length > 0 && (
          <div className="mt-1 flex flex-col gap-1">
            {data.loop_body.map((step, index) => (
              <div key={index} className="text-xs text-muted-foreground/80 truncate">
                {index + 1}. {String(step.type ?? "step")}
              </div>
            ))}
          </div>
        )}
      </TypeShell>
    </StatusShell>
  )
}