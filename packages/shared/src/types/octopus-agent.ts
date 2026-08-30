// packages/shared/src/types/octopus-agent.ts
//
// Shared types for the octopus_agent workflow node type.
// Covers: version stages, task contracts, heartbeats, structured results,
// harness directives, and version metadata.
//

import type { NodeDef } from "./workflow"
import type { TokenUsage } from "./usage"

// ===== Version Stage =====

export type VersionStage = "alpha" | "beta" | "rc" | "stable"

// ===== Task Contract =====

export interface OutputSchema {
  type?: string
  schema?: Record<string, unknown>
}

export interface BudgetConfig {
  max_tokens?: number
  max_duration?: number
  max_cost_usd?: number
}

export interface TaskContract {
  brief: string
  context?: string[]
  constraints?: string[]
  expected_output?: OutputSchema
  sop?: string
  budget?: BudgetConfig
}

// ===== Harness =====

export interface HarnessConfig {
  heartbeat_interval?: number
  heartbeat_timeout?: number
  auto_abort_on_budget?: boolean
}

// ===== Node Definition =====

export interface OctopusAgentNodeDef extends NodeDef {
  type: "octopus_agent"
  agent: string
  version?: string
  min_stage?: VersionStage
  task: TaskContract
  harness?: HarnessConfig
}

// ===== Heartbeat =====

export interface AgentHeartbeat {
  step: number
  total_steps?: number
  tokens_used: number
  tokens_budget?: number
  artifacts: string[]
  issues: string[]
  confidence: number
  current_activity?: string
}

// ===== Structured Result =====

export type StructuredResultStatus =
  | "completed"
  | "failed"
  | "partial"
  | "aborted"
  | "budget_exceeded"

export interface Artifact {
  type: "code" | "file" | "text" | "data"
  path?: string
  content?: string
  description?: string
}

export interface StructuredResult {
  status: StructuredResultStatus
  output: Record<string, unknown>
  artifacts: Artifact[]
  vars_update?: Record<string, unknown>
  summary: string
  token_usage: TokenUsage
  duration_ms: number
}

// ===== Harness Directive =====

export type HarnessDirectiveType = "abort" | "pause" | "inject"

export interface HarnessDirective {
  type: HarnessDirectiveType
  reason: string
  issued_by: string
  timestamp?: number
  // inject-specific fields
  nodeId?: string
  message?: string
}

// ===== Version Info =====

export type AgentVersionStatus = "draft" | "published" | "archived"

export interface AgentVersionInfo {
  id: string
  agent_name: string
  version: string
  stage: VersionStage
  status: AgentVersionStatus
  snapshot: string
  changelog?: string
  published_at?: string
  created_at: string
}

// ===== Resolved Version (for VersionResolver) =====

export interface AgentSnapshot {
  persona: string
  config: Record<string, unknown>
  skills: string[]
}

export interface ResolvedVersion {
  version: string
  stage: VersionStage
  snapshot: AgentSnapshot
  fsPath: string
}
