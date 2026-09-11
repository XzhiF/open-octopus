"use client"

import { Layers, Check, X, Circle, Loader2, ArrowUp, ArrowDown } from "lucide-react"
import type { NodeProps } from "@xyflow/react"
import { Handle, Position } from "@xyflow/react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { formatTokenCount } from "@/lib/format"
import type { StatusOverlay, TokenUsage, StepExecutionStatus } from "@/lib/types"

interface SubWorkflowContainerData {
  id: string
  type: string
  name: string
  workflow?: string
  execution_mode?: "inline" | "linked"
  input_mapping?: Record<string, string>
  output_mapping?: Record<string, string>
  on_error?: "fail" | "continue"
  statusOverlay?: StatusOverlay
  isCurrent?: boolean
  isActive?: boolean
  /** Child workflow node IDs (resolved from workflow YAML) */
  childNodeIds?: string[]
  /** True when type is dynamic_sub_workflow */
  is_dynamic?: boolean
  /** Name of generated workflow (from outputs) */
  generated_workflow?: string
  [key: string]: unknown
}

const statusBorderColor: Record<string, string> = {
  running: "border-pop-cyan",
  completed: "border-pop-green",
  failed: "border-pop-red",
  skipped: "border-pop-bd/40",
  cancelled: "border-pop-bd/40",
  paused: "border-pop-purple",
}

const statusBgColor: Record<string, string> = {
  running: "bg-pop-cyan-soft",
  completed: "bg-pop-green-soft",
  failed: "bg-pop-pink-soft",
  paused: "bg-pop-purple-soft",
}

const statusVisualConfig: Record<StepExecutionStatus, { color: string; label: string }> = {
  pending: { color: "text-pop-cyan", label: "待开始" },
  running: { color: "text-pop-ink", label: "运行中" },
  completed: { color: "text-pop-green", label: "已完成" },
  failed: { color: "text-pop-red", label: "失败" },
  skipped: { color: "text-pop-dim", label: "跳过" },
  cancelled: { color: "text-pop-dim", label: "已取消" },
  paused: { color: "text-pop-purple", label: "已暂停" },
  rejected: { color: "text-pop-ink", label: "已拒绝" },
  pending_approval: { color: "text-pop-ink", label: "待审批" },
}

function aggregateTokens(overlay?: StatusOverlay): { input: number; output: number } | null {
  if (!overlay) return null
  const usages: TokenUsage[] = overlay.tokenUsages ?? (overlay.tokenUsage ? [overlay.tokenUsage] : [])
  if (usages.length === 0) return null
  return usages.reduce(
    (acc, u) => ({
      input: acc.input + u.inputTokens,
      output: acc.output + u.outputTokens,
    }),
    { input: 0, output: 0 },
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

export function SubWorkflowContainerNode({ data, selected }: NodeProps) {
  const swData = data as unknown as SubWorkflowContainerData
  const stepStatus = swData.statusOverlay?.stepStatus
  const isHarnessActive = swData.statusOverlay?.harnessStatus === "harness_intervening"
    || swData.statusOverlay?.harnessStatus === "harness_modified"
    || swData.harnessStatus === "harness_intervening"
    || swData.harnessStatus === "harness_modified"
  const isDone = stepStatus === "completed" || stepStatus === "skipped" || stepStatus === "cancelled"
  const showMarchingAnts = !isDone && (stepStatus === "running" || isHarnessActive)
  const marchColor = (swData.statusOverlay?.harnessStatus === "harness_intervening"
    || swData.harnessStatus === "harness_intervening") ? "var(--pop-purple)" : "var(--pop-cyan)"
  const borderColor = stepStatus ? statusBorderColor[stepStatus] ?? "border-pop-bd/40" : "border-pop-purple/40"
  const headerBg = stepStatus ? statusBgColor[stepStatus] ?? "bg-pop-purple-soft" : "bg-pop-purple-soft"
  const tokens = aggregateTokens(swData.statusOverlay)
  const statusConfig = swData.statusOverlay ? statusVisualConfig[swData.statusOverlay.stepStatus] : null
  const execMode = swData.execution_mode ?? "inline"
  const isDynamic = swData.is_dynamic || swData.type === "dynamic_sub_workflow"
  const hasChildNodes = swData.childNodeIds && swData.childNodeIds.length > 0

  return (
    <>
      {showMarchingAnts && (
        <style>{`
          @keyframes border-march {
            to {
              background-position:
                -12px 0,
                -12px 100%,
                0 -12px,
                100% -12px;
            }
          }
          .border-running {
            border-color: transparent;
            background:
              repeating-linear-gradient(90deg, ${marchColor} 0 6px, transparent 6px 12px) top    / 100% 2px no-repeat,
              repeating-linear-gradient(90deg, ${marchColor} 0 6px, transparent 6px 12px) bottom / 100% 2px no-repeat,
              repeating-linear-gradient(0deg, ${marchColor} 0 6px, transparent 6px 12px) left   / 2px 100% no-repeat,
              repeating-linear-gradient(0deg, ${marchColor} 0 6px, transparent 6px 12px) right  / 2px 100% no-repeat;
            animation: border-march 0.6s linear infinite;
          }
        `}</style>
      )}
      <div
        className={cn(
          "border-2 border-dashed rounded-xl w-full h-full relative",
          borderColor,
          selected && "ring-2 ring-pop-pink ring-offset-2",
          showMarchingAnts && "border-running",
        )}
      >
        <Handle type="target" position={Position.Top} className="!bg-muted-foreground !w-3 !h-3" />
        {/* Header */}
        <div
          className={cn(
            "flex items-center gap-2 px-3 py-2 rounded-t-md border-b border-dashed border-inherit",
            headerBg,
          )}
        >
          <Layers className="w-4 h-4 text-pop-purple shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="text-sm font-medium truncate block">{swData.name}</span>
            {swData.workflow && (
              <span className="text-[11px] text-muted-foreground truncate block">
                → {swData.workflow}
              </span>
            )}
          </div>

          <Badge variant="outline" className="text-xs border-pop-purple/40 text-pop-purple bg-pop-purple-soft shrink-0">
            {execMode}
          </Badge>

          <Badge variant="outline" className="text-xs border-border text-muted-foreground bg-transparent shrink-0">
            子工作流
          </Badge>

          {isDynamic && (
            <Badge variant="outline" className="text-xs border-pop-amber/40 text-pop-ink bg-pop-amber-soft shrink-0">
              ⚡ Dynamic
            </Badge>
          )}

          {statusConfig && (
            <Badge variant="outline" className={cn("text-xs", statusConfig.color, "shrink-0")}>
              {statusConfig.label}
            </Badge>
          )}

          {tokens && <TokenSummary input={tokens.input} output={tokens.output} />}
        </div>

        {/* Body — child nodes rendered by flow-viewer, or show summary */}
        <div className="p-2 min-h-[60px]">
          {hasChildNodes ? (
            <div className="flex flex-wrap gap-1">
              {swData.childNodeIds!.map((childId) => (
                <Badge key={childId} variant="secondary" className="text-[10px] px-1.5 py-0">
                  {childId}
                </Badge>
              ))}
            </div>
          ) : isDynamic ? (
            <div className="flex items-center justify-center h-full text-xs text-pop-ink">
              ⚡ 运行时生成
            </div>
          ) : !swData.workflow ? (
            <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
              未指定子工作流
            </div>
          ) : null}
        </div>
        <Handle type="source" position={Position.Bottom} className="!bg-muted-foreground !w-3 !h-3" />
      </div>
    </>
  )
}
