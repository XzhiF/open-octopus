/**
 * Swarm engine constants — tier-independent values only.
 *
 * Tier-dependent parameters (context limits, truncation thresholds)
 * are managed by ContextTierResolver and scale with model capability.
 *
 * This file only contains:
 *   - SSE/Hook preview limits (UI display, not model-facing)
 *   - Default tier selection
 */

import type { ContextTier } from "./context-tier-resolver"

// ━━━ Default Tier ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Default context tier when YAML doesn't specify context_tier */
export const DEFAULT_CONTEXT_TIER: ContextTier = "200k"

// ━━━ SSE / Hook Preview ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Truncation limits for event payloads (not full content, tier-independent)

/** Max chars of synthesis text in swarm_complete SSE event */
export const SSE_SYNTHESIS_PREVIEW_CHARS = 2000

/** Max chars of expert output in expert_complete SSE event */
export const SSE_EXPERT_OUTPUT_PREVIEW_CHARS = 2000

// ━━━ Host Agent ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Max chars for recommendation field in degraded JSON fallback */
export const HOST_DEGRADED_RECOMMENDATION_CHARS = 200
