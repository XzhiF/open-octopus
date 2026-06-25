"use client"

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import type { StepExecution } from "@/lib/types"

interface PythonDetailTabsProps {
  step?: StepExecution
  isRunning: boolean
}

export function PythonDetailTabs({ step, isRunning }: PythonDetailTabsProps) {
  return (
    <Tabs defaultValue="output">
      <TabsList className="w-full rounded-none h-8 bg-transparent border-b px-2">
        <TabsTrigger value="output" className="text-xs">输出</TabsTrigger>
        <TabsTrigger value="script" className="text-xs">脚本</TabsTrigger>
        <TabsTrigger value="traceback" className="text-xs">Traceback</TabsTrigger>
        <TabsTrigger value="history" className="text-xs">历史</TabsTrigger>
      </TabsList>
      <TabsContent value="output" className="m-0 p-3">
        {step?.output ? <pre className="text-xs bg-muted rounded p-3 overflow-auto max-h-64">{step.output}</pre> : <div className="text-xs text-muted-foreground">暂无输出</div>}
      </TabsContent>
      <TabsContent value="script" className="m-0 p-3"><div className="text-xs text-muted-foreground">脚本内容</div></TabsContent>
      <TabsContent value="traceback" className="m-0 p-3">
        {step?.error ? <pre className="text-xs text-red-600 bg-red-50 dark:bg-red-950 rounded p-3">{step.error}</pre> : <div className="text-xs text-muted-foreground">无错误</div>}
      </TabsContent>
      <TabsContent value="history" className="m-0 p-3"><div className="text-xs text-muted-foreground">历史执行记录</div></TabsContent>
    </Tabs>
  )
}
