"use client"

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import type { StepExecution } from "@/lib/types"

interface ConditionDetailTabsProps { step?: StepExecution; isRunning: boolean }

export function ConditionDetailTabs({ step, isRunning }: ConditionDetailTabsProps) {
  return (
    <Tabs defaultValue="expression">
      <TabsList className="w-full rounded-none h-8 bg-transparent border-b px-2">
        <TabsTrigger value="expression" className="text-xs">表达式</TabsTrigger>
        <TabsTrigger value="cases" className="text-xs">分支</TabsTrigger>
        <TabsTrigger value="snapshot" className="text-xs">变量快照</TabsTrigger>
        <TabsTrigger value="history" className="text-xs">历史</TabsTrigger>
      </TabsList>
      <TabsContent value="expression" className="m-0 p-3"><div className="text-xs text-muted-foreground">条件表达式</div></TabsContent>
      <TabsContent value="cases" className="m-0 p-3"><div className="text-xs text-muted-foreground">分支匹配情况</div></TabsContent>
      <TabsContent value="snapshot" className="m-0 p-3"><div className="text-xs text-muted-foreground">变量池快照</div></TabsContent>
      <TabsContent value="history" className="m-0 p-3"><div className="text-xs text-muted-foreground">历史执行记录</div></TabsContent>
    </Tabs>
  )
}
