interface ModelLike {
  provider: string
  id: string
}

interface RegistryLike {
  find(provider: string, modelId: string): ModelLike | undefined
  getAll(): ModelLike[]
}

/**
 * Resolve a model string to a Model object in the Pi SDK registry.
 *
 * Supports three formats:
 *   1. "provider/model-id" → direct lookup via registry.find()
 *   2. Bare model id       → search across all providers via registry.getAll()
 *
 * Tier resolution (pro-max/pro/se) is handled upstream by shared/model-alias.ts
 * before reaching this function. By the time we get here, the string should
 * already be in "provider/model-id" format.
 */
export function resolveModel(
  modelStr: string | undefined,
  registry: RegistryLike,
): ModelLike | undefined {
  if (!modelStr) return undefined

  // 1. "provider/model-id" format — direct lookup
  const slashIndex = modelStr.indexOf('/')
  if (slashIndex > 0) {
    const provider = modelStr.slice(0, slashIndex)
    const modelId = modelStr.slice(slashIndex + 1)
    return registry.find(provider, modelId) ?? undefined
  }

  // 2. Bare model id — search across all registered providers
  const all = registry.getAll()
  const matches = all.filter((m: ModelLike) => m.id === modelStr)
  if (matches.length > 0) {
    if (matches.length > 1) {
      console.warn(`[model-resolver] Ambiguous model "${modelStr}" found in providers: ${matches.map(m => m.provider).join(', ')}. Using first match.`)
    }
    return matches[0]
  }

  return undefined
}
