"use client"

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { AgentTimeline } from "@/components/agent-timeline/agent-timeline"
import { CostLine } from "@/components/cost-line"
import { useAgentTraces } from "@/hooks/use-agent-traces"
import { useLLMCalls } from "@/hooks/use-llm-calls"

interface OctopusAgentDetailTabsProps {
  executionId: string
  nodeId: string
  agentName?: string
  version?: string
  taskBrief?: string
  workspaceId: string
  isRunning: boolean
}

export function OctopusAgentDetailTabs({
  executionId,
  nodeId,
  agentName,
  version,
  taskBrief,
  workspaceId,
  isRunning,
}: OctopusAgentDetailTabsProps) {
  const { turns, loading: tracesLoading, error: tracesError, isDegraded } = useAgentTraces(executionId, nodeId)
  const { calls, aggregates, loading: llmLoading } = useLLMCalls(executionId, nodeId)

  return (
    <Tabs defaultValue="traces">
      <TabsList className="w-full rounded-none h-8 bg-transparent border-b px-2">
        <TabsTrigger value="traces" className="text-xs">追踪</TabsTrigger>
        <TabsTrigger value="cost" className="text-xs">成本</TabsTrigger>
        <TabsTrigger value="info" className="text-xs">信息</TabsTrigger>
      </TabsList>

      <TabsContent value="traces" className="m-0 flex-1 overflow-auto max-h-[500px]">
        <AgentTimeline
          executionId={executionId}
          nodeId={nodeId}
          turns={turns}
          isRunning={isRunning}
          loading={tracesLoading}
          error={tracesError}
          isDegraded={isDegraded}
          llmAggregates={aggregates}
        />
      </TabsContent>

      <TabsContent value="cost" className="m-0 p-3">
        {aggregates.totalCalls > 0 ? (
          <div className="space-y-3">
            <CostLine costUsd={aggregates.totalCost} turns={aggregates.totalCalls} />
            {Object.entries(aggregates.modelBreakdown).map(([model, stats]) => (
              <div key={model} className="text-xs flex justify-between">
                <span className="text-muted-foreground">{model}</span>
                <span className="tabular-nums">{stats.calls} calls · ${stats.costUsd.toFixed(2)}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">暂无 LLM 调用数据</div>
        )}
      </TabsContent>

      <TabsContent value="info" className="m-0 p-3">
        <div className="space-y-3 text-xs">
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
            <span className="text-muted-foreground">Agent:</span>
            <span className="font-medium">{agentName ?? "—"}</span>

            <span className="text-muted-foreground">版本:</span>
            <span className="font-mono">{version ?? "—"}</span>
          </div>

          {taskBrief && (
            <div>
              <span className="text-muted-foreground block mb-1">任务描述:</span>
              <p className="bg-muted/30 rounded p-2 text-[11px] leading-relaxed">{taskBrief}</p>
            </div>
          )}
        </div>
      </TabsContent>
    </Tabs>
  )
}
