"use client"

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import type { StepExecution } from "@/lib/types"
import { AgentTimeline } from "@/components/agent-timeline/agent-timeline"
import { CostLine } from "@/components/cost-line"
import { useAgentTraces } from "@/hooks/use-agent-traces"
import { useLLMCalls } from "@/hooks/use-llm-calls"

interface AgentDetailTabsProps {
  executionId: string
  nodeId: string
  step?: StepExecution
  workspaceId: string
  isRunning: boolean
}

export function AgentDetailTabs({ executionId, nodeId, step, workspaceId, isRunning }: AgentDetailTabsProps) {
  const { turns, loading: tracesLoading, error: tracesError, isDegraded } = useAgentTraces(executionId, nodeId)
  const { calls, aggregates, loading: llmLoading } = useLLMCalls(executionId, nodeId)

  return (
    <Tabs defaultValue="traces">
      <TabsList className="w-full rounded-none h-8 bg-transparent border-b px-2">
        <TabsTrigger value="traces" className="text-xs">追踪</TabsTrigger>
        <TabsTrigger value="cost" className="text-xs">成本</TabsTrigger>
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
    </Tabs>
  )
}
