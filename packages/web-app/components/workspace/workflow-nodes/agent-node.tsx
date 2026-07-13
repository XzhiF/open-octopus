"use client"

import type { Node, NodeProps } from "@xyflow/react"
import type { StatusOverlay, TokenUsage } from "@/lib/types"
import { formatTokenCount } from "@/lib/format"
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

function getTokenInfo(data: WorkflowNodeData): { model: string; inputTokens: number; outputTokens: number; extraModels: number } | null {
  const usages: TokenUsage[] = data.statusOverlay?.tokenUsages
    ?? (data.statusOverlay?.tokenUsage ? [data.statusOverlay.tokenUsage] : [])

  if (usages.length > 0) {
    const primary = usages[0]
    const totalInput = usages.reduce((sum, u) => sum + u.inputTokens, 0)
    const totalOutput = usages.reduce((sum, u) => sum + u.outputTokens, 0)
    return {
      model: primary.model || data.model || "",
      inputTokens: totalInput,
      outputTokens: totalOutput,
      extraModels: usages.length > 1 ? usages.length - 1 : 0,
    }
  }

  if (data.model) {
    return { model: data.model, inputTokens: 0, outputTokens: 0, extraModels: 0 }
  }

  return null
}

export function AgentNode({ data, selected }: NodeProps<WorkflowNode>) {
  const tokenInfo = getTokenInfo(data)

  return (
    <StatusShell nodeType="agent" statusOverlay={data.statusOverlay} isCurrent={data.isCurrent} isActive={data.isActive} selected={selected}>
      <TypeShell nodeType="agent" name={data.name} statusOverlay={data.statusOverlay}>
        {data.prompt && (
          <p className="text-xs text-muted-foreground line-clamp-2">{data.prompt}</p>
        )}
        {tokenInfo && (
          <div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
            {tokenInfo.model && (
              <span className="truncate max-w-[100px]" title={tokenInfo.model}>
                {tokenInfo.model}
                {tokenInfo.extraModels > 0 && ` +${tokenInfo.extraModels}`}
              </span>
            )}
            {(tokenInfo.inputTokens > 0 || tokenInfo.outputTokens > 0) && (
              <span className="whitespace-nowrap">
                ↑{formatTokenCount(tokenInfo.inputTokens)} ↓{formatTokenCount(tokenInfo.outputTokens)}
              </span>
            )}
          </div>
        )}
      </TypeShell>
    </StatusShell>
  )
}