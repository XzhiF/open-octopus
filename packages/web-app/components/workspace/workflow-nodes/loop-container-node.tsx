"use client"

import { Repeat, Check, X, Circle, Loader2, ArrowUp, ArrowDown } from "lucide-react"
import type { NodeProps } from "@xyflow/react"
import { cn } from "@/lib/utils"
import { formatTokenCount } from "@/lib/format"
import type { LoopIterationSummary, StatusOverlay, TokenUsage } from "@/lib/types"

interface LoopContainerData {
  id: string
  type: string
  name: string
  iterations?: number
  max_iterations?: number
  innerNodeIds?: string[]
  loopIterations?: LoopIterationSummary
  statusOverlay?: StatusOverlay
  isCurrent?: boolean
  isActive?: boolean
  [key: string]: unknown
}

const statusBorderColor: Record<string, string> = {
  running: "border-blue-400",
  completed: "border-green-400",
  failed: "border-red-400",
  skipped: "border-gray-300",
  cancelled: "border-gray-300",
  paused: "border-violet-400",
}

const statusBgColor: Record<string, string> = {
  running: "bg-blue-50/80",
  completed: "bg-green-50/80",
  failed: "bg-red-50/80",
  paused: "bg-violet-50/80",
}

function aggregateTokens(overlay?: StatusOverlay): { input: number; output: number } | null {
  if (!overlay) return null
  const usages: TokenUsage[] = overlay.tokenUsages ?? (overlay.tokenUsage ? [overlay.tokenUsage] : [])
  if (usages.length === 0) return null
  return usages.reduce(
    (acc, u) => ({
      input: acc.input + u.inputTokens + (u.cacheReadTokens ?? 0),
      output: acc.output + u.outputTokens + (u.cacheCreationTokens ?? 0),
    }),
    { input: 0, output: 0 },
  )
}

function IterationDots({ summary }: { summary: LoopIterationSummary }) {
  const { iterations } = summary

  if (iterations.length === 0) return null

  return (
    <div className="flex items-center gap-1">
      {iterations.map((it) => {
        switch (it.status) {
          case "completed":
            return (
              <Check key={it.iteration} className="w-3.5 h-3.5 text-green-500" />
            )
          case "failed":
            return (
              <X key={it.iteration} className="w-3.5 h-3.5 text-red-500" />
            )
          case "running":
            return (
              <Loader2 key={it.iteration} className="w-3.5 h-3.5 text-blue-500 animate-spin" />
            )
          default:
            return (
              <Circle key={it.iteration} className="w-3.5 h-3.5 text-gray-300" />
            )
        }
      })}
    </div>
  )
}

function TokenSummary({ input, output }: { input: number; output: number }) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground tabular-nums">
      <span className="flex items-center gap-0.5">
        <ArrowUp className="w-3 h-3" />
        {formatTokenCount(input)}
      </span>
      <span className="flex items-center gap-0.5">
        <ArrowDown className="w-3 h-3" />
        {formatTokenCount(output)}
      </span>
    </div>
  )
}

export function LoopContainerNode({ data, selected }: NodeProps) {
  const loopData = data as unknown as LoopContainerData
  const stepStatus = loopData.statusOverlay?.stepStatus
  const borderColor = stepStatus ? statusBorderColor[stepStatus] ?? "border-gray-300" : "border-gray-300"
  const headerBg = stepStatus ? statusBgColor[stepStatus] ?? "bg-gray-50/80" : "bg-gray-50/80"
  const tokens = aggregateTokens(loopData.statusOverlay)
  const maxIter = loopData.max_iterations ?? loopData.iterations

  return (
    <div
      className={cn(
        "border-2 border-dashed rounded-lg w-full h-full",
        borderColor,
        selected && "ring-2 ring-primary ring-offset-2",
      )}
    >
      {/* Header */}
      <div
        className={cn(
          "flex items-center gap-2 px-3 py-2 rounded-t-md border-b border-dashed border-inherit",
          headerBg,
        )}
      >
        <Repeat className="w-4 h-4 text-orange-500 shrink-0" />
        <span className="text-sm font-medium truncate">{loopData.name}</span>

        {maxIter != null && (
          <span className="text-[11px] text-muted-foreground shrink-0">
            /{maxIter}
          </span>
        )}

        {loopData.loopIterations && (
          <IterationDots summary={loopData.loopIterations} />
        )}

        <div className="flex-1" />

        {tokens && <TokenSummary input={tokens.input} output={tokens.output} />}
      </div>

      {/* Body — React Flow renders child nodes here via parentId */}
      <div className="p-2 min-h-[80px]" />
    </div>
  )
}
