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

export function BashNode({ data, selected }: NodeProps<WorkflowNode>) {
  return (
    <StatusShell nodeType="bash" statusOverlay={data.statusOverlay} isCurrent={data.isCurrent} isActive={data.isActive} selected={selected}>
      <TypeShell nodeType="bash" name={data.name} statusOverlay={data.statusOverlay}>
        {data.command ? (
          <p className="text-xs text-muted-foreground font-mono truncate">{data.command}</p>
        ) : (
          <div className="h-6" />
        )}
      </TypeShell>
    </StatusShell>
  )
}