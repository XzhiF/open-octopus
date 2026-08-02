"use client"

import type { Node, NodeProps } from "@xyflow/react"
import type { StatusOverlay } from "@/lib/types"
import { StatusShell } from "./status-shell"
import { TypeShell } from "./type-shell"
import { Badge } from "@/components/ui/badge"
import { MessageCircle } from "lucide-react"

interface WorkflowNodeData {
  id: string
  type: string
  name: string
  interaction_display?: string
  interaction_max_rounds?: number
  statusOverlay?: StatusOverlay
  isCurrent?: boolean
  isActive?: boolean
  [key: string]: unknown
}

type WorkflowNode = Node<WorkflowNodeData>

export function InteractionNode({ data, selected }: NodeProps<WorkflowNode>) {
  const display = data.interaction_display ?? "modal"

  return (
    <StatusShell nodeType="interaction" statusOverlay={data.statusOverlay} isCurrent={data.isCurrent} isActive={data.isActive} selected={selected}>
      <TypeShell nodeType="interaction" name={data.name} statusOverlay={data.statusOverlay}>
        <div className="flex items-center gap-1.5 mt-1">
          <MessageCircle className="h-3.5 w-3.5 text-purple-500" />
          <Badge variant="outline" className="text-xs text-purple-600 border-purple-200">
            {display === "panel" ? "Panel" : "Modal"}
          </Badge>
        </div>
        {data.interaction_max_rounds && (
          <span className="text-xs text-muted-foreground mt-0.5">
            Max: {data.interaction_max_rounds} rounds
          </span>
        )}
      </TypeShell>
    </StatusShell>
  )
}
