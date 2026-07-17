import type { SwarmServices, ExpertOutput, SwarmStrategyConfig } from "./swarm-strategy"
import type {
  SwarmSSEEvent,
  ExpertResult,
  Message,
  BudgetStatus,
  HostOutput,
} from "./swarm-types"
import type { ExpertDef } from "@octopus/shared"
import { HostAgent } from "./host-agent"
import type { HostAgentConfig } from "./host-agent"
import { SSE_EXPERT_OUTPUT_PREVIEW_CHARS } from "./swarm-constants"

/**
 * Dependencies injected into the coordinator.
 * These bridge the strategy layer with the engine infrastructure.
 */
export interface CoordinatorDeps {
  llmCall: (prompt: string, model?: string, engine?: string, skills?: string[]) => Promise<{ text: string; model: string; tokens: number; inputTokens: number; outputTokens: number; toolsUsed: string[]; filesChanged: string[] }>
  hostAgent: HostAgent
  emitSSE?: (event: SwarmSSEEvent) => void
  logSwarmEvent?: (nodeId: string, event: string, data: Record<string, any>) => void
  executeHook?: (event: string, context: Record<string, any>) => void
  saveCheckpoint?: () => void
  checkBudget?: () => BudgetStatus
  isTimedOut?: () => boolean
  nodeId: string
}

/**
 * SwarmCoordinator — implements SwarmServices, bridging strategies and the engine.
 *
 * The coordinator wraps LLM calls, manages SSE event emission, tracks budget,
 * checks timeouts, and delegates Host synthesis to the HostAgent.
 * It also records all emitted events for later inspection (getEmittedEvents).
 */
export class SwarmCoordinator implements SwarmServices {
  private sseEvents: SwarmSSEEvent[] = []
  /** Current swarm execution state — updated by strategies for checkpoint capture */
  checkpointState: {
    currentRound: number
    consensusScore: number | null
    expertResults: ExpertResult[]
  } = { currentRound: 0, consensusScore: null, expertResults: [] }

  constructor(private deps: CoordinatorDeps) {}

  async runExpert(expert: ExpertDef, prompt: string, round: number): Promise<ExpertOutput> {
    // Check timeout before executing
    if (this.isTimedOut()) {
      throw new Error(`Expert "${expert.role}" skipped: timeout exceeded`)
    }

    // Check budget before each LLM call
    const budget = this.checkBudget()
    if (budget.status === "exhausted") {
      throw new Error(`Expert "${expert.role}" skipped: budget exhausted`)
    }

    const model = expert.model

    // Emit expert_spawn BEFORE the LLM call so the UI sees it even if the call fails
    this.emit({
      type: "expert_spawn",
      data: {
        nodeId: this.deps.nodeId,
        role: expert.role,
        model: (model as string) || "pro",
        source: "predefined",
      },
    })

    try {
      const result = await this.deps.llmCall(prompt, model, expert.engine, expert.skills)

      this.emit({
        type: "expert_complete",
        data: {
          nodeId: this.deps.nodeId,
          role: expert.role,
          model: result.model,
          status: "completed",
          output: result.text.slice(0, SSE_EXPERT_OUTPUT_PREVIEW_CHARS),
          tokens: result.tokens,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        },
      })

      return {
        output: result.text,
        tokens: result.tokens,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        files_changed: result.filesChanged,
        tools_used: result.toolsUsed.length > 0 ? result.toolsUsed : (expert.tools ?? []),
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e)

      // Sanitize error message for SSE — strip ANSI only, preserve CJK and all Unicode
      const sanitized = message
        .replace(/\x1b\[[0-9;]*m/g, "")
        .slice(0, 500)

      // Emit expert_complete with failed status so the UI can track it
      this.emit({
        type: "expert_complete",
        data: {
          nodeId: this.deps.nodeId,
          role: expert.role,
          status: "failed",
          output: sanitized,
          tokens: 0,
          inputTokens: 0,
          outputTokens: 0,
        },
      })

      throw e
    }
  }

  async runHost(inputs: {
    expertOutputs: ExpertResult[]
    messages: Message[]
    outputFormat?: string
    mode?: string
    topic: string
    host?: ExpertDef
  }): Promise<HostOutput> {
    const config: HostAgentConfig = {
      outputFormat: inputs.outputFormat,
      mode: inputs.mode,
      topic: inputs.topic,
      host: inputs.host,
    }
    return this.deps.hostAgent.synthesize(inputs.expertOutputs, inputs.messages, config)
  }

  checkBudget(): BudgetStatus {
    if (this.deps.checkBudget) return this.deps.checkBudget()
    return { status: "ok", consumed: 0, limit: null, percentage: 0 }
  }

  isTimedOut(): boolean {
    if (this.deps.isTimedOut) return this.deps.isTimedOut()
    return false
  }

  emit(event: SwarmSSEEvent): void {
    this.sseEvents.push(event)
    this.deps.emitSSE?.(event)
    // Log to JSONL
    this.deps.logSwarmEvent?.(this.deps.nodeId, event.type, event.data as Record<string, any>)
  }

  triggerHook(event: string, context: Record<string, any>): void {
    this.deps.executeHook?.(event, context)
  }

  async llmCall(prompt: string, model?: string): Promise<string> {
    const result = await this.deps.llmCall(prompt, model ?? "se")
    return result.text
  }

  saveCheckpoint(): void {
    this.deps.saveCheckpoint?.()
  }

  getEmittedEvents(): SwarmSSEEvent[] {
    return [...this.sseEvents]
  }
}
