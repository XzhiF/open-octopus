"use client"

import type { Node, NodeProps } from "@xyflow/react"
import type { StatusOverlay } from "@/lib/types"
import { StatusShell } from "./status-shell"
import { DagBranchHandle } from "./dag-handles"
import type { DagOrientation } from "@/lib/dag-orientation"
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
  dagOrientation?: DagOrientation
  isCurrent?: boolean
  isActive?: boolean
  [key: string]: unknown
}

type WorkflowNode = Node<WorkflowNodeData>

export function ConditionNode({ data, selected }: NodeProps<WorkflowNode>) {
  const cases = data.cases ?? []
  // 分支口沿垂直于流向的轴等分：主干 LR 时挂在右边上下铺开，
  // 容器体内 TB 时挂在底边左右铺开（见 DagBranchHandle）。
  const caseHandles = (
    <>
      {cases.map((caseItem, index) => (
        <DagBranchHandle
          key={`case-${index}`}
          id={`case-${index}`}
          index={index}
          total={cases.length}
          orientation={data.dagOrientation}
          style={{ background: index === 0 ? "var(--pop-green)" : "var(--pop-red)" }}
        />
      ))}
    </>
  )

  return (
    <StatusShell nodeType="condition" statusOverlay={data.statusOverlay} isCurrent={data.isCurrent} isActive={data.isActive} selected={selected} orientation={data.dagOrientation} extraHandles={caseHandles}>
      <TypeShell nodeType="condition" name={data.name} statusOverlay={data.statusOverlay}>
        {data.cases?.map((caseItem, index) => (
          <div key={index} className="flex items-center gap-1 text-xs mt-1">
            <span
              className={cn(
                "inline-block w-2 h-2 rounded-full",
                index === 0 ? "bg-pop-green" : "bg-pop-red"
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