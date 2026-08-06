// Harness types — shared across engine, server, and web-app
//
// Note: HarnessDirective is defined in types/octopus-agent.ts (extended with "inject").
// The per-node HarnessConfig (heartbeat/budget) is also in types/octopus-agent.ts.
// This file defines the *system-level* harness configuration types.

/**
 * DiagnosisReport — Layer 1 output: what happened (facts only)
 */
export interface DiagnosisReport {
  id: string
  timestamp: number
  detector: string
  severity: "info" | "warning" | "critical"

  // Facts — what happened
  executionId: string
  nodeId: string
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

/**
 * InterventionAction — what harness can do to fix a problem
 */
export type InterventionAction =
  | { type: "inject_instruction"; message: string; nodeId?: string }
  | { type: "agent_takeover"; agentSessionId?: string }
  | { type: "modify_varpool"; key: string; value: any }
  | { type: "modify_definition"; field: string; value: any }
  | { type: "switch_model"; model: string; reason?: string }

/**
 * NodeStatus extension for harness states.
 * These augment the existing NodeStatus union from the engine.
 */
export type HarnessNodeStatus =
  | "harness_intervening" // harness is analyzing and executing intervention
  | "harness_modified" // harness modified script/vars/definition, will retry
  | "harness_executed" // harness agent takeover completed
  | "harness_blocked" // harness blocked this node (process conflict)

/**
 * HarnessSSEEvent — SSE event types emitted by the server
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

/**
 * HarnessSystemConfig — top-level system configuration (parsed from harness.yaml).
 * Distinct from the per-node HarnessConfig in types/octopus-agent.ts.
 */
export interface HarnessSystemConfig {
  detectors: Record<string, DetectorConfig>
  strategies: StrategyConfig[]
  isolation: IsolationConfig
}

export interface DetectorConfig {
  enabled: boolean
  threshold?: number
  [key: string]: any
}

export interface StrategyConfig {
  match: string
  severity?: "info" | "warning" | "critical"
  actions: StrategyAction[]
  delegate_to_agent?: boolean
}

export interface StrategyAction {
  type: string
  message?: string
  prefer?: string
  reason?: string
  notify?: boolean
  [key: string]: any
}

export interface IsolationConfig {
  process_group: boolean
  port_protection: boolean
  pid_protection: boolean
  sandbox: "auto" | "seatbelt" | "bubblewrap" | "wrapper" | "disabled"
  fs_whitelist: string[]
}

/**
 * HarnessEvent — row shape for harness_events table
 */
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
