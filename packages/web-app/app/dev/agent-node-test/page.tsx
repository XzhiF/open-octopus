"use client"

import {
  ReactFlow,
  Background,
  type Node,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"

import { OctopusAgentNode } from "@/components/workspace/workflow-nodes/octopus-agent-node"

const nodeTypes = { octopus_agent: OctopusAgentNode }

// ── Mock node: idle state ──────────────────────────────────────────

const idleNodeData = {
  id: "agent-1",
  type: "octopus_agent",
  name: "code-reviewer",
  agent: "code-reviewer",
  version: "1.2.0",
  task_brief: "Review the pull request for security issues and code quality.",
}

const idleNode: Node = {
  id: "agent-idle",
  type: "octopus_agent",
  position: { x: 50, y: 50 },
  data: idleNodeData,
}

// ── Mock node: running with heartbeat ──────────────────────────────

const runningNodeData = {
  id: "agent-2",
  type: "octopus_agent",
  name: "security-scanner",
  agent: "security-scanner",
  version: "2.0.0-beta.1",
  task_brief: "Scan codebase for OWASP Top 10 vulnerabilities.",
  statusOverlay: {
    stepStatus: "running" as const,
    startedAt: new Date(Date.now() - 30000).toISOString(),
    heartbeat: {
      step: 3,
      total_steps: 8,
      tokens_used: 12500,
      tokens_budget: 50000,
      artifacts: ["report.md", "findings.json"],
      issues: [],
      confidence: 0.82,
      current_activity: "Analyzing authentication module",
    },
  },
  isCurrent: true,
  isActive: true,
}

const runningNode: Node = {
  id: "agent-running",
  type: "octopus_agent",
  position: { x: 380, y: 50 },
  data: runningNodeData,
}

// ── Page ───────────────────────────────────────────────────────────

export default function AgentNodeTestPage() {
  return (
    <div className="min-h-screen p-6 space-y-8 bg-background">
      <h1 className="text-2xl font-bold" data-testid="agent-node-test-title">
        OctopusAgentNode Test Harness
      </h1>

      {/* AC5: OctopusAgentNode with rose color scheme (idle) */}
      <section data-testid="ac5-agent-node-idle" className="space-y-2">
        <h2 className="text-lg font-semibold">AC5: OctopusAgentNode (idle)</h2>
        <div className="h-[300px] border rounded-md" data-testid="agent-node-idle-container">
          <ReactFlow
            nodes={[idleNode]}
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

      {/* AC5b: OctopusAgentNode running with heartbeat */}
      <section data-testid="ac5b-agent-node-running" className="space-y-2">
        <h2 className="text-lg font-semibold">AC5b: OctopusAgentNode (running + heartbeat)</h2>
        <div className="h-[350px] border rounded-md" data-testid="agent-node-running-container">
          <ReactFlow
            nodes={[runningNode]}
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
    </div>
  )
}
