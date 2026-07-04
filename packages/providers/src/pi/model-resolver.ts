interface ModelLike {
  provider: string
  id: string
}

interface RegistryLike {
  getModel(provider: string, modelId: string): ModelLike | null
}

const MODEL_ALIASES: Record<string, { provider: string; modelId: string }> = {
  sonnet: { provider: 'anthropic', modelId: 'claude-sonnet-4-20250514' },
  opus: { provider: 'anthropic', modelId: 'claude-opus-4-20250514' },
  haiku: { provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001' },
  'gpt-4o': { provider: 'openai', modelId: 'gpt-4o' },
  'gpt-4o-mini': { provider: 'openai', modelId: 'gpt-4o-mini' },
  'qwen3-max': { provider: 'dashscope', modelId: 'qwen3-max' },
}

export function resolveModel(
  modelStr: string | undefined,
  registry: RegistryLike,
): ModelLike | undefined {
  if (!modelStr) return undefined

  const slashIndex = modelStr.indexOf('/')
  if (slashIndex > 0) {
    const provider = modelStr.slice(0, slashIndex)
    const modelId = modelStr.slice(slashIndex + 1)
    return registry.getModel(provider, modelId) ?? undefined
  }

  const alias = MODEL_ALIASES[modelStr]
  if (alias) {
    return registry.getModel(alias.provider, alias.modelId) ?? undefined
  }

  return undefined
}
