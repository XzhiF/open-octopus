// packages/server/src/services/harness/actions/switch-model.ts
//
// switch_model action — returns a modelOverride for the onBeforeRetry callback.
// Supports explicit model names and preference-based resolution (e.g. "vision_capable").

import type { ActionHandler } from "../action-types"

/**
 * Map preference hints to concrete model identifiers.
 * These are the default models; production would read from config.
 */
const PREFERENCE_MODELS: Record<string, string> = {
  vision_capable: "claude-sonnet-4-20250514",
  tool_capable: "claude-sonnet-4-20250514",
  default: "claude-sonnet-4-20250514",
}

const DEFAULT_MODEL = "claude-sonnet-4-20250514"

export const switchModelHandler: ActionHandler = async (ctx) => {
  const { strategyAction } = ctx
  const explicitModel = strategyAction.model as string | undefined
  const prefer = strategyAction.prefer as string | undefined

  let modelOverride: string

  if (explicitModel) {
    modelOverride = explicitModel
  } else if (prefer) {
    modelOverride = PREFERENCE_MODELS[prefer] ?? DEFAULT_MODEL
  } else {
    modelOverride = DEFAULT_MODEL
  }

  return {
    success: true,
    action: "switch_model",
    message: `Switch model to ${modelOverride}${prefer ? ` (preference: ${prefer})` : ""}`,
    modelOverride,
    details: {
      model: modelOverride,
      prefer: prefer ?? null,
    },
  }
}
