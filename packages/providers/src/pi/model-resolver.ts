interface ModelLike {
  provider: string
  id: string
}

interface RegistryLike {
  find(provider: string, modelId: string): ModelLike | undefined
  getAll(): ModelLike[]
}

const MODEL_ALIASES: Record<string, { provider: string; modelId: string }> = {
  sonnet: { provider: 'anthropic', modelId: 'claude-sonnet-4-20250514' },
  opus: { provider: 'anthropic', modelId: 'claude-opus-4-20250514' },
  haiku: { provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001' },
  'gpt-4o': { provider: 'openai', modelId: 'gpt-4o' },
  'gpt-4o-mini': { provider: 'openai', modelId: 'gpt-4o-mini' },
  'qwen3-max': { provider: 'dashscope', modelId: 'qwen3-max' },
  'qwen3.7-max': { provider: 'dashscope', modelId: 'qwen3.7-max' },
  'qwen3.7-plus': { provider: 'dashscope', modelId: 'qwen3.7-plus' },
  'qwen3.6-plus': { provider: 'dashscope', modelId: 'qwen3.6-plus' },
}

export function resolveModel(
  modelStr: string | undefined,
  registry: RegistryLike,
): ModelLike | undefined {
  if (!modelStr) return undefined

  // 1. "provider/model-id" format
  const slashIndex = modelStr.indexOf('/')
  if (slashIndex > 0) {
    const provider = modelStr.slice(0, slashIndex)
    const modelId = modelStr.slice(slashIndex + 1)
    return registry.find(provider, modelId) ?? undefined
  }

  // 2. Short-name aliases
  const alias = MODEL_ALIASES[modelStr]
  if (alias) {
    return registry.find(alias.provider, alias.modelId) ?? undefined
  }

  // 3. Full-text search across all providers
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
