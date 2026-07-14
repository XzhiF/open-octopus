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
  model?: string
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

export function AgentNode({ data, selected }: NodeProps<WorkflowNode>) {
  return (
    <StatusShell nodeType="agent" statusOverlay={data.statusOverlay} isCurrent={data.isCurrent} isActive={data.isActive} selected={selected}>
      <TypeShell nodeType="agent" name={data.name} statusOverlay={data.statusOverlay}>
        {data.prompt && (
          <p className="text-xs text-muted-foreground line-clamp-2">{data.prompt}</p>
        )}
      </TypeShell>
    </StatusShell>
  )
}
