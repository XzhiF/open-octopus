"use client"

import type { Node, NodeProps } from "@xyflow/react"
import type { StatusOverlay } from "@/lib/types"
import { StatusShell } from "./status-shell"
import { TypeShell } from "./type-shell"
import { Target } from "lucide-react"

interface WorkflowNodeData {
  id: string
  type: string
  name: string
  command?: string
  script?: string
  prompt?: string
  goal?: string
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
  // Goal-mode (task-dev develop etc.) has NO prompt — the middle used to render
  // blank. Show the goal condition excerpt instead, styled like the prompt but
  // with a target marker so the "goal" nature is visually distinct from a
  // prompt-function agent node.
  const hasGoal = !!data.goal?.trim()
  return (
    <StatusShell nodeType="agent" statusOverlay={data.statusOverlay} isCurrent={data.isCurrent} isActive={data.isActive} selected={selected}>
      <TypeShell nodeType="agent" name={data.name} statusOverlay={data.statusOverlay}>
        {!hasGoal && data.prompt && (
          <p className="text-xs text-muted-foreground line-clamp-2">{data.prompt}</p>
        )}
        {hasGoal && (
          <p className="text-xs text-muted-foreground line-clamp-2 flex items-start gap-1.5" title={data.goal}>
            <Target className="size-3.5 shrink-0 mt-px text-amber-500" />
            <span className="min-w-0 line-clamp-2">{data.goal}</span>
          </p>
        )}
      </TypeShell>
    </StatusShell>
  )
}
