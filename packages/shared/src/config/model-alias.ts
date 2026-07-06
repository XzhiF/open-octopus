import { z } from 'zod'
import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'

export const ModelTierMapSchema = z.record(z.string(), z.string())

const CustomModelSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  context_window: z.number().default(32768),
  max_tokens: z.number().default(8192),
  reasoning: z.boolean().default(false),
  cost: z.object({
    input: z.number().default(0),
    output: z.number().default(0),
    cacheRead: z.number().default(0),
    cacheWrite: z.number().default(0),
  }).default({}),
})

const CustomProviderSchema = z.object({
  base_url: z.string(),
  api: z.string().default('openai-completions'),
  env_key: z.string().optional(),
  models: z.array(CustomModelSchema).min(1),
})

export const CustomProvidersMapSchema = z.record(z.string(), CustomProviderSchema)
export type CustomProviderDef = z.infer<typeof CustomProviderSchema>
export type CustomProvidersMap = z.infer<typeof CustomProvidersMapSchema>

export const ModelAliasConfigSchema = z.object({
  default: z.string().default('pro'),
  providers: z.record(z.string(), ModelTierMapSchema).default({}),
  custom_providers: CustomProvidersMapSchema.default({}),
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
      'pro-max': 'dashscope/qwen3.7-max',
      pro: 'dashscope/qwen3.7-plus',
      se: 'dashscope/qwen3.6-plus',
    },
  },
  custom_providers: {},
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
