import { z } from "zod"
import { ResourceTypeSchema, SourceRefSchema } from "./resource-manifest"

export const LockResourceEntrySchema = z.object({
  name: z.string(),
  type: ResourceTypeSchema,
  hash: z.string().regex(/^[a-f0-9]{12}$/, "12 位十六进制哈希"),
  source: SourceRefSchema,
  installed_at: z.string(),
  target: z.string(),
  installed_by: z.enum(["human", "agent"]).default("human"),
})
export type LockResourceEntry = z.infer<typeof LockResourceEntrySchema>

export const LockFileSchema = z.object({
  version: z.literal(1),
  generated_at: z.string(),
  resources: z.array(LockResourceEntrySchema).default([]),
  integrity: z.string().nullable().optional(),
})
export type LockFile = z.infer<typeof LockFileSchema>
