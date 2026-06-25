"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  ReactFlow,
  Background,
  type Node,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"

import { SwarmNode } from "@/components/swarm/organisms/swarm-node"
import { SwarmHeaderBar } from "@/components/swarm/molecules/swarm-header-bar"
import { ExpertListTab } from "@/components/swarm/organisms/expert-list-tab"
import { MessageTimelineTab } from "@/components/swarm/organisms/message-timeline-tab"
import { ConsensusChartTab } from "@/components/swarm/organisms/consensus-chart-tab"
import { InternalDagTab } from "@/components/swarm/organisms/internal-dag-tab"
import { HostReportTab } from "@/components/swarm/organisms/host-report-tab"
import { StatsDashboard } from "@/components/swarm/stats-dashboard"
import { Dialog } from "@/components/ui/dialog"
import { getServerUrl } from "@/lib/server-config"
import type { ExpertInfo, SwarmMessage, ConsensusDataPoint, TaskBreakdown } from "@/lib/swarm-types"

const nodeTypes = { swarm: SwarmNode }

const WORKSPACE_ID = "02adb9f4-4925-4eac-bfa5-3d78d214b540"

// Mock data
const mockExperts: ExpertInfo[] = [
  { role: "security-engineer", status: "completed", model: "sonnet", source: "predefined", tokensConsumed: 1500, inputTokens: 1200, outputTokens: 300, attempts: 1, output: "Security review complete" },
  { role: "backend-architect", status: "completed", model: "opus", source: "dynamic", tokensConsumed: 2200, inputTokens: 1800, outputTokens: 400, attempts: 1, output: "Architecture finalized" },
  { role: "code-reviewer", status: "running", model: "sonnet", source: "predefined", tokensConsumed: 800, inputTokens: 600, outputTokens: 200, attempts: 1 },
]

const mockMessages: SwarmMessage[] = [
  { from: "security-engineer", round: 1, content: "Identified 3 potential vulnerabilities", timestamp: Date.now() - 5000, tokens: 350 },
  { from: "backend-architect", round: 1, content: "Proposed microservices architecture", timestamp: Date.now() - 3000, tokens: 420 },
  { from: "security-engineer", round: 2, content: "All vulnerabilities addressed", timestamp: Date.now() - 1000, tokens: 280 },
]

const mockConsensus: ConsensusDataPoint[] = [
  { round: 1, score: 0.45, shouldContinue: true },
  { round: 2, score: 0.72, shouldContinue: true },
  { round: 3, score: 0.88, shouldContinue: true },
  { round: 4, score: 0.95, shouldContinue: false },
]

const mockTaskBreakdown: TaskBreakdown = {
  experts: [
    { role: "backend-architect", level: 0, dependsOn: [], subtask: "Design system architecture" },
    { role: "security-engineer", level: 1, dependsOn: ["backend-architect"], subtask: "Security review" },
    { role: "code-reviewer", level: 1, dependsOn: ["backend-architect"], subtask: "Code quality review" },
  ],
  dag: {
    levels: [["backend-architect"], ["security-engineer", "code-reviewer"]],
  },
}

const swarmNodeData = {
  id: "swarm-node-1",
  name: "Code Review Swarm",
  mode: "review" as const,
  status: "running" as const,
  expertCount: 3,
  consensusScore: 0.85,
  workspaceId: WORKSPACE_ID,
  executionId: "test-exec-1",
}

const swarmNodes: Node[] = [
  {
    id: "swarm-1",
    type: "swarm",
    position: { x: 100, y: 50 },
    data: swarmNodeData,
  },
]

function SseTestSection() {
  const [sseStatus, setSseStatus] = useState<string>("idle")
  const esRef = useRef<EventSource | null>(null)

  const connect = useCallback(() => {
    const serverUrl = getServerUrl()
    const es = new EventSource(
      `${serverUrl}/api/workspaces/${WORKSPACE_ID}/executions/events`
    )
    esRef.current = es
    es.onopen = () => setSseStatus("connected")
    es.onerror = () => setSseStatus("error")
    setTimeout(() => {
      es.close()
      setSseStatus(prev => prev === "connected" ? "connected-closed" : prev)
    }, 3000)
  }, [])

  useEffect(() => {
    connect()
    return () => { esRef.current?.close() }
  }, [connect])

  return (
    <div data-testid="sse-test" className="p-4 border rounded-md">
      <h3 className="text-sm font-medium mb-2">SSE Connection Test</h3>
      <p data-testid="sse-status" className="text-xs text-muted-foreground">
        Status: {sseStatus}
      </p>
    </div>
  )
}

/** Wrapper that provides Dialog context without rendering overlay/portal */
function DialogContextWrapper({ children }: { children: React.ReactNode }) {
  return (
    <Dialog open={true} modal={false}>
      {children}
    </Dialog>
  )
}

export default function SwarmTestPage() {
  return (
    <div className="min-h-screen p-6 space-y-8 bg-background">
      <h1 className="text-2xl font-bold" data-testid="swarm-test-title">Swarm Component Test Harness</h1>

      {/* TC-023: SwarmNode */}
      <section data-testid="tc-023-swarm-node" className="space-y-2">
        <h2 className="text-lg font-semibold">TC-023: SwarmNode</h2>
        <div className="h-[200px] border rounded-md">
          <ReactFlow
            nodes={swarmNodes}
            nodeTypes={nodeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background />
          </ReactFlow>
        </div>
      </section>

      {/* TC-024: SwarmDetailDialog tabs */}
      <section data-testid="tc-024-detail-dialog" className="space-y-4">
        <h2 className="text-lg font-semibold">TC-024: SwarmDetailDialog (5 tabs)</h2>

        {/* Header (needs Dialog context for DialogClose) */}
        <DialogContextWrapper>
          <div className="border rounded-md p-4" data-testid="swarm-header">
            <SwarmHeaderBar
              nodeName="Code Review Swarm"
              mode="review"
              status="running"
              expertCount={3}
              currentRound={2}
              consensusScore={0.85}
              budgetPercentage={45}
            />
          </div>
        </DialogContextWrapper>

        {/* ExpertListTab */}
        <div className="border rounded-md p-4" data-testid="expert-list">
          <h3 className="text-sm font-medium mb-2">Experts Tab</h3>
          <ExpertListTab experts={mockExperts} />
        </div>

        {/* MessageTimelineTab */}
        <div className="border rounded-md p-4" data-testid="message-timeline">
          <h3 className="text-sm font-medium mb-2">Messages Tab</h3>
          <MessageTimelineTab messages={mockMessages} />
        </div>

        {/* ConsensusChartTab */}
        <div className="border rounded-md p-4" data-testid="consensus-chart">
          <h3 className="text-sm font-medium mb-2">Consensus Tab</h3>
          <ConsensusChartTab data={mockConsensus} threshold={0.8} />
        </div>

        {/* InternalDagTab (contains DispatchDagNode) */}
        <div className="border rounded-md p-4 h-[450px]" data-testid="internal-dag">
          <h3 className="text-sm font-medium mb-2">DAG Tab</h3>
          <InternalDagTab taskBreakdown={mockTaskBreakdown} experts={mockExperts} />
        </div>

        {/* HostReportTab */}
        <div className="border rounded-md p-4" data-testid="host-report">
          <h3 className="text-sm font-medium mb-2">Report Tab</h3>
          <HostReportTab report="Synthesis: All experts agree on the recommended approach. Security review passed." hostDegraded={false} />
        </div>
      </section>

      {/* TC-025: useSwarmEvents SSE */}
      <section data-testid="tc-025-sse" className="space-y-2">
        <h2 className="text-lg font-semibold">TC-025: useSwarmEvents SSE</h2>
        <SseTestSection />
      </section>

      {/* TC-026: Replay mode */}
      <section data-testid="tc-026-replay" className="space-y-2">
        <h2 className="text-lg font-semibold">TC-026: Replay Mode</h2>
        <DialogContextWrapper>
          <div className="border rounded-md p-4" data-testid="replay-header">
            <SwarmHeaderBar
              nodeName="Completed Swarm"
              mode="debate"
              status="completed"
              expertCount={4}
              currentRound={3}
              consensusScore={0.92}
              isReplay={true}
            />
          </div>
        </DialogContextWrapper>
      </section>

      {/* TC-P1-005: StatsDashboard */}
      <section data-testid="tc-p1-005-stats" className="space-y-2">
        <h2 className="text-lg font-semibold">TC-P1-005: StatsDashboard</h2>
        <StatsDashboard workspaceId={WORKSPACE_ID} />
      </section>
    </div>
  )
}
