import { z } from "zod"

const NotifyConfigSchema = z.object({
  email: z.string().optional(),
  on_failure: z.boolean().default(true),
})

const SchedulerRetryConfigSchema = z.object({
  max_attempts: z.number().int().min(1).max(10).default(3),
  backoff: z.enum(["fixed", "exponential"]).default("exponential"),
})

const TaskDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  cron: z.string().min(1),
  workflow: z.string().min(1),
  enabled: z.boolean().default(true),
  priority: z.enum(["high", "medium", "low"]).default("medium"),
  retry: SchedulerRetryConfigSchema.optional(),
  params: z.record(z.unknown()).optional(),
})

const GlobalConfigSchema = z.object({
  timezone: z.string().default("Asia/Shanghai"),
  max_concurrent_tasks: z.number().int().min(1).default(3),
  task_queue_size: z.number().int().min(1).default(10),
  notify: NotifyConfigSchema.optional(),
})

export const SchedulerConfigSchema = z.object({
  version: z.string().default("1.0"),
  global: GlobalConfigSchema.default({}),
  tasks: z.array(TaskDefinitionSchema).default([]),
  retire_protected: z.array(z.string()).default([]),
  evolution_scope: z.array(z.string()).default([]),
})

export type SchedulerConfig = z.infer<typeof SchedulerConfigSchema>
export type TaskDefinition = z.infer<typeof TaskDefinitionSchema>
export type SchedulerRetryConfig = z.infer<typeof SchedulerRetryConfigSchema>
export type SchedulerNotifyConfig = z.infer<typeof NotifyConfigSchema>

export function validateSchedulerConfig(data: unknown): SchedulerConfig {
  return SchedulerConfigSchema.parse(data)
}
