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

// 预设层条目（ADR-0015 §model_presets, 2026-08-30）：与 CustomModelSchema 同形但全部字段可缺省——
// 缺省即"不供给该字段"。必须无 default，否则继承判定与默认值无法区分。
export const ModelPresetSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  context_window: z.number().optional(),
  max_tokens: z.number().optional(),
  reasoning: z.boolean().optional(),
  cost: z.object({
    input: z.number().optional(),
    output: z.number().optional(),
    cacheRead: z.number().optional(),
    cacheWrite: z.number().optional(),
  }).optional(),
})
export type ModelPreset = z.infer<typeof ModelPresetSchema>

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
  // 模型预设层（id 可为裸 model 名或 provider/model）：custom 条目缺省字段的供给源，
  // 兼作定价裸键终审者。见 ADR-0015 §model_presets。
  model_presets: z.array(ModelPresetSchema).default([]),
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
  model_presets: [],
}

/**
 * raw 层预设继承（在 zod parse 之前执行）：CustomModelSchema 字段全带 default，
 * parse 后无法区分「没配」与「配了 0」——只有 raw 对象的 hasOwnProperty 是"没配"
 * 的精确语义。因此继承直接在 yaml 原始结构上做：
 *   custom_providers[<p>].models[<id>] 的缺失字段 ←
 *     ① model_presets 里 id 为 "<p>/<id>" 的前缀预设（厂商级）
 *     ② 否则 id 为 "<id>" 的裸名预设（跨商通用）
 * cost 块逐字段合并（条目已有字段优先）。
 */
export function applyModelPresets(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw
  const cfg = raw as Record<string, unknown>
  const presets = Array.isArray(cfg.model_presets) ? cfg.model_presets as Array<Record<string, unknown>> : []
  if (presets.length === 0) return raw
  const prefixMap = new Map<string, Record<string, unknown>>()
  const bareMap = new Map<string, Record<string, unknown>>()
  for (let i = 0; i < presets.length; i++) {
    const p0 = presets[i]
    if (!p0 || typeof p0.id !== 'string') continue
    let p = p0
    const pid = p0.id
    // 半块 cost 若在继承时流入条目，会被 parse 的 .default(0) 补齐成"output 免费"的
    // 半假价——不完整块在收集端即剔除（其余字段照常继承），与 buildOverlay 同律。
    if (p.cost && typeof p.cost === 'object') {
      const c = p.cost as Record<string, unknown>
      const incomplete = ['input', 'output', 'cacheRead', 'cacheWrite'].some((k) => typeof c[k] !== 'number')
      if (incomplete) {
        console.warn(`[model-alias] model_presets "${pid}" 的 cost 块不完整（需四字段），该价不参与继承`)
        p = { ...p, cost: undefined }
        presets[i] = p
      }
    }
    const key = pid.trim().toLowerCase()
    if (key.includes('/')) prefixMap.set(key, p)
    else bareMap.set(key, p)
  }
  const cps = cfg.custom_providers
  if (!cps || typeof cps !== 'object') return cfg
  for (const [pname, pdef] of Object.entries(cps as Record<string, unknown>)) {
    const models = (pdef as Record<string, unknown> | undefined)?.models
    if (!Array.isArray(models)) continue
    for (const entry of models) {
      const entryId = (entry as Record<string, unknown> | null)?.id
      if (!entry || typeof entryId !== 'string') continue
      const e = entry as Record<string, unknown>
      const eid = entryId.trim().toLowerCase()
      const preset = prefixMap.get(`${pname.trim().toLowerCase()}/${eid}`) ?? bareMap.get(eid)
      if (!preset) continue
      for (const [field, value] of Object.entries(preset)) {
        if (field === 'id' || field === 'name') continue
        if (field === 'cost' && typeof value === 'object' && value !== null) {
          // cost 逐字段合并：条目已写的字段优先
          const mergedCost = { ...(value as Record<string, unknown>), ...((e.cost ?? {}) as Record<string, unknown>) }
          e.cost = mergedCost
          continue
        }
        if (!(field in e)) e[field] = value
      }
    }
  }
  return cfg
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
      const result = ModelAliasConfigSchema.safeParse(applyModelPresets(raw))
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
