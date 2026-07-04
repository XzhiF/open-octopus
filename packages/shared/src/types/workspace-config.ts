import { z } from "zod"

export const WorkspaceConfigSchema = z.object({
  name: z.string(),
  repos: z.array(z.object({
    name: z.string(),
    group: z.string().optional(),
    main_path: z.string().optional(),
    worktree_path: z.string().optional(),
  })).optional(),
  resources: z.object({
    skills: z.array(z.string()).default([]),
    agents: z.array(z.string()).default([]),
    workflows: z.array(z.string()).default([]),
    sources: z.array(z.string()).default([]),
  }).optional(),
  created: z.string().optional(),
  init_branch_name: z.string().optional(),
}).passthrough()
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>
