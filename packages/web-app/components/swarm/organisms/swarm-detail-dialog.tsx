"use client"

import { useState, useCallback } from "react"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { useSwarmEvents } from "@/hooks/use-swarm-events"
import { SwarmHeaderBar } from "../molecules/swarm-header-bar"
import { ExpertListTab } from "./expert-list-tab"
import { MessageTimelineTab } from "./message-timeline-tab"
import { ConsensusChartTab } from "./consensus-chart-tab"
import { InternalDagTab } from "./internal-dag-tab"
import { HostReportTab } from "./host-report-tab"
import { MoaResultTab } from "./moa-result-tab"
import { SwarmDialogSkeleton } from "./swarm-dialog-skeleton"
import { AlertBanner } from "../atoms/alert-banner"
import { Users, MessageSquare, TrendingUp, GitBranch, FileText, Sparkles } from "lucide-react"
import { cn } from "@/lib/utils"

export interface SwarmDetailDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  nodeId: string | null
  executionId?: string
  workspaceId: string
  nodeName?: string
  isReplay?: boolean
}

export function SwarmDetailDialog({
  open,
  onOpenChange,
  nodeId,
  executionId,
  workspaceId,
  nodeName = "Swarm 执行",
  isReplay = false,
}: SwarmDetailDialogProps) {
  const [activeTab, setActiveTab] = useState("experts")
  const [highlightedRole, setHighlightedRole] = useState<string | null>(null)

  const {
    status,
    mode,
    experts,
    messages,
    consensusHistory,
    currentRound,
    totalExperts,
    routerDecision,
    taskBreakdown,
    hostReport,
    hostDegraded,
    finalResult,
    budgetExhausted,
    timeoutExceeded,
    moaExpertResults,
    aggregatorStatus,
    aggregatorRound,
    aggregatorTotalRounds,
    aggregatorModel,
    aggregatorInputExpertCount,
  } = useSwarmEvents(workspaceId, open ? nodeId : null, open ? executionId : undefined)

  const consensusScore = finalResult?.consensus_score ?? (
    consensusHistory.length > 0 ? consensusHistory[consensusHistory.length - 1].score : null
  )

  const handleDagNodeClick = useCallback((role: string) => {
    setHighlightedRole(role)
    setActiveTab("experts")
  }, [])

  const showConsensusTab = mode === "debate" || mode === "swarm"
  const showDagTab = mode === "dispatch"
  const showMoaTab = mode === "moa"

  const tabCount = 3 + (showConsensusTab ? 1 : 0) + (showDagTab ? 1 : 0) + (showMoaTab ? 1 : 0)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[1024px] max-w-[90vw] sm:max-w-[1024px] h-[85vh] flex flex-col overflow-hidden p-0"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Swarm 详情</DialogTitle>
        <DialogDescription className="sr-only">
          查看 Swarm 执行的详细信息，包括专家列表、消息时间线、共识趋势和 Host 报告。
        </DialogDescription>

        {/* Fixed header area */}
        <div className="shrink-0 px-6 pt-6">
          <SwarmHeaderBar
            nodeName={nodeName}
            mode={mode}
            status={status}
            expertCount={totalExperts || experts.length}
            currentRound={currentRound}
            consensusScore={consensusScore}
            isReplay={isReplay}
          />

          {budgetExhausted && (
            <AlertBanner type="error" message="Token 预算已耗尽" dismissible />
          )}
          {timeoutExceeded && (
            <AlertBanner type="warning" message="执行超时" dismissible />
          )}
        </div>

        {/* Tabs — flex-1 fills remaining height, content scrolls internally */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0 px-6 pb-6">
          <TabsList className={cn("shrink-0", tabCount > 4 ? "grid grid-cols-5" : tabCount > 3 ? "grid grid-cols-4" : "")}>
            <TabsTrigger value="experts" className="gap-1">
              <Users className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">专家</span>
            </TabsTrigger>
            <TabsTrigger value="messages" className="gap-1">
              <MessageSquare className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">消息</span>
            </TabsTrigger>
            {showConsensusTab && (
              <TabsTrigger value="consensus" className="gap-1">
                <TrendingUp className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">共识</span>
              </TabsTrigger>
            )}
            {showDagTab && (
              <TabsTrigger value="dag" className="gap-1">
                <GitBranch className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">DAG</span>
              </TabsTrigger>
            )}
            {showMoaTab && (
              <TabsTrigger value="moa" className="gap-1">
                <Sparkles className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">MOA</span>
              </TabsTrigger>
            )}
            <TabsTrigger value="report" className="gap-1">
              <FileText className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">报告</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="experts" className="mt-3 flex-1 overflow-y-auto min-h-0">
            <ExpertListTab
              experts={experts}
              routerDecision={routerDecision}
              highlightedRole={highlightedRole}
              onHighlightClear={() => setHighlightedRole(null)}
            />
          </TabsContent>

          <TabsContent value="messages" className="mt-3 flex-1 overflow-y-auto min-h-0">
            <MessageTimelineTab messages={messages} />
          </TabsContent>

          {showConsensusTab && (
            <TabsContent value="consensus" className="mt-3 flex-1 overflow-y-auto min-h-0">
              <ConsensusChartTab data={consensusHistory} />
            </TabsContent>
          )}

          {showDagTab && (
            <TabsContent value="dag" className="mt-3 flex-1 overflow-y-auto min-h-0">
              <InternalDagTab
                taskBreakdown={taskBreakdown}
                experts={experts}
                onNodeClick={handleDagNodeClick}
              />
            </TabsContent>
          )}

          {showMoaTab && (
            <TabsContent value="moa" className="mt-3 flex-1 overflow-y-auto min-h-0">
              <MoaResultTab
                status={status}
                experts={experts}
                moaExpertResults={moaExpertResults}
                aggregatorStatus={aggregatorStatus}
                aggregatorRound={aggregatorRound}
                aggregatorTotalRounds={aggregatorTotalRounds}
                aggregatorModel={aggregatorModel}
                aggregatorInputExpertCount={aggregatorInputExpertCount}
                hostReport={hostReport}
              />
            </TabsContent>
          )}

          <TabsContent value="report" className="mt-3 flex-1 overflow-y-auto min-h-0">
            <HostReportTab report={hostReport} hostDegraded={hostDegraded} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
