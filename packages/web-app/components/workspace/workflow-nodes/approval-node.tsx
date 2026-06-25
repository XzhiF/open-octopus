"use client"

import type { Node, NodeProps } from "@xyflow/react"
import type { StatusOverlay } from "@/lib/types"
import { StatusShell } from "./status-shell"
import { TypeShell } from "./type-shell"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

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

const riskColors: Record<string, { color: string }> = {
  "read-only": { color: "text-blue-600" },
  "write": { color: "text-amber-600" },
  "destructive": { color: "text-red-600" },
}

export function ApprovalNode({ data, selected }: NodeProps<WorkflowNode>) {
  const riskConfig = riskColors[data.risk_level || "write"]

  return (
    <StatusShell nodeType="approval" statusOverlay={data.statusOverlay} isCurrent={data.isCurrent} isActive={data.isActive} selected={selected}>
      <TypeShell nodeType="approval" name={data.name} statusOverlay={data.statusOverlay}>
        {data.risk_level && (
          <Badge variant="outline" className={cn("text-xs mt-1", riskConfig?.color)}>
            Risk: {data.risk_level}
          </Badge>
        )}
      </TypeShell>
    </StatusShell>
  )
}