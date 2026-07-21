import { z } from "zod"

// ExpertDefSchema — single expert definition within a swarm node
export const ExpertDefSchema = z.object({
  role: z.string(),
  agent_file: z.string().optional(),
  prompt: z.string().optional(),
  perspective: z.string().optional(),
  task: z.string().optional(),
  depends_on: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
  disallowed_tools: z.array(z.string()).optional(),
  model: z.string().optional(),
  engine: z.string().optional(),
  skills: z.array(z.string()).optional(),
}).refine(
  (data) => data.agent_file || data.prompt,
  { message: "Expert must declare at least one of agent_file or prompt" }
)

export type ExpertDef = z.infer<typeof ExpertDefSchema>

// Output format options
export const OutputFormatSchema = z.enum(["summary", "full", "structured"])

// StructuredOutputSchema for output_format: "structured"
export const StructuredOutputSchema = z.object({
  synthesis: z.string(),
  experts: z.array(z.object({ role: z.string(), opinion: z.string() })),
  disagreements: z.array(z.string()),
  recommendation: z.string(),
  confidence: z.number().min(0).max(1),
})

/**
 * Shared cross-field validation for swarm nodes.
 * Reused by both SwarmNodeDefSchema and NodeSchema (workflow.ts)
 * to avoid duplication and ensure consistent validation.
 */
export function validateSwarmConstraints(
  data: {
    mode?: string
    dynamic?: boolean
    experts?: Array<{ role: string; depends_on?: string[] }>
    expert_pool?: Array<{ role: string; depends_on?: string[] }>
    max_experts?: number
    rounds?: number
    aggregator?: unknown
  },
  ctx: z.RefinementCtx,
): void {
  // review mode (non-dynamic) needs at least 1 expert
  if (data.mode === "review" && !data.dynamic && (!data.experts || data.experts.length < 1)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "review mode requires at least 1 expert" })
  }
  // debate mode (non-dynamic) needs at least 2 experts
  if (data.mode === "debate" && !data.dynamic && (!data.experts || data.experts.length < 2)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "debate mode requires at least 2 experts" })
  }
  // moa mode (non-dynamic) needs at least 2 experts and aggregator
  if (data.mode === "moa" && !data.dynamic && (!data.experts || data.experts.length < 2)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "moa mode requires at least 2 experts" })
  }
  if (data.mode === "moa" && !data.aggregator) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "moa mode requires aggregator" })
  }
  // moa rounds 0-5
  if (data.mode === "moa" && data.rounds !== undefined && (data.rounds < 0 || data.rounds > 5)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "moa mode rounds must be 0-5" })
  }
  // debate/review rounds ≥ 1
  if ((data.mode === "debate" || data.mode === "review") && data.rounds !== undefined && data.rounds < 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "debate/review mode rounds must be ≥ 1" })
  }
  // depends_on reference validation
  if (data.experts) {
    const roles = new Set(data.experts.map(e => e.role))
    for (const expert of data.experts) {
      if (expert.depends_on) {
        for (const dep of expert.depends_on) {
          if (!roles.has(dep)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `depends_on references non-existent role "${dep}", available roles: [${[...roles].join(", ")}]` })
          }
        }
      }
    }
  }
  // dynamic must have max_experts
  if (data.dynamic && !data.max_experts) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "dynamic mode requires max_experts" })
  }
  // expert_pool constraints
  if (data.expert_pool) {
    const poolLen = data.expert_pool.length
    if (poolLen < 2) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "expert_pool requires at least 2 experts" })
    }
    if (data.max_experts && data.max_experts > poolLen) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `max_experts (${data.max_experts}) cannot exceed expert_pool size (${poolLen})` })
    }
    if (data.experts && data.experts.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "expert_pool and experts are mutually exclusive — use expert_pool for dynamic selection, experts for fixed roster" })
    }
  }
}

// SwarmNodeDefSchema
export const SwarmNodeDefSchema = z.object({
  type: z.literal("swarm"),
  topic: z.string(),
  mode: z.enum(["review", "debate", "dispatch", "swarm", "moa"]),
  experts: z.array(ExpertDefSchema).optional(),
  expert_pool: z.array(ExpertDefSchema).optional(),
  dynamic: z.boolean().optional(),
  max_experts: z.number().int().positive().optional(),
  rounds: z.number().int().nonnegative().optional(),
  consensus_threshold: z.number().min(0).max(1).optional(),
  budget: z.number().int().positive().optional(),
  timeout: z.number().int().positive().optional(),
  host: ExpertDefSchema.optional(),
  aggregator: ExpertDefSchema.optional(),
  failure_policy: z.enum(["fail_fast", "continue_partial", "retry_failed"]).optional(),
  output_format: OutputFormatSchema.optional(),
  outputs: z.record(z.string(), z.string()).optional(),
  expert_defaults: z.object({
    model: z.string().optional(),
    tools: z.array(z.string()).optional(),
    disallowed_tools: z.array(z.string()).optional(),
    skills: z.array(z.string()).optional(),
  }).optional(),
  context_window_rounds: z.number().int().positive().optional(),
  context_token_budget: z.number().int().positive().optional(),
  context_tier: z.enum(["200k", "1m"]).optional(),
}).superRefine((data, ctx) => {
  validateSwarmConstraints(data, ctx)
})

export type SwarmNodeDef = z.infer<typeof SwarmNodeDefSchema>
