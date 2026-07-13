// ponytail: standalone module — no runtime imports from model-alias (which uses fs).
// Browser-safe: "use client" components can import this without pulling Node.js builtins.
import type { ModelAliasConfig } from './model-alias'

export interface MoaModelResolution {
  resolved: string
  degraded: boolean
  chain: string[]
}

function isTierKey(model: string, config: ModelAliasConfig): boolean {
  return Object.values(config.providers).some(tierMap => model in tierMap)
}

// Inlined from model-alias.ts to avoid transitive fs/path imports.
// Pure logic, no side effects.
function resolveAlias(
  model: string | undefined,
  providerType: string,
  config: ModelAliasConfig,
  depth = 0,
): string | undefined {
  if (depth > 3) return model
  const effective = model ?? config.default
  if (!isTierKey(effective, config)) return effective
  const resolved = config.providers[providerType]?.[effective]
  if (!resolved) return effective
  if (isTierKey(resolved, config)) return resolveAlias(resolved, providerType, config, depth + 1)
  return resolved
}

const TIER_HIERARCHY = ['pro-max', 'pro', 'se'] as const

export function resolveMoaModel(
  modelId: string,
  providerType: string,
  config: ModelAliasConfig,
): MoaModelResolution {
  // Step 1: exact tier-key match
  if (isTierKey(modelId, config)) {
    const resolved = resolveAlias(modelId, providerType, config) ?? modelId
    // M8 fix: if resolveAlias returned a tier key (not a real model), treat as unresolved
    if (resolved !== modelId && !isTierKey(resolved, config)) {
      return { resolved, degraded: false, chain: [modelId] }
    }
    if (!isTierKey(resolved, config)) {
      return { resolved, degraded: false, chain: [modelId] }
    }
    // resolved is still a tier key — provider has no mapping, fall through to degradation
  }

  // Step 2: suffix degradation — strip after last '-'
  const chain: string[] = [modelId]
  let current = modelId
  while (current.includes('-')) {
    current = current.substring(0, current.lastIndexOf('-'))
    chain.push(current)
    if (isTierKey(current, config)) {
      const resolved = resolveAlias(current, providerType, config) ?? current
      return { resolved, degraded: true, chain }
    }
  }

  // Step 3: fixed hierarchy fallback (pro-max → pro → se), skip already-tried
  for (const tier of TIER_HIERARCHY) {
    if (chain.includes(tier)) continue
    if (isTierKey(tier, config)) {
      chain.push(tier)
      const resolved = resolveAlias(tier, providerType, config) ?? tier
      return { resolved, degraded: true, chain }
    }
  }

  // Step 4: all miss — return original
  return { resolved: modelId, degraded: false, chain: [modelId] }
}
