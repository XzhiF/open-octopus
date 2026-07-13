import { SwarmStrategy } from "./swarm-strategy"
import type { SwarmServices, SwarmStrategyConfig, ExpertOutput } from "./swarm-strategy"
import type { SwarmResult, ExpertResult, Message } from "./swarm-types"
import type { ExpertDef } from "@octopus/shared"
import type { MessageBus } from "./message-bus"
import type { SharedMemory } from "./shared-memory"
import { SSE_SYNTHESIS_PREVIEW_CHARS } from "./swarm-constants"

/**
 * DiscussionStrategy — covers "review" (single round) and "debate" (multi-round with consensus) modes.
 *
 * Review mode: all experts run once in parallel, then the Host synthesizes.
 * Debate mode: multiple rounds of expert discussion, with consensus checks between rounds.
 *              Terminates early if consensus >= threshold or the Host signals should_continue=false.
 *
 * Context optimization (debate mode):
 *   - Sliding window: keeps the last `contextWindowRounds` rounds in full
 *   - Progressive compression: older rounds are summarized via LLM (haiku)
 *   - Token budget safety valve: emergency truncation if context exceeds budget
 */
export class DiscussionStrategy extends SwarmStrategy {
  async run(experts: ExpertDef[], bus: MessageBus, memory: SharedMemory): Promise<SwarmResult> {
    const maxRounds = this.config.mode === "review" ? 1 : this.config.rounds
    const checkConsensus = this.config.mode !== "review"
    const expertResults: ExpertResult[] = []
    const failedExperts: string[] = []
    const skippedExperts: string[] = []
    let consensusScore: number | null = null
    let roundsUsed = 0
    let contextOverflow = false

    // Context optimization: compressed summaries for older rounds
    const summaries: Array<{ round: number; content: string }> = []
    const tier = this.config.contextTier
    const fullRounds = tier.contextWindowRounds
    const tokenBudget = tier.contextTokenBudget

    // ponytail: checkpoint resume — skip rounds already completed
    const startRound = (this.config.resumeFromRound ?? 0) + 1
    if (this.config.resumeFromRound && this.config.resumeFromRound > 0) {
      roundsUsed = this.config.resumeFromRound
      consensusScore = this.services.checkpointState.consensusScore
      // Restore expert results from checkpoint
      for (const er of this.services.checkpointState.expertResults) {
        expertResults.push(er)
      }
    }

    // Hook: swarm_start
    this.services.triggerHook("on_swarm_start", {
      nodeId: this.config.nodeId,
      mode: this.config.mode,
      expertCount: experts.length,
      topic: this.config.topic,
    })

    for (let round = startRound; round <= maxRounds; round++) {
      roundsUsed = round

      // Check budget before each round
      const budget = this.services.checkBudget()
      if (budget.status === "exhausted") break

      // Execute all experts in parallel for this round
      const roundPromises = experts.map(async (expert) => {
        try {
          // Build thread context using sliding window + summaries
          const thread = bus.getThread({})
          const context = this.buildSlidingWindowContext(thread, summaries, round, fullRounds, tokenBudget, tier)
          if (context.estimatedTokens > tokenBudget) contextOverflow = true

          const prompt = this.buildExpertPrompt(expert, this.config.topic, context.text, round)

          // Hook: expert_spawn
          this.services.triggerHook("on_expert_spawn", {
            nodeId: this.config.nodeId,
            role: expert.role,
            round,
          })

          const result = await this.services.runExpert(expert, prompt, round)

          // Hook: expert_complete
          this.services.triggerHook("on_expert_complete", {
            nodeId: this.config.nodeId,
            role: expert.role,
            round,
            status: "completed",
            tokens: result.tokens,
          })

          // Write to message bus
          bus.send({
            from: expert.role,
            to: "*",
            round,
            content: result.output,
            timestamp: Date.now(),
          })

          this.services.emit({
            type: "expert_message",
            data: {
              nodeId: this.config.nodeId,
              role: expert.role,
              round,
              content: result.output,
              tokens: result.tokens,
            },
          })

          return {
            role: expert.role,
            status: "completed" as const,
            output: result.output,
            rounds: round,
            tools_used: result.tools_used,
            files_changed: result.files_changed,
            source: "predefined" as const,
            attempts: 1,
          }
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e)
          failedExperts.push(expert.role)

          // Hook: expert_complete (failed)
          this.services.triggerHook("on_expert_complete", {
            nodeId: this.config.nodeId,
            role: expert.role,
            round,
            status: "failed",
            error: message,
          })

          return {
            role: expert.role,
            status: "failed" as const,
            output: "",
            rounds: round,
            tools_used: [],
            files_changed: [],
            source: "predefined" as const,
            attempts: 1,
            error: message,
          }
        }
      })

      const roundResults = await Promise.allSettled(roundPromises)
      const roundExpertResults = roundResults.map(r =>
        r.status === "fulfilled"
          ? r.value
          : {
              role: "unknown",
              status: "failed" as const,
              output: "",
              rounds: round,
              tools_used: [],
              files_changed: [],
              source: "predefined" as const,
              attempts: 1,
              error: r.reason?.message ?? "Unknown error",
            },
      )

      // Update expert results (accumulate across rounds)
      for (const result of roundExpertResults) {
        const existing = expertResults.find(e => e.role === result.role)
        if (existing) {
          existing.output = result.output
          existing.rounds = result.rounds
          existing.status = result.status
        } else {
          expertResults.push(result)
        }
      }

      // Emit round end
      this.services.emit({
        type: "swarm_round_end",
        data: {
          nodeId: this.config.nodeId,
          round,
          expertCount: experts.length,
        },
      })

      // Hook: round_end
      this.services.triggerHook("on_swarm_round_end", {
        nodeId: this.config.nodeId,
        round,
        expertCount: experts.length,
      })

      // Check consensus (debate mode only, not on the last round)
      if (checkConsensus && round < maxRounds) {
        const hostOutput = await this.services.runHost({
          expertOutputs: expertResults,
          messages: bus.getAll(),
          mode: this.config.mode,
          topic: this.config.topic,
          host: this.config.host,
        })

        if (hostOutput.assessment) {
          consensusScore = hostOutput.assessment.consensus_score
          this.services.emit({
            type: "consensus_check",
            data: {
              nodeId: this.config.nodeId,
              round,
              score: consensusScore,
              shouldContinue: hostOutput.assessment.should_continue,
            },
          })

          // Hook: consensus
          this.services.triggerHook("on_swarm_consensus", {
            nodeId: this.config.nodeId,
            round,
            consensusScore,
            shouldContinue: hostOutput.assessment.should_continue,
          })

          if (consensusScore >= this.config.consensusThreshold) {
            break
          }
        }
      }

      // Update checkpoint state before saving
      this.services.checkpointState = {
        currentRound: round,
        consensusScore,
        expertResults: [...expertResults],
      }

      // Progressive compression: summarize rounds that just slid out of the window
      const roundToCompress = round - fullRounds
      if (roundToCompress >= 1) {
        const messagesToCompress = bus.getThread({}).filter(m => m.round === roundToCompress)
        if (messagesToCompress.length > 0) {
          const content = messagesToCompress
            .map(m => `${m.from}: ${m.content}`)
            .join("\n")

          try {
            const summary = await this.services.llmCall(
              `用 3-5 句话总结以下讨论中各专家的核心观点、共识和分歧点:\n\n${content.slice(0, this.config.contextTier.compressionInputMaxChars)}`,
              "se",
            )
            summaries.push({ round: roundToCompress, content: summary })
          } catch {
            summaries.push({
              round: roundToCompress,
              content: `[Round ${roundToCompress}: ${messagesToCompress.length} messages, compression failed]`,
            })
          }
        }
      }

      // Save checkpoint after each round
      this.services.saveCheckpoint()
    }

    // Final synthesis
    const hostOutput = await this.services.runHost({
      expertOutputs: expertResults,
      messages: bus.getAll(),
      outputFormat: this.config.outputFormat,
      mode: this.config.mode,
      topic: this.config.topic,
      host: this.config.host,
    })

    const budgetStatus = this.services.checkBudget()

    // Determine status: all experts failed → "failed"
    const allFailed = experts.length > 0 && failedExperts.length === experts.length
    const result: SwarmResult = {
      synthesis: hostOutput.synthesis,
      rawResponse: hostOutput.rawResponse,
      consensus_score: consensusScore,
      rounds_used: roundsUsed,
      expert_count: experts.length,
      experts: expertResults,
      history: bus.getAll(),
      budget_exhausted: budgetStatus.status === "exhausted",
      timeout_exceeded: false,
      context_overflow: contextOverflow,
      host_degraded: !hostOutput.assessment && this.config.mode !== "review",
      failed_experts: failedExperts,
      skipped_experts: skippedExperts,
      file_conflicts: [],
      status: allFailed
        ? "failed"
        : budgetStatus.status === "exhausted"
          ? "budget_exhausted"
          : "completed",
    }

    // Emit swarm_complete SSE event
    this.services.emit({
      type: "swarm_complete",
      data: {
        nodeId: this.config.nodeId,
        mode: this.config.mode,
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

    // Hook: swarm_complete
    this.services.triggerHook("on_swarm_complete", {
      nodeId: this.config.nodeId,
      status: result.status,
      roundsUsed: result.rounds_used,
      expertCount: result.expert_count,
      synthesis: result.synthesis.slice(0, SSE_SYNTHESIS_PREVIEW_CHARS),
    })

    return result
  }

  private buildExpertPrompt(
    expert: ExpertDef,
    topic: string,
    context: string,
    round: number,
  ): string {
    let prompt = `You are an expert with the role: ${expert.role}`
    if (expert.perspective) prompt += `\nYour perspective: ${expert.perspective}`
    if (expert.task) prompt += `\nYour task: ${expert.task}`
    if (expert.prompt) prompt += `\n\n${expert.prompt}`

    prompt += `\n\n===USER TOPIC START===\n${topic}\n===USER TOPIC END===`

    if (context) {
      prompt += `\n\n## Previous Discussion\n${context}`
    }

    prompt += `\n\nRound ${round}: Provide your analysis.`
    return prompt
  }

  /**
   * Build context using sliding window + progressive compression.
   *
   * - Recent rounds (within window): full text
   * - Older rounds: compressed summaries
   * - Token budget safety valve: emergency truncation if over budget
   */
  private buildSlidingWindowContext(
    thread: Message[],
    summaries: Array<{ round: number; content: string }>,
    currentRound: number,
    fullRounds: number,
    tokenBudget: number,
    tier: typeof this.config.contextTier,
  ): { text: string; estimatedTokens: number } {
    const cutoffRound = Math.max(1, currentRound - fullRounds)

    // Recent rounds: full text
    const recentMessages = thread.filter(m => m.round >= cutoffRound && m.round < currentRound)
    const recentContext = recentMessages
      .map(m => `[Round ${m.round}] ${m.from}: ${m.content}`)
      .join("\n")

    // Older rounds: compressed summaries
    const oldContext = summaries
      .filter(s => s.round < cutoffRound)
      .map(s => `[Summary Round ${s.round}] ${s.content}`)
      .join("\n")

    let text = [oldContext, recentContext].filter(Boolean).join("\n\n")
    let estimatedTokens = tier.estimateTokens(text.length)

    // Token budget safety valve: if still over budget, keep only last round + summaries
    if (estimatedTokens > tokenBudget) {
      const lastRoundMessages = thread.filter(m => m.round === currentRound - 1)
      const emergencyParts: string[] = []
      if (oldContext) emergencyParts.push(oldContext)
      emergencyParts.push(
        ...lastRoundMessages.map(m => `[Round ${m.round}] ${m.from}: ${m.content}`),
      )
      text = emergencyParts.filter(Boolean).join("\n\n")
      estimatedTokens = tier.estimateTokens(text.length)
    }

    return { text, estimatedTokens }
  }
}
