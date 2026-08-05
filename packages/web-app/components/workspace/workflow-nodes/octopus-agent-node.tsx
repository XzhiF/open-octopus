"use client"

import type { Node, NodeProps } from "@xyflow/react"
import type { StatusOverlay } from "@/lib/types"
import { StatusShell } from "./status-shell"
import { TypeShell } from "./type-shell"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Activity, Coins, FileOutput } from "lucide-react"

interface OctopusAgentNodeData {
  id: string
  type: string
  name: string
  agent?: string
  version?: string
  task_brief?: string
  statusOverlay?: StatusOverlay & {
    heartbeat?: {
      step: number
      total_steps?: number
      tokens_used: number
      tokens_budget?: number
      artifacts: string[]
      issues: string[]
      confidence: number
      current_activity?: string
    }
  }
  isCurrent?: boolean
  isActive?: boolean
  [key: string]: unknown
}

type OctopusAgentNode = Node<OctopusAgentNodeData>

export function OctopusAgentNode({ data, selected }: NodeProps<OctopusAgentNode>) {
  const heartbeat = data.statusOverlay?.heartbeat
  const isRunning = data.statusOverlay?.stepStatus === "running"

  return (
    <StatusShell
      nodeType="octopus_agent"
      statusOverlay={data.statusOverlay}
      isCurrent={data.isCurrent}
      isActive={data.isActive}
      selected={selected}
    >
      <TypeShell nodeType="octopus_agent" name={data.name} statusOverlay={data.statusOverlay}>
        <div className="space-y-2">
          {/* Agent + Version */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {data.agent && (
              <Badge variant="outline" className="text-xs font-mono">
                {data.agent}
              </Badge>
            )}
            {data.version && (
              <Badge variant="outline" className="text-xs text-muted-foreground">
                v{data.version}
              </Badge>
            )}
          </div>

          {/* Task brief */}
          {data.task_brief && (
            <p className="text-xs text-muted-foreground line-clamp-2">
              {data.task_brief}
            </p>
          )}

          {/* Heartbeat progress */}
          {isRunning && heartbeat && (
            <div className="space-y-1.5">
              {/* Step progress */}
              <div className="flex items-center gap-1.5 text-xs">
                <Activity className="h-3 w-3 text-rose-500" />
                <span className="tabular-nums text-rose-600 font-medium">
                  Step {heartbeat.step}
                  {heartbeat.total_steps ? ` / ${heartbeat.total_steps}` : ''}
                </span>
              </div>

              {/* Progress bar */}
              {heartbeat.total_steps != null && heartbeat.total_steps > 0 && (
                <Progress
                  value={(heartbeat.step / heartbeat.total_steps) * 100}
                  className="h-1"
                />
              )}

              {/* Token usage */}
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Coins className="h-3 w-3" />
                <span className="tabular-nums">
                  {heartbeat.tokens_used.toLocaleString()} tokens
                  {heartbeat.tokens_budget
                    ? ` / ${heartbeat.tokens_budget.toLocaleString()}`
                    : ''}
                </span>
              </div>

              {/* Current activity */}
              {heartbeat.current_activity && (
                <p className="text-xs text-muted-foreground/80 truncate italic">
                  {heartbeat.current_activity}
                </p>
              )}

              {/* Artifacts count */}
              {heartbeat.artifacts.length > 0 && (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <FileOutput className="h-3 w-3" />
                  <span>{heartbeat.artifacts.length} 产出物</span>
                </div>
              )}
            </div>
          )}
        </div>
      </TypeShell>
    </StatusShell>
  )
}
