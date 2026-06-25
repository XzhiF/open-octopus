"use client"

import type { Node, NodeProps } from "@xyflow/react"
import { Handle, Position } from "@xyflow/react"
import type { StatusOverlay } from "@/lib/types"
import { StatusShell } from "./status-shell"
import { TypeShell } from "./type-shell"
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

export function ConditionNode({ data, selected }: NodeProps<WorkflowNode>) {
  const caseHandles = (
    <>
      {data.cases?.map((caseItem, index) => (
        <Handle
          key={`case-${index}`}
          type="source"
          position={Position.Bottom}
          id={`case-${index}`}
          style={{
            left: `${(index + 1) * (100 / (data.cases!.length + 1))}%`,
            background: index === 0 ? "#10b981" : "#ef4444",
          }}
          className={cn("!w-3 !h-3 !border-2 !border-white")}
        />
      ))}
    </>
  )

  return (
    <StatusShell nodeType="condition" statusOverlay={data.statusOverlay} isCurrent={data.isCurrent} isActive={data.isActive} selected={selected} extraHandles={caseHandles}>
      <TypeShell nodeType="condition" name={data.name} statusOverlay={data.statusOverlay}>
        {data.cases?.map((caseItem, index) => (
          <div key={index} className="flex items-center gap-1 text-xs mt-1">
            <span
              className={cn(
                "inline-block w-2 h-2 rounded-full",
                index === 0 ? "bg-emerald-500" : "bg-red-500"
              )}
            />
            <span className="truncate text-muted-foreground">{caseItem.when}</span>
            <span className="text-muted-foreground/60">→ {caseItem.then}</span>
          </div>
        ))}
      </TypeShell>
    </StatusShell>
  )
}