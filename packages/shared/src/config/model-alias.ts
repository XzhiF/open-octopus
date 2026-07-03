import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import yaml from 'js-yaml'
import { ModelAliasConfigSchema, isModelTier } from '../types/model-alias'
import type { ModelAliasConfig } from '../types/model-alias'

export const BUILTIN_DEFAULTS: ModelAliasConfig = ModelAliasConfigSchema.parse({
  default: 'pro',
  providers: {
    pi: {
      'pro-max': 'anthropic/claude-opus-4-20250514',
      pro: 'anthropic/claude-sonnet-4-20250514',
      se: 'anthropic/claude-haiku-4-5-20251001',
    },
    claude: {
      'pro-max': 'opus',
      pro: 'sonnet',
      se: 'haiku',
    },
  },
})

/**
 * Resolve model alias: tier → real model name, non-tier → passthrough.
 */
export function resolveModelAlias(
  model: string | undefined,
  providerType: string,
  config: ModelAliasConfig,
): string | undefined {
  if (model === undefined) {
    const defaultTier = config.default
    return config.providers[providerType]?.[defaultTier] ?? defaultTier
  }
  if (!isModelTier(model)) return model
  return config.providers[providerType]?.[model] ?? model
}

/**
 * Load config: org-level → global → builtin defaults.
 * Missing or malformed files fall back gracefully.
 */
export function loadModelAliasConfig(org?: string): ModelAliasConfig {
  if (org) {
    const orgPath = join(homedir(), '.octopus', org, 'models.yaml')
    const parsed = tryLoadYamlConfig(orgPath)
    if (parsed) return mergeConfig(BUILTIN_DEFAULTS, parsed)
  }

  const globalPath = join(homedir(), '.octopus', 'models.yaml')
  const parsed = tryLoadYamlConfig(globalPath)
  if (parsed) return mergeConfig(BUILTIN_DEFAULTS, parsed)

  return BUILTIN_DEFAULTS
}

function mergeConfig(base: ModelAliasConfig, override: Partial<ModelAliasConfig>): ModelAliasConfig {
  const providers = { ...base.providers }
  if (override.providers) {
    for (const [key, value] of Object.entries(override.providers)) {
      providers[key] = { ...providers[key], ...value }
    }
  }
  return {
    default: override.default ?? base.default,
    providers,
  }
}

function tryLoadYamlConfig(path: string): Partial<ModelAliasConfig> | null {
  if (!existsSync(path)) return null
  try {
    const content = readFileSync(path, 'utf-8')
    const result = yaml.load(content)
    return ModelAliasConfigSchema.partial().parse(result)
  } catch {
    console.warn(`[model-alias] Failed to parse config at ${path}, using defaults`)
    return null
  }
}
