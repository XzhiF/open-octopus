import { z } from 'zod'

export const ModelTierSchema = z.enum(['pro-max', 'pro', 'se'])
export type ModelTier = z.infer<typeof ModelTierSchema>

export const ModelAliasConfigSchema = z.object({
  default: ModelTierSchema.default('pro'),
  providers: z.record(z.string(), z.record(z.string(), z.string())).default({}),
})
export type ModelAliasConfig = z.infer<typeof ModelAliasConfigSchema>

const TIERS = new Set<string>(['pro-max', 'pro', 'se'])

export function isModelTier(model: string): boolean {
  return TIERS.has(model)
}
