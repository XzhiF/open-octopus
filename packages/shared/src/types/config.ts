import { z } from "zod"

export const OrgConfigSchema = z.object({
  name: z.string(),
  prefix: z.string().default(""),
  description: z.string().default(""),
  platform: z.string().default("gitlab"),
  groups: z.array(z.string()).default([]),
  clone_base: z.string().optional(),
})

export const GlobalConfigSchema = z.object({
  default_org: z.string().default(""),
})

export const ProjectConfigSchema = z.object({
  org: z.string().optional(),
})

export type OrgConfig = z.infer<typeof OrgConfigSchema>
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>