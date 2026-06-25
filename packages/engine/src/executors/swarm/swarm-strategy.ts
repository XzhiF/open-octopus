import type { SwarmResult, HostOutput, BudgetStatus, Message, SwarmSSEEvent, ExpertResult } from "./swarm-types"
import type { ExpertDef } from "@octopus/shared"
import type { MessageBus } from "./message-bus"
import type { SharedMemory } from "./shared-memory"
import type { ContextTierResolver } from "./context-tier-resolver"

/** Expert execution output */
export interface ExpertOutput {
  output: string
  tokens: number
  inputTokens: number
  outputTokens: number
  files_changed: string[]
  tools_used: string[]
  error?: string
}

/** Services that the strategy needs from the coordinator */
export interface SwarmServices {
  /** Run a single expert with the given prompt */
  runExpert(expert: ExpertDef, prompt: string, round: number): Promise<ExpertOutput>

  /** Run the Host synthesis phase */
  runHost(inputs: {
    expertOutputs: ExpertResult[]
    messages: Message[]
    outputFormat?: string
    mode?: string
    topic: string
    host?: ExpertDef
  }): Promise<HostOutput>

  /** Check current budget status */
  checkBudget(): BudgetStatus

  /** Emit an SSE event */
  emit(event: SwarmSSEEvent): void

  /** Save a checkpoint for recovery */
  saveCheckpoint(): void

  /** Trigger a lifecycle hook event */
  triggerHook(event: string, context: Record<string, any>): void

  /** Lightweight LLM call for context compression (no expert wrapper) */
  llmCall(prompt: string, model?: string): Promise<string>

  /** Mutable checkpoint state — strategies update this as they progress */
  checkpointState: {
    currentRound: number
    consensusScore: number | null
    expertResults: ExpertResult[]
  }
}

/** Configuration passed to strategy */
export interface SwarmStrategyConfig {
  mode: "review" | "debate" | "dispatch" | "swarm"
  topic: string
  rounds: number
  consensusThreshold: number
  outputFormat?: string
  nodeId: string
  failurePolicy: "fail_fast" | "continue_partial" | "retry_failed"
  /** Resume from checkpoint: skip rounds up to this number */
  resumeFromRound?: number
  /** Context tier resolver — provides scaled parameters by model capability */
  contextTier: ContextTierResolver
  /** Host agent definition (ExpertDef) — model, prompt, perspective for synthesis */
  host?: ExpertDef
}

/** Abstract strategy for swarm orchestration modes */
export abstract class SwarmStrategy {
  constructor(
    protected services: SwarmServices,
    protected config: SwarmStrategyConfig,
  ) {}

  abstract run(
    experts: ExpertDef[],
    bus: MessageBus,
    memory: SharedMemory,
  ): Promise<SwarmResult>
}
