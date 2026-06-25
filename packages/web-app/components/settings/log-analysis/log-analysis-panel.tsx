"use client"

import { useSearchParams, useRouter } from "next/navigation"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useWorkspaces } from "@/hooks/use-workspaces"
import { OverviewTab } from "./overview-tab"
import { FailureTab } from "./failure-tab"
import { AnomalyTab } from "./anomaly-tab"
import { CostTab } from "./cost-tab"
import { Skeleton } from "@/components/ui/skeleton"

const tabItems = [
  { id: "overview", label: "概览" },
  { id: "failures", label: "失败分析" },
  { id: "anomalies", label: "异常检测" },
  { id: "cost", label: "成本分析" },
]

const tabTriggerClass =
  "data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:text-foreground data-[state=active]:font-medium data-[state=active]:border-primary border-b-2 border-transparent rounded-none px-3 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"

export function LogAnalysisPanel() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const activeTab = searchParams.get("tab") ?? "overview"
  const { workspaces, selectedId, setSelectedId, loading: wsLoading } = useWorkspaces()

  const handleTabChange = (value: string) => {
    const params = new URLSearchParams(searchParams.toString())
    params.set("tab", value)
    if (selectedId) params.set("workspace", selectedId)
    router.push(`/settings?${params.toString()}`, { scroll: false })
  }

  const handleWorkspaceChange = (wsId: string) => {
    setSelectedId(wsId)
    const params = new URLSearchParams(searchParams.toString())
    params.set("workspace", wsId)
    router.push(`/settings?${params.toString()}`, { scroll: false })
  }

  if (wsLoading) {
    return <Skeleton className="h-96" />
  }

  if (workspaces.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-border px-6 py-4 bg-background">
          <h1 className="text-lg font-semibold tracking-tight">日志分析</h1>
          <p className="text-sm text-muted-foreground">失败模式分析 · 异常检测 · 精准问题定位</p>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <p className="text-muted-foreground">暂无工作空间，请先创建一个工作空间。</p>
        </div>
      </div>
    )
  }

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange} className="flex flex-col h-full">
      {/* Tab bar + workspace selector */}
      <div className="flex items-center justify-between border-b border-border bg-background px-6 shrink-0">
        <TabsList className="bg-transparent border-0 h-auto p-0 gap-1">
          {tabItems.map(tab => (
            <TabsTrigger key={tab.id} value={tab.id} className={tabTriggerClass}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <Select value={selectedId} onValueChange={handleWorkspaceChange}>
          <SelectTrigger className="w-48 h-8">
            <SelectValue placeholder="选择工作空间" />
          </SelectTrigger>
          <SelectContent>
            {workspaces.map(ws => (
              <SelectItem key={ws.id} value={ws.id}>{ws.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Tab content — fills remaining space */}
      <div className="flex-1 overflow-auto">
        <TabsContent value="overview" forceMount className="data-[state=inactive]:hidden p-6">
          <OverviewTab workspaceId={selectedId} />
        </TabsContent>
        <TabsContent value="failures" forceMount className="data-[state=inactive]:hidden p-6">
          <FailureTab workspaceId={selectedId} />
        </TabsContent>
        <TabsContent value="anomalies" forceMount className="data-[state=inactive]:hidden p-6">
          <AnomalyTab workspaceId={selectedId} />
        </TabsContent>
        <TabsContent value="cost" forceMount className="data-[state=inactive]:hidden p-6">
          <CostTab workspaceId={selectedId} />
        </TabsContent>
      </div>
    </Tabs>
  )
}
