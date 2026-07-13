"use client"

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { LoopOverview } from "@/components/workspace/loop-overview"
import type { StepExecution, LoopIterationSummary } from "@/lib/types"

interface LoopDetailTabsProps {
  step?: StepExecution
  isRunning: boolean
  loopIterations?: LoopIterationSummary
}

export function LoopDetailTabs({ step, isRunning, loopIterations }: LoopDetailTabsProps) {
  return (
    <Tabs defaultValue="iterations">
      <TabsList className="w-full rounded-none h-8 bg-transparent border-b px-2">
        <TabsTrigger value="iterations" className="text-xs">迭代列表</TabsTrigger>
        <TabsTrigger value="exit" className="text-xs">退出条件</TabsTrigger>
        <TabsTrigger value="history" className="text-xs">历史</TabsTrigger>
      </TabsList>
      <TabsContent value="iterations" className="m-0 p-3">
        {loopIterations ? (
          <LoopOverview
            loopNodeId={step?.stepId ?? "unknown"}
            summary={loopIterations}
          />
        ) : (
          <div className="text-xs text-muted-foreground">
            {isRunning ? "等待迭代数据..." : "暂无迭代数据"}
          </div>
        )}
      </TabsContent>
      <TabsContent value="exit" className="m-0 p-3">
        <div className="text-xs text-muted-foreground">退出条件信息暂未在 StepExecution 中暴露</div>
      </TabsContent>
      <TabsContent value="history" className="m-0 p-3">
        <div className="text-xs text-muted-foreground">历史执行记录</div>
      </TabsContent>
    </Tabs>
  )
}
