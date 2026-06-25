"use client"

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import type { StepExecution } from "@/lib/types"

interface ApprovalDetailTabsProps { step?: StepExecution; isRunning: boolean }

export function ApprovalDetailTabs({ step, isRunning }: ApprovalDetailTabsProps) {
  return (
    <Tabs defaultValue="decision">
      <TabsList className="w-full rounded-none h-8 bg-transparent border-b px-2">
        <TabsTrigger value="decision" className="text-xs">决策</TabsTrigger>
        <TabsTrigger value="options" className="text-xs">选项</TabsTrigger>
        <TabsTrigger value="auto-answer" className="text-xs">Auto Answer</TabsTrigger>
        <TabsTrigger value="history" className="text-xs">历史</TabsTrigger>
      </TabsList>
      <TabsContent value="decision" className="m-0 p-3"><div className="text-xs text-muted-foreground">审批决策记录</div></TabsContent>
      <TabsContent value="options" className="m-0 p-3"><div className="text-xs text-muted-foreground">可选审批选项</div></TabsContent>
      <TabsContent value="auto-answer" className="m-0 p-3"><div className="text-xs text-muted-foreground">Auto Answer 配置</div></TabsContent>
      <TabsContent value="history" className="m-0 p-3"><div className="text-xs text-muted-foreground">历史审批记录</div></TabsContent>
    </Tabs>
  )
}
