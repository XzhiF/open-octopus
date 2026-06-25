"use client"

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import type { StepExecution } from "@/lib/types"

interface BashDetailTabsProps {
  step?: StepExecution
  isRunning: boolean
}

export function BashDetailTabs({ step, isRunning }: BashDetailTabsProps) {
  return (
    <Tabs defaultValue="output">
      <TabsList className="w-full rounded-none h-8 bg-transparent border-b px-2">
        <TabsTrigger value="output" className="text-xs">输出</TabsTrigger>
        <TabsTrigger value="env" className="text-xs">环境</TabsTrigger>
        <TabsTrigger value="history" className="text-xs">历史</TabsTrigger>
      </TabsList>
      <TabsContent value="output" className="m-0 p-3">
        {step?.output ? (
          <pre className="text-xs bg-muted rounded p-3 overflow-auto max-h-64">{step.output}</pre>
        ) : (
          <div className="text-xs text-muted-foreground">暂无输出</div>
        )}
      </TabsContent>
      <TabsContent value="env" className="m-0 p-3">
        <div className="text-xs text-muted-foreground">环境变量 / Git 状态</div>
      </TabsContent>
      <TabsContent value="history" className="m-0 p-3">
        <div className="text-xs text-muted-foreground">历史执行记录</div>
      </TabsContent>
    </Tabs>
  )
}
