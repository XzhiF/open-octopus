"use client"

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import type { StepExecution } from "@/lib/types"

interface LoopDetailTabsProps { step?: StepExecution; isRunning: boolean }

export function LoopDetailTabs({ step, isRunning }: LoopDetailTabsProps) {
  return (
    <Tabs defaultValue="iterations">
      <TabsList className="w-full rounded-none h-8 bg-transparent border-b px-2">
        <TabsTrigger value="iterations" className="text-xs">迭代列表</TabsTrigger>
        <TabsTrigger value="exit" className="text-xs">退出条件</TabsTrigger>
        <TabsTrigger value="history" className="text-xs">历史</TabsTrigger>
      </TabsList>
      <TabsContent value="iterations" className="m-0 p-3"><div className="text-xs text-muted-foreground">迭代执行记录</div></TabsContent>
      <TabsContent value="exit" className="m-0 p-3"><div className="text-xs text-muted-foreground">退出条件</div></TabsContent>
      <TabsContent value="history" className="m-0 p-3"><div className="text-xs text-muted-foreground">历史执行记录</div></TabsContent>
    </Tabs>
  )
}
