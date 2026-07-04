import { z } from 'zod'
import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'

export const ModelTierMapSchema = z.record(z.string(), z.string())

export const ModelAliasConfigSchema = z.object({
  default: z.string().default('pro'),
  providers: z.record(z.string(), ModelTierMapSchema).default({}),
})

export type ModelAliasConfig = z.infer<typeof ModelAliasConfigSchema>

export const DEFAULT_MODEL_ALIASES: ModelAliasConfig = {
  default: 'pro',
  providers: {
    claude: {
      'pro-max': 'opus',
      pro: 'sonnet',
      se: 'haiku',
    },
    pi: {
      'pro-max': 'anthropic/claude-opus-4-20250514',
      pro: 'anthropic/claude-sonnet-4-20250514',
      se: 'anthropic/claude-haiku-4-5-20251001',
    },
    dashscope: {
      'pro-max': 'dashscope/qwen3.7-max',
      pro: 'dashscope/qwen3.7-plus',
      se: 'dashscope/qwen3.6-plus',
    },
  },
}

function isTierKey(model: string, config: ModelAliasConfig): boolean {
  return Object.values(config.providers).some(tierMap => model in tierMap)
}

export function resolveModelAlias(
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
  if (isTierKey(resolved, config)) return resolveModelAlias(resolved, providerType, config, depth + 1)
  return resolved
}

export function loadModelAliasConfig(opts?: {
  orgDir?: string
  globalDir?: string
}): ModelAliasConfig {
  const searchPaths = [
    opts?.orgDir && path.join(opts.orgDir, 'models.yaml'),
    opts?.globalDir && path.join(opts.globalDir, 'models.yaml'),
    path.join(process.env.HOME ?? '~', '.octopus', 'models.yaml'),
  ].filter(Boolean) as string[]

  for (const filePath of searchPaths) {
    const resolved = path.resolve(filePath)
    const homeDir = process.env.HOME ?? '~'
    if (!resolved.startsWith(homeDir) && !resolved.startsWith('/etc/') && !resolved.startsWith(process.cwd())) {
      console.warn(`[model-alias] Skipping suspicious path: ${resolved}`)
      continue
    }
    try {
      const content = fs.readFileSync(resolved, 'utf-8')
      const raw = yaml.load(content)
      const result = ModelAliasConfigSchema.safeParse(raw)
      if (result.success) {
        console.log(`[model-alias] Loaded config from ${resolved}`)
        return result.data
      }
      console.warn(`[model-alias] Warning: ${resolved} validation failed, using built-in defaults`)
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[model-alias] Warning: ${resolved} parse error, using built-in defaults`)
      }
    }
  }
  return DEFAULT_MODEL_ALIASES
}

interface NodeLike {
  id: string
  type: string
  engine?: string
  experts?: Array<{ name: string; engine?: string }>
}

export function collectNodeEngines(nodes: NodeLike[]): string[] {
  const engines = new Set<string>()
  for (const node of nodes) {
    if (node.type === 'agent' || node.type === 'swarm') {
      engines.add(node.engine ?? 'claude')
    }
    if (node.experts) {
      for (const expert of node.experts) {
        engines.add(expert.engine ?? 'claude')
      }
    }
  }
  if (engines.size === 0) engines.add('claude')
  return [...engines]
}
