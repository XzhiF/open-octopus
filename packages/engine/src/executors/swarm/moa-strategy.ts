import { SwarmStrategy } from "./swarm-strategy"
import type { SwarmServices, SwarmStrategyConfig, ExpertOutput } from "./swarm-strategy"
import type { SwarmResult, ExpertResult } from "./swarm-types"
import type { ExpertDef } from "@octopus/shared"
import type { MessageBus } from "./message-bus"
import type { SharedMemory } from "./shared-memory"
import { SSE_SYNTHESIS_PREVIEW_CHARS } from "./swarm-constants"

// ponytail: ~25k tokens char limit for aggregator input
const MAX_AGG_INPUT_CHARS = 100_000

export interface MoaStrategyConfig extends SwarmStrategyConfig {
  aggregator?: ExpertDef
  timeout?: number
}

export class MoaStrategy extends SwarmStrategy {
  protected declare config: MoaStrategyConfig
  private aggregator?: ExpertDef

  constructor(services: SwarmServices, config: MoaStrategyConfig) {
    super(services, config)
    this.aggregator = config.aggregator
  }

  async run(experts: ExpertDef[], bus: MessageBus, memory: SharedMemory): Promise<SwarmResult> {
    const timeoutMs = this.config.timeout ?? 120_000

    this.services.triggerHook("on_swarm_start", {
      nodeId: this.config.nodeId,
      mode: "moa",
      expertCount: experts.length,
      topic: this.config.topic,
    })

    // Phase 1: Parallel expert fan-out
    const expertResults: ExpertResult[] = await Promise.all(
      experts.map(async (expert) => {
        this.services.triggerHook("on_expert_spawn", {
          nodeId: this.config.nodeId,
          role: expert.role,
          round: 1,
        })

        this.services.emit({
          type: "expert_spawn",
          data: {
            nodeId: this.config.nodeId,
            role: expert.role,
            model: expert.model ?? "default",
            source: "predefined",
          },
        })

        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Expert ${expert.role} timeout after ${timeoutMs}ms`)), timeoutMs),
        )

        try {
          const result = await Promise.race([
            this.services.runExpert(expert, this.config.topic, 1),
            timeoutPromise,
          ])

          const expertResult: ExpertResult = {
            role: expert.role,
            status: "completed",
            output: result.output,
            rounds: 1,
            tools_used: result.tools_used,
            files_changed: result.files_changed,
            source: "predefined",
            attempts: 1,
          }

          this.services.triggerHook("on_expert_complete", {
            nodeId: this.config.nodeId,
            role: expert.role,
            round: 1,
            status: "completed",
            tokens: result.tokens,
          })

          this.services.emit({
            type: "expert_complete",
            data: {
              nodeId: this.config.nodeId,
              role: expert.role,
              model: expert.model,
              status: "completed",
              output: result.output,
              tokens: result.tokens,
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
            },
          })

          return expertResult
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e)

          this.services.triggerHook("on_expert_complete", {
            nodeId: this.config.nodeId,
            role: expert.role,
            round: 1,
            status: "failed",
            error: message,
          })

          this.services.emit({
            type: "expert_complete",
            data: {
              nodeId: this.config.nodeId,
              role: expert.role,
              model: expert.model,
              status: "failed",
              output: "",
              tokens: 0,
              inputTokens: 0,
              outputTokens: 0,
            },
          })

          return {
            role: expert.role,
            status: "failed",
            output: "",
            rounds: 1,
            tools_used: [],
            files_changed: [],
            source: "predefined",
            attempts: 1,
            error: message,
          }
        }
      }),
    )

    // Phase 2: Failure check
    const successfulResults = expertResults.filter((r) => r.status === "completed")
    const failedExperts = expertResults.filter((r) => r.status !== "completed").map((r) => r.role)

    if (successfulResults.length === 0) {
      const result = this.buildResult({
        synthesis: "All experts failed",
        status: "failed",
        expert_count: experts.length,
        experts: expertResults,
        failed_experts: failedExperts,
        rounds_used: 1,
      })
      this.emitSwarmComplete(result)
      return result
    }

    // Phase 3: Aggregation
    if (this.config.rounds === 0) {
      // Skip aggregation — raw output
      const rawSynthesis = successfulResults.map((r) => `## ${r.role}\n${r.output}`).join("\n\n")
      const result = this.buildResult({
        synthesis: rawSynthesis,
        expert_count: experts.length,
        experts: expertResults,
        failed_experts: failedExperts,
        rounds_used: 0,
      })
      this.emitSwarmComplete(result)
      return result
    }

    // rounds >= 1: use aggregator
    let currentExpertOutputs = this.truncateForAggregator(successfulResults)
    let synthesis = ""
    let roundsUsed = 0

    for (let round = 1; round <= this.config.rounds; round++) {
      roundsUsed = round

      const hostOutput = await this.services.runHost({
        expertOutputs: currentExpertOutputs,
        messages: [],
        outputFormat: this.config.outputFormat,
        mode: "moa",
        topic: this.config.topic,
        host: this.aggregator,
      })

      synthesis = hostOutput.synthesis

      // Phase 4: Multi-round refinement — feed synthesis back as a "synthesis expert"
      if (round < this.config.rounds) {
        currentExpertOutputs = this.truncateForAggregator([
          {
            role: "__moa_synthesis",
            output: synthesis,
            status: "completed",
            rounds: round,
            tools_used: [],
            files_changed: [],
            source: "predefined",
            attempts: 1,
          },
        ])
      }
    }

    this.services.checkpointState = {
      currentRound: roundsUsed,
      consensusScore: null,
      expertResults: [...expertResults],
    }
    this.services.saveCheckpoint()

    const budgetStatus = this.services.checkBudget()

    const result = this.buildResult({
      synthesis,
      rounds_used: roundsUsed,
      expert_count: experts.length,
      experts: expertResults,
      failed_experts: failedExperts,
      budget_exhausted: budgetStatus.status === "exhausted",
      status: budgetStatus.status === "exhausted" ? "budget_exhausted" : "completed",
    })

    this.emitSwarmComplete(result)
    return result
  }

  // P1.5: Token truncation — divide limit equally among experts
  private truncateForAggregator(outputs: ExpertResult[]): ExpertResult[] {
    const totalChars = outputs.reduce((sum, o) => sum + o.output.length, 0)
    if (totalChars <= MAX_AGG_INPUT_CHARS) return outputs

    const perExpertLimit = Math.floor(MAX_AGG_INPUT_CHARS / outputs.length)
    return outputs.map((o) => {
      if (o.output.length <= perExpertLimit) return o
      return {
        ...o,
        output: o.output.slice(0, perExpertLimit) + "\n\n[... 输出已截断 ...]",
      }
    })
  }

  private emitSwarmComplete(result: SwarmResult): void {
    this.services.triggerHook("on_swarm_complete", {
      nodeId: this.config.nodeId,
      status: result.status,
      roundsUsed: result.rounds_used,
      expertCount: result.expert_count,
      synthesis: result.synthesis.slice(0, SSE_SYNTHESIS_PREVIEW_CHARS),
    })

    this.services.emit({
      type: "swarm_complete",
      data: {
        nodeId: this.config.nodeId,
        mode: "moa",
        status: result.status,
        synthesis: result.synthesis.slice(0, SSE_SYNTHESIS_PREVIEW_CHARS),
        result: {
          consensus_score: result.consensus_score,
          rounds_used: result.rounds_used,
          expert_count: result.expert_count,
          budget_exhausted: result.budget_exhausted,
          timeout_exceeded: result.timeout_exceeded,
          host_degraded: result.host_degraded,
          failed_experts: result.failed_experts,
          skipped_experts: result.skipped_experts,
        },
      },
    })
  }

  private buildResult(overrides: Partial<SwarmResult>): SwarmResult {
    return {
      synthesis: "",
      consensus_score: null, // MOA has no consensus concept
      rounds_used: 0,
      expert_count: 0,
      experts: [],
      history: [], // MOA has no message history
      budget_exhausted: false,
      timeout_exceeded: false,
      context_overflow: false,
      host_degraded: false,
      failed_experts: [],
      skipped_experts: [],
      file_conflicts: [],
      status: "completed",
      ...overrides,
    }
  }
}
