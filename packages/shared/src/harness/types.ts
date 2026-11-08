// Harness signal types — shared across engine, server, and web-app.
//
// These are the *detector output* shapes. They survive the AI-native
// supervision redesign: detectors still produce DiagnosisReport facts, the
// RuntimeSupervisor turns them into Incidents. The old strategy / delegation /
// system-config types were retired with the Harness module.

/**
 * DiagnosisReport — Layer 1 output: what happened (facts only).
 */
export interface DiagnosisReport {
  id: string
  timestamp: number
  detector: string
  severity: "info" | "warning" | "critical"

  // Facts — what happened
  executionId: string
  nodeId: string
  /** Optional: the actual failing inner node ID (for loop containers). Used for UI display. */
  displayNodeId?: string
  nodeType: string // bash | python | agent | ...
  pattern: string // anomaly pattern identifier

  evidence: Array<{
    attempt?: number
    errorCode?: string
    errorMessage?: string
    errorHash?: string
    [key: string]: any
  }>

  context: {
    retryCount: number
    nodeDurationMs: number
    workflowProgress: number
    [key: string]: any
  }
}

/** Kept for the run-window event timeline types. */
export type InterventionAction =
  | { type: "inject_instruction"; message: string; nodeId?: string }
  | { type: "agent_takeover"; agentSessionId?: string }
  | { type: "modify_varpool"; key: string; value: any }
  | { type: "modify_definition"; field: string; value: any }
  | { type: "switch_model"; model: string; reason?: string }

/** Node status extension for supervision activity (DAG purple-ants UI). */
export type HarnessNodeStatus =
  | "harness_intervening"
  | "harness_modified"
  | "harness_executed"
  | "harness_blocked"

/**
 * HarnessSSEEvent — SSE event types emitted by the server.
 */
export type HarnessSSEEvent =
  | {
      event: "harness_diagnosis"
      data: { executionId: string; report: DiagnosisReport }
    }
  | {
      event: "harness_intervention"
      data: {
        executionId: string
        nodeId: string
        action: InterventionAction
        result: string
      }
    }
  | {
      event: "harness_delegation"
      data: {
        executionId: string
        nodeId: string
        agentSessionId: string
        status: string
      }
    }
  | {
      event: "harness_blocked"
      data: {
        executionId: string
        nodeId: string
        reason: string
        pattern: string
      }
    }

/** Row shape for harness_events (kept as the audit event log). */
export interface HarnessEvent {
  id: string
  execution_id: string
  node_id: string | null
  timestamp: number
  event_type: "diagnosis" | "intervention" | "delegation" | "blocked"
  detector: string | null
  severity: string | null
  report_json: string | null
  action_json: string | null
  result_json: string | null
  token_usage_json: string | null
  created_at: number
}
