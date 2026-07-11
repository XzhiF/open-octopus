// ponytail: browser-safe copy of resolveMoaModel from @octopus/shared.
// Avoids barrel import that pulls Node.js fs/child_process into client bundle.
// Keep in sync with packages/shared/src/config/moa-model-resolver.ts.

export interface MoaModelResolution {
  resolved: string
  degraded: boolean
  chain: string[]
}

interface TierConfig {
  default?: string
  providers: Record<string, Record<string, string>>
}

function isTierKey(model: string, config: TierConfig): boolean {
  return Object.values(config.providers).some(tierMap => model in tierMap)
}

function resolveAlias(
  model: string | undefined,
  providerType: string,
  config: TierConfig,
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

const TIER_HIERARCHY = ["pro-max", "pro", "se"] as const

export function resolveMoaModel(
  modelId: string,
  providerType: string,
  config: TierConfig,
): MoaModelResolution {
  if (isTierKey(modelId, config)) {
    const resolved = resolveAlias(modelId, providerType, config) ?? modelId
    return { resolved, degraded: false, chain: [modelId] }
  }

  const chain: string[] = [modelId]
  let current = modelId
  while (current.includes("-")) {
    current = current.substring(0, current.lastIndexOf("-"))
    chain.push(current)
    if (isTierKey(current, config)) {
      const resolved = resolveAlias(current, providerType, config) ?? current
      return { resolved, degraded: true, chain }
    }
  }

  for (const tier of TIER_HIERARCHY) {
    if (chain.includes(tier)) continue
    if (isTierKey(tier, config)) {
      chain.push(tier)
      const resolved = resolveAlias(tier, providerType, config) ?? tier
      return { resolved, degraded: true, chain }
    }
  }

  return { resolved: modelId, degraded: false, chain: [modelId] }
}
