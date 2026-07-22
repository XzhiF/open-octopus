// packages/shared/src/types/repair.ts
// Repair mechanism type definitions — DiagnoseReport + operation request/response types.

import { z } from "zod"
import type { ExecutionStatus, NodeExecutionStatus, NodeType } from "./workspace"

// ── Diagnose Report ───────────────────────────────────────────────

export interface DiagnoseReport {
  execution: {
    id: string
    status: ExecutionStatus
    workflowRef: string
    startedAt: string
    duration: number
    retryCount: number
    resumeAttempts: number
  }
  nodes: DiagnoseNodeReport[]
  varPool: Record<string, unknown>
  anomalies: Anomaly[]
  checkpoints: CheckpointSummary[]
  recentErrors: RecentError[]
}

export interface DiagnoseNodeReport {
  nodeId: string
  nodeType: NodeType
  status: NodeExecutionStatus
  duration: number
  retryCount: number
  error?: string
  lastOutput?: string
  eventCount: number
  recentEvents: Array<{ type: string; content: string; timestamp: string }>
}

export interface Anomaly {
  type:
    | "stuck_node"
    | "exhausted_retry"
    | "false_completion"
    | "infinite_retry"
    | "orphaned_node"
    | "pending_hooks"
  nodeId?: string
  description: string
  severity: "critical" | "warning" | "info"
  suggestion: string
}

export interface CheckpointSummary {
  id: string
  timestamp: string
  completedNodes: string[]
  size: number
}

export interface RecentError {
  timestamp: string
  nodeId?: string
  error: string
  category: string
}

// ── Repair Operation Request/Response ─────────────────────────────

export interface VarPoolUpdateRequest {
  updates: Record<string, unknown>
}

export interface VarPoolUpdateResponse {
  updated: number
  snapshot: Record<string, unknown>
}

export interface NodeResetRequest {
  status: "pending" | "completed"
  outputs?: Record<string, unknown>
}

export interface NodeResetResponse {
  nodeId: string
  previousStatus: string
  newStatus: string
}

export interface RestorePointRequest {
  nodeId: string
  resetVarPool?: boolean
}

export interface RestorePointResponse {
  resetNodes: string[]
  restoredFrom: string
}

export interface ReloadWorkflowRequest {
  content: string
}

export interface ReloadWorkflowResponse {
  reloaded: boolean
  diff: string[]
}

export interface InterveneRequest {
  nodeId: string
  message: string
}

export interface InterveneResponse {
  injected: boolean
}

export interface ClearRetryRequest {
  nodeIds?: string[]
}

export interface ClearRetryResponse {
  cleared: string[]
}

// ── Zod Schemas for input validation ──────────────────────────────

export const VarPoolUpdateRequestSchema = z.object({
  updates: z.record(z.string(), z.unknown()),
})

export const NodeResetRequestSchema = z.object({
  status: z.enum(["pending", "completed"]),
  outputs: z.record(z.string(), z.unknown()).optional(),
})

export const RestorePointRequestSchema = z.object({
  nodeId: z.string(),
  resetVarPool: z.boolean().optional(),
})

export const ReloadWorkflowRequestSchema = z.object({
  content: z.string(),
})

export const InterveneRequestSchema = z.object({
  nodeId: z.string(),
  message: z.string(),
})

export const ClearRetryRequestSchema = z.object({
  nodeIds: z.array(z.string()).optional(),
})
