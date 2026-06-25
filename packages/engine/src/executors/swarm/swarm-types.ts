// Runtime types for the Swarm execution engine

export interface Message {
  from: string        // role name
  to: string          // role name or "*" for broadcast
  round: number
  content: string
  timestamp: number
  metadata?: Record<string, unknown>
}

export interface SwarmResult {
  synthesis: string
  consensus_score: number | null
  rounds_used: number
  expert_count: number
  experts: ExpertResult[]
  history: Message[]
  task_breakdown?: TaskBreakdown
  router_decision?: RouterDecision
  budget_exhausted: boolean
  timeout_exceeded: boolean
  context_overflow: boolean
  host_degraded: boolean
  failed_experts: string[]
  skipped_experts: string[]
  file_conflicts: FileConflict[]
  status: "completed" | "failed" | "budget_exhausted" | "timeout_exceeded"
}

export interface ExpertResult {
  role: string
  status: "completed" | "failed" | "skipped" | "budget_exceeded"
  output: string
  rounds: number
  tools_used: string[]
  files_changed: string[]
  source: "predefined" | "dynamic"
  attempts: number
  error?: string
}

export interface TaskBreakdown {
  topic: string
  mode: string
  dag?: {
    levels: string[][]
  }
  experts: Array<{ role: string; task: string; reasoning?: string }>
}

export interface RouterDecision {
  mode: "review" | "debate" | "dispatch"
  mode_reasoning: string
  experts: Array<{
    role: string
    match_reasoning: string
    match_score: number
  }>
  alternatives_considered: string[]
}

export interface FileConflict {
  file: string
  experts: string[]
  resolution: "last_write_wins" | "manual"
}

export interface HostOutput {
  synthesis: string
  assessment?: {
    consensus_score: number
    key_agreements: string[]
    key_disagreements: string[]
    should_continue: boolean
    confidence: number
  }
}

export interface BudgetStatus {
  status: "ok" | "warning" | "exhausted"
  consumed: number
  limit: number | null
  percentage: number
}

// SSE event types (shared between frontend and backend)
export interface ExpertSpawnEvent {
  nodeId: string
  role: string
  model: string
  source: "predefined" | "dynamic"
}

export interface ExpertMessageEvent {
  nodeId: string
  role: string
  round: number
  content: string
  tokens: number
}

export interface ExpertCompleteEvent {
  nodeId: string
  role: string
  model?: string
  status: "completed" | "failed" | "skipped" | "budget_exceeded"
  output: string
  tokens: number
  inputTokens: number
  outputTokens: number
}

export interface ConsensusCheckEvent {
  nodeId: string
  round: number
  score: number
  shouldContinue: boolean
}

export interface SwarmRoundEndEvent {
  nodeId: string
  round: number
  expertCount: number
}

export interface SwarmCompleteEvent {
  nodeId: string
  mode?: string
  status: "completed" | "failed" | "budget_exhausted" | "timeout_exhausted"
  synthesis: string
  result: {
    consensus_score: number | null
    rounds_used: number
    expert_count: number
    budget_exhausted: boolean
    timeout_exceeded: boolean
    host_degraded: boolean
    failed_experts: string[]
    skipped_experts: string[]
  }
}

export type SwarmSSEEvent =
  | { type: "expert_spawn"; data: ExpertSpawnEvent }
  | { type: "expert_message"; data: ExpertMessageEvent }
  | { type: "expert_complete"; data: ExpertCompleteEvent }
  | { type: "consensus_check"; data: ConsensusCheckEvent }
  | { type: "swarm_round_end"; data: SwarmRoundEndEvent }
  | { type: "swarm_complete"; data: SwarmCompleteEvent }
