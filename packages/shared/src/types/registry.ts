import { z } from "zod"
import { ResourceTypeSchema, SourceRefSchema } from "./resource-manifest"

export const RegistryEntrySchema = z.object({
  name: z.string(),
  type: ResourceTypeSchema,
  version: z.string().default("0.0.0"),
  source: SourceRefSchema,
  hash: z.string(),
  description: z.string().max(500).default(""),
  tags: z.array(z.string()).default([]),
  dependencies: z.array(z.object({
    name: z.string(),
    type: ResourceTypeSchema,
    optional: z.boolean().default(false),
  })).default([]),
  size: z.number().optional(),
  manifest_path: z.string(),
  cache_path: z.string(),
  registered_at: z.string(),
  _updated_at: z.string().optional(),
})
export type RegistryEntry = z.infer<typeof RegistryEntrySchema>

export const RegistrySchema = z.object({
  version: z.literal(1),
  updated_at: z.string(),
  entries: z.record(z.string(), RegistryEntrySchema),
})
export type Registry = z.infer<typeof RegistrySchema>
