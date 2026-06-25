import type { Message, ExpertResult } from "../executors/swarm/swarm-types"

export interface CheckpointNodeResult {
  status: "completed" | "failed" | "skipped"
  durationMs: number
  sessionId?: string
  retryCount: number
  outputs?: Record<string, unknown>
}

/** Swarm-specific checkpoint data stored within the general checkpoint */
export interface SwarmCheckpointData {
  nodeId: string
  mode: string
  currentRound: number
  messages: Message[]
  expertResults: ExpertResult[]
  consensusScore: number | null
  consumedTokens: number
  startTime: number
}

export interface Checkpoint {
  executionId: string
  workflowRef: string
  timestamp: string
  completedNodes: Record<string, CheckpointNodeResult>
  poolSnapshot: Record<string, unknown>
  globalSessionId?: string
  branchSessionIds: Record<string, string>
  currentLevelIndex?: number
  resumeAttempts: number
  /** Swarm-specific checkpoint data (only present for swarm node checkpoints) */
  swarmData?: SwarmCheckpointData
}

/**
 * Checkpoint store interface — engine depends on this abstraction, not on any specific storage.
 * Implementations can use SQLite, filesystem, Redis, etc.
 */
export interface ICheckpointStore {
  /** Save a checkpoint. Implementations handle persistence, pruning, and TTL. */
  save(checkpoint: Checkpoint): void

  /**
   * Load the latest checkpoint for an execution. Returns null if none exists.
   * Used by SwarmExecutor to resume swarm nodes from checkpoint data.
   */
  load(executionId: string): Checkpoint | null

  /** Remove expired checkpoints based on TTL. */
  cleanExpired(): void
}

export interface CheckpointStoreConfig {
  max_checkpoints: number
  ttl: number
  max_size_bytes: number
}
