/**
 * ContextTierResolver — scales context parameters by model capability tier.
 *
 * Two tiers supported:
 *   - "200k": standard models (~200K context window), baseline values
 *   - "1m":    large-context models (~1M context window), 4× scale
 *
 * Usage:
 *   const tier = new ContextTierResolver("1m")
 *   const budget = tier.contextTokenBudget  // 240,000
 *   const tokens = tier.estimateTokens(12000)  // 4000
 */

export type ContextTier = "200k" | "1m"

/** Scale factor for 1m tier relative to 200k baseline */
const SCALE_1M = 4

export class ContextTierResolver {
  readonly tier: ContextTier

  constructor(tier?: ContextTier) {
    this.tier = tier ?? "200k"
  }

  // ━━━ Scaling helper ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  private scale(base200k: number): number {
    return this.tier === "1m" ? base200k * SCALE_1M : base200k
  }

  // ━━━ DiscussionStrategy ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /** Number of recent rounds to keep in full text (does NOT scale — more rounds = more noise) */
  get contextWindowRounds(): number {
    return 2
  }

  /** Token budget for discussion context history */
  get contextTokenBudget(): number {
    return this.scale(60_000)
  }

  /** Max chars of round content sent to LLM for progressive compression */
  get compressionInputMaxChars(): number {
    return this.scale(20_000)
  }

  // ━━━ DispatchStrategy ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /** Max chars of raw expert output passed as <detail> to direct downstream deps */
  get dispatchDetailMaxChars(): number {
    return this.scale(3_000)
  }

  /** If expert output exceeds this, head+tail extraction is used instead of full text */
  get dispatchHeadtailTriggerChars(): number {
    return this.scale(2_500)
  }

  /** Head portion (chars) preserved in head+tail fallback extraction */
  get dispatchHeadChars(): number {
    return this.scale(1_500)
  }

  /** Tail portion (chars) preserved as "conclusion" in head+tail fallback */
  get dispatchTailChars(): number {
    return this.scale(500)
  }

  // ━━━ ContextManager ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /** Max context size in chars before ContextManager triggers compression */
  get contextManagerMaxChars(): number {
    return this.scale(150_000)
  }

  /** Compression trigger ratio (does NOT scale — always 70% of max) */
  get compressRatio(): number {
    return 0.7
  }

  // ━━━ Token estimation ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /** Chars-per-token ratio for estimation (3 = safe for CJK + English mix) */
  get charsPerToken(): number {
    return 3
  }

  /** Estimate token count from character length */
  estimateTokens(chars: number): number {
    return Math.ceil(chars / this.charsPerToken)
  }

  // ━━━ Tier-independent (SSE / preview) ━━━━━━━━━━━━━━━━━━━
  // These do NOT scale — they are UI/event display limits

  /** Max chars of synthesis text in swarm_complete SSE event */
  get ssePreviewChars(): number {
    return 2000
  }

  /** Max chars of expert output in expert_complete SSE event */
  get sseExpertOutputPreviewChars(): number {
    return 2000
  }

  /** Max chars for recommendation field in degraded JSON fallback */
  get hostRecommendationChars(): number {
    return 200
  }
}
