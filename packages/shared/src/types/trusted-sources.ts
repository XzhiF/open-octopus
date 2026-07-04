import { z } from "zod"

const TrustSourceEntrySchema = z.object({
  protocol: z.enum(["npm", "github", "local", "builtin"]),
  package: z.string().optional(),
  repo: z.string().optional(),
  id: z.string().optional(),
  trusted_at: z.string(),
})
export type TrustSourceEntry = z.infer<typeof TrustSourceEntrySchema>

const BlockedSourceEntrySchema = z.object({
  protocol: z.enum(["npm", "github"]),
  package: z.string().optional(),
  repo: z.string().optional(),
  reason: z.string(),
  blocked_at: z.string(),
})
export type BlockedSourceEntry = z.infer<typeof BlockedSourceEntrySchema>

export const TrustedSourcesSchema = z.object({
  version: z.literal(1),
  trusted: z.array(TrustSourceEntrySchema).default([]),
  blocked: z.array(BlockedSourceEntrySchema).default([]),
})
export type TrustedSources = z.infer<typeof TrustedSourcesSchema>
