import type { Message } from "./swarm-types"
import { ContextTierResolver } from "./context-tier-resolver"

export class ContextManager {
  private maxContextChars: number
  private preserveRounds: number
  private compressRatio: number
  private tier: ContextTierResolver

  constructor(
    private llmCall: (prompt: string, model?: string) => Promise<string>,
    options?: { tier?: ContextTierResolver },
  ) {
    this.tier = options?.tier ?? new ContextTierResolver()
    this.maxContextChars = this.tier.contextManagerMaxChars
    this.preserveRounds = this.tier.contextWindowRounds
    this.compressRatio = this.tier.compressRatio
  }

  /** Estimate token count from character length */
  estimateTokens(messages: Message[]): number {
    const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0)
    return this.tier.estimateTokens(totalChars)
  }

  /** Check if context exceeds compression threshold of model limit */
  needsCompression(messages: Message[]): boolean {
    const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0)
    return totalChars > this.maxContextChars * this.compressRatio
  }

  /** Compress older rounds while preserving recent ones */
  async compress(messages: Message[], currentRound: number): Promise<Message[]> {
    const cutoffRound = Math.max(1, currentRound - this.preserveRounds)

    // Split into old (to compress) and recent (to preserve)
    const oldMessages = messages.filter(m => m.round < cutoffRound)
    const recentMessages = messages.filter(m => m.round >= cutoffRound)

    if (oldMessages.length === 0) return messages

    // Group old messages by round for summarization
    const roundsToCompress = new Map<number, Message[]>()
    for (const msg of oldMessages) {
      if (!roundsToCompress.has(msg.round)) {
        roundsToCompress.set(msg.round, [])
      }
      roundsToCompress.get(msg.round)!.push(msg)
    }

    // Summarize each old round
    const summaries: Message[] = []
    for (const [round, roundMessages] of roundsToCompress) {
      try {
        const content = roundMessages
          .map(m => `${m.from}: ${m.content}`)
          .join("\n")

        const summary = await this.llmCall(
          `Summarize the following expert discussion from round ${round} in 2-3 sentences:\n\n${content}`,
          "se"
        )

        summaries.push({
          from: "system",
          to: "*",
          round,
          content: `[Summary of Round ${round}] ${summary}`,
          timestamp: roundMessages[0]?.timestamp ?? Date.now(),
          metadata: { summarized: true, originalCount: roundMessages.length },
        })
      } catch {
        // If summarization fails, keep a truncated version
        summaries.push({
          from: "system",
          to: "*",
          round,
          content: `[Round ${round} — ${roundMessages.length} messages, content truncated]`,
          timestamp: roundMessages[0]?.timestamp ?? Date.now(),
          metadata: { summarized: true, failed: true },
        })
      }
    }

    // Check if still over limit after compression
    const result = [...summaries, ...recentMessages]
    if (this.needsCompression(result)) {
      // Still too large — signal overflow
      return result  // caller should check and set context_overflow
    }

    return result
  }
}
