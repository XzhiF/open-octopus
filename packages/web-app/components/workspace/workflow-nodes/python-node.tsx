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

export function PythonNode({ data, selected }: NodeProps<WorkflowNode>) {
  return (
    <StatusShell nodeType="python" statusOverlay={data.statusOverlay} isCurrent={data.isCurrent} isActive={data.isActive} selected={selected}>
      <TypeShell nodeType="python" name={data.name} statusOverlay={data.statusOverlay}>
        {data.script && (
          <p className="text-xs text-muted-foreground font-mono truncate">{data.script}</p>
        )}
      </TypeShell>
    </StatusShell>
  )
}