import type { ModelAliasConfig } from './model-alias'
import { resolveModelAlias } from './model-alias'

export interface MoaModelResolution {
  resolved: string
  degraded: boolean
  chain: string[]
}

function isTierKey(model: string, config: ModelAliasConfig): boolean {
  return Object.values(config.providers).some(tierMap => model in tierMap)
}

const TIER_HIERARCHY = ['pro-max', 'pro', 'se'] as const

export function resolveMoaModel(
  modelId: string,
  providerType: string,
  config: ModelAliasConfig,
): MoaModelResolution {
  // Step 1: exact tier-key match
  if (isTierKey(modelId, config)) {
    const resolved = resolveModelAlias(modelId, providerType, config) ?? modelId
    return { resolved, degraded: false, chain: [modelId] }
  }

  // Step 2: suffix degradation — strip after last '-'
  const chain: string[] = [modelId]
  let current = modelId
  while (current.includes('-')) {
    current = current.substring(0, current.lastIndexOf('-'))
    chain.push(current)
    if (isTierKey(current, config)) {
      const resolved = resolveModelAlias(current, providerType, config) ?? current
      return { resolved, degraded: true, chain }
    }
  }

  // Step 3: fixed hierarchy fallback (pro-max → pro → se), skip already-tried
  for (const tier of TIER_HIERARCHY) {
    if (chain.includes(tier)) continue
    if (isTierKey(tier, config)) {
      chain.push(tier)
      const resolved = resolveModelAlias(tier, providerType, config) ?? tier
      return { resolved, degraded: true, chain }
    }
  }

  // Step 4: all miss — return original
  return { resolved: modelId, degraded: false, chain: [modelId] }
}
