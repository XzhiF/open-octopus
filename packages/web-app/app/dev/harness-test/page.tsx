"use client"

import { ShieldCheck, Bot, CheckCircle2 } from "lucide-react"
import { HarnessFloatingPanel } from "@/components/workspace/harness-floating-panel"

const WORKSPACE_ID = "test-workspace-harness"
const EXECUTION_ID = "test-exec-harness-001"

/**
 * Render harness status indicators inline for DAG marker testing.
 * These mimic the HarnessStatusIndicator from execution-node.tsx
 * and HarnessBadge from type-shell.tsx.
 */
function HarnessMarkerSection() {
  return (
    <div data-testid="tc-dag-markers" className="p-4 space-y-3">
      <h2 className="text-lg font-bold">DAG Node Harness Markers</h2>

      <div data-testid="node-intervening" className="flex items-center gap-2 p-2 border rounded">
        <span className="font-medium text-sm">bash-build</span>
        <span title="Harness 正在干预" className="inline-flex items-center" data-testid="harness-marker-intervening">
          <ShieldCheck className="h-4 w-4 text-violet-500 animate-pulse" />
        </span>
      </div>

      <div data-testid="node-modified" className="flex items-center gap-2 p-2 border rounded">
        <span className="font-medium text-sm">python-test</span>
        <span title="Harness 已修改并重试" className="inline-flex items-center gap-0.5" data-testid="harness-marker-modified">
          <ShieldCheck className="h-4 w-4 text-violet-500" />
          <CheckCircle2 className="h-3 w-3 text-emerald-500" />
        </span>
      </div>

      <div data-testid="node-executed" className="flex items-center gap-2 p-2 border rounded">
        <span className="font-medium text-sm">agent-review</span>
        <span title="Harness Agent 接管执行" className="inline-flex items-center" data-testid="harness-marker-executed">
          <Bot className="h-4 w-4 text-rose-500" />
        </span>
      </div>

      <div data-testid="node-no-harness" className="flex items-center gap-2 p-2 border rounded">
        <span className="font-medium text-sm">bash-clean</span>
        {/* No harness marker — this node has no harnessStatus */}
      </div>
    </div>
  )
}

export default function HarnessTestPage() {
  return (
    <div className="min-h-screen bg-background">
      <h1 data-testid="harness-test-title" className="text-2xl font-bold p-4">
        Harness E2E Test Page
      </h1>

      {/* Section: Floating Panel (rendered in running state) */}
      <div data-testid="tc-floating-panel" className="relative min-h-[600px]">
        <HarnessFloatingPanel
          workspaceId={WORKSPACE_ID}
          executionId={EXECUTION_ID}
          executionStatus="running"
          currentNodeId="bash-build"
        />
      </div>

      {/* Section: DAG Markers */}
      <HarnessMarkerSection />
    </div>
  )
}
