// Swarm SSE event types (mirror of backend swarm-types.ts)

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
  status: "completed" | "failed" | "budget_exhausted" | "timeout_exceeded"
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

export type SwarmMode = "review" | "debate" | "dispatch" | "swarm" | "moa"
export type ExpertStatus = "running" | "completed" | "failed" | "skipped" | "budget_exceeded" | "pending"
export type SwarmStatus = "initializing" | "running" | "completed" | "failed"

export interface ExpertInfo {
  role: string
  status: ExpertStatus
  model: string
  source: "predefined" | "dynamic"
  tokensConsumed: number
  inputTokens: number
  outputTokens: number
  output?: string
  filesChanged?: string[]
  error?: string | null
  attempts: number
  routerReasoning?: string
  matchScore?: number
}

export interface SwarmMessage {
  from: string
  round: number
  content: string
  timestamp: number
  tokens?: number
}

export interface ConsensusDataPoint {
  round: number
  score: number
  shouldContinue: boolean
}

export interface RouterDecision {
  mode: string
  modeReasoning: string
  experts: Array<{
    role: string
    matchedFrom: string
    matchReasoning: string
    matchScore: number
  }>
  alternativesConsidered: Array<{
    role: string
    reasonRejected: string
  }>
}

export interface TaskBreakdown {
  dag: {
    levels: string[][]
  }
  experts: Array<{
    role: string
    level: number
    dependsOn: string[]
  }>
}

export interface FileConflict {
  file: string
  experts: string[]
}

export interface SwarmStatsResponse {
  total_executions: number
  success_rate: number
  avg_duration_ms: number
  avg_token_consumed: number
  mode_distribution: {
    review: number
    debate: number
    dispatch: number
    swarm: number
  }
  avg_rounds: number
  avg_consensus_score: number | null
  top_roles: Array<{ role: string; count: number }>
  router_accuracy: number | null
}
