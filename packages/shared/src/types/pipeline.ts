import { z } from "zod"
import { HookSchema } from "./workflow"
import { NotifyProviderConfigSchema, ChannelProfileSchema } from "./notify"

export const BackoffTypeSchema = z.enum(["fixed", "exponential", "linear"])

export const BackoffSchema = z.object({
  type: BackoffTypeSchema.default("exponential"),
  initial_delay: z.number().int().min(0).max(3600).default(5),
  multiplier: z.number().min(1).max(10).default(2),
  increment: z.number().int().min(0).max(3600).default(5),
  max_delay: z.number().int().min(0).max(7200).default(300),
})

export const RetryOnConditionSchema = z.enum([
  "exit_code_nonzero",
  "timeout",
  "agent_stream_error",
  "transient_error",
  "agent_partial_completion",
  "approval_rejected",
  "user_cancelled",
  "config_error",
])

export const RetryPolicySchema = z.object({
  max_attempts: z.number().int().min(1).max(100).default(1),
  backoff: BackoffSchema.default({}),
  max_total_duration: z.number().int().min(0).max(86400).default(0),
  retry_on: z.array(RetryOnConditionSchema).default([
    "exit_code_nonzero",
    "timeout",
    "agent_stream_error",
    "transient_error",
  ]),
  never_retry_on: z.array(RetryOnConditionSchema).default([
    "approval_rejected",
    "user_cancelled",
    "config_error",
  ]),
})

export const RetryConfigSchema = z.object({
  default: RetryPolicySchema.default({}),
  overrides: z.record(z.string(), RetryPolicySchema.partial()).default({}),
})

export const FailureStrategySchema = z.enum(["fail_fast", "continue", "skip"])

export const ResumeOnInterruptSchema = z.enum(["manual", "auto"])

export const ExecutionConfigSchema = z.object({
  failure_strategy: FailureStrategySchema.default("fail_fast"),
  timeout: z.number().int().min(0).max(604800).default(86400),
  max_concurrent: z.number().int().min(0).max(1000).default(0),
  resume_on_interrupt: ResumeOnInterruptSchema.default("manual"),
  auto_resume_max_attempts: z.number().int().min(1).max(50).default(3),
  auto_resume_delay: z.number().int().min(0).max(3600).default(10),
  pending_resume_timeout: z.number().int().min(0).max(86400).default(600),
})

export const ForkPathStrategySchema = z.enum(["all", "primary"])
export const ForkMergeStrategySchema = z.enum(["wait_all", "wait_any", "first_complete"])
export const ForkFailureHandlingSchema = z.enum(["fail_all", "best_effort"])

export const ForkConfigSchema = z.object({
  path_strategy: ForkPathStrategySchema.default("all"),
  merge_strategy: ForkMergeStrategySchema.default("wait_all"),
  failure_handling: ForkFailureHandlingSchema.default("fail_all"),
})

export const CheckpointSaveOnSchema = z.enum(["per-node", "per-level", "per-batch"])

export const CheckpointConfigSchema = z.object({
  enabled: z.boolean().default(true),
  save_on: CheckpointSaveOnSchema.default("per-node"),
  max_checkpoints: z.number().int().min(1).max(1000).default(10),
  ttl: z.number().int().min(0).max(2592000).default(86400),
  max_size_bytes: z.number().int().min(0).max(104857600).default(1048576),
})

export const RuntimeNodeSchema = z.object({
  id: z.string(),
  type: z.enum(['bash', 'python', 'agent']),
  bash: z.string().optional(),
  python: z.string().optional(),
  prompt: z.string().optional(),
  agent: z.string().optional(),
  depends_on: z.array(z.string()).optional(),
  execute_when: z.string().optional(),
  timeout: z.number().int().positive().optional(),
})

// ── Chain Execution v2 schemas (from PR #43) ──

export const ChainConfigSchema = z.object({
  auto_execute: z.boolean().default(true),
  failure_strategy: z.enum(["stop", "continue", "retry_leaf"]).default("stop"),
  on_success: z.enum(["continue", "stop"]).default("continue"),
  config_change_strategy: z.enum(["snapshot", "abort"]).default("snapshot"),
})
export type ChainConfig = z.infer<typeof ChainConfigSchema>

export const TargetedPromptSchema = z.object({
  workflow: z.string(),
  node: z.string(),
  prompt: z.string(),
})
export type TargetedPrompt = z.infer<typeof TargetedPromptSchema>

export const PromptsConfigSchema = z.object({
  global: z.array(z.string()).default([]),
  targeted: z.array(TargetedPromptSchema).default([]),
})
export type PromptsConfig = z.infer<typeof PromptsConfigSchema>

export const PipelineHooksSchema = z.object({
  on_node_success: z.array(HookSchema).default([]),
  on_node_failure: z.array(HookSchema).default([]),
  on_workflow_failure: z.array(HookSchema).default([]),
  on_cancel: z.array(HookSchema).default([]),
  on_interrupt: z.array(HookSchema).default([]),
  on_retry: z.array(HookSchema).default([]),
  on_success: z.array(HookSchema).default([]),
  on_complete: z.array(HookSchema).default([]),
})
export type PipelineHooks = z.infer<typeof PipelineHooksSchema>

export const ChainRetrySchema = z.object({
  max_attempts: z.number().int().min(1).default(2),
  backoff: BackoffSchema.extend({
    initial_delay: z.number().min(0).default(10),
    max_delay: z.number().min(0).default(600),
  }),
  on_chain_failure: z.enum(["stop", "skip_failed"]).default("stop"),
})
export type ChainRetry = z.infer<typeof ChainRetrySchema>

// ── Pipeline Config (v2 with chain support) ──

export const PipelineConfigSchema = z.object({
  apiVersion: z.string().regex(/^octopus\/v\d+$/, "apiVersion must match octopus/v{number}"),
  kind: z.literal("Pipeline"),
  description: z.string().optional(),
  chain: ChainConfigSchema.optional(),
  prompts: PromptsConfigSchema.optional(),
  hooks: PipelineHooksSchema.optional(),
  execution: ExecutionConfigSchema.default({}),
  retry: RetryConfigSchema.default({}),
  chain_retry: ChainRetrySchema.optional(),
  fork: ForkConfigSchema.default({}),
  checkpoint: CheckpointConfigSchema.default({}),
  runtime_nodes: z.array(RuntimeNodeSchema).default([]),
  providers: z.record(z.string(), NotifyProviderConfigSchema).default({}),
  channels: z.record(z.string(), ChannelProfileSchema).default({}),
})

export type PipelineConfig = z.infer<typeof PipelineConfigSchema>
export type RuntimeNode = z.infer<typeof RuntimeNodeSchema>
export type RetryPolicy = z.infer<typeof RetryPolicySchema>
export type RetryConfig = z.infer<typeof RetryConfigSchema>
export type Backoff = z.infer<typeof BackoffSchema>
export type FailureStrategy = z.infer<typeof FailureStrategySchema>
export type ForkPathStrategy = z.infer<typeof ForkPathStrategySchema>
export type ForkMergeStrategy = z.infer<typeof ForkMergeStrategySchema>
export type ForkFailureHandling = z.infer<typeof ForkFailureHandlingSchema>
export type ForkConfig = z.infer<typeof ForkConfigSchema>
export type CheckpointConfig = z.infer<typeof CheckpointConfigSchema>
export type ExecutionConfig = z.infer<typeof ExecutionConfigSchema>
export type RetryOnCondition = z.infer<typeof RetryOnConditionSchema>

// Pipeline v1 (backward compatible)
export const PipelineConfigV1Schema = z.object({
  apiVersion: z.literal("octopus/v1"),
  kind: z.literal("Pipeline"),
  execution: ExecutionConfigSchema.optional(),
  retry: RetryConfigSchema.optional(),
  fork: ForkConfigSchema.optional(),
  checkpoint: CheckpointConfigSchema.optional(),
  runtime_nodes: z.array(RuntimeNodeSchema).optional(),
  providers: z.record(z.string(), NotifyProviderConfigSchema).default({}),
  channels: z.record(z.string(), ChannelProfileSchema).default({}),
})
export type PipelineConfigV1 = z.infer<typeof PipelineConfigV1Schema>
