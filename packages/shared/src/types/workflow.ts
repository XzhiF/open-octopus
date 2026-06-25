import { z } from "zod"
import { NotifyTemplateSchema, NotifyRetrySchema, NotifyProviderConfigSchema, ChannelProfileSchema } from "./notify"
import type { NotifyTemplate, NotifyRetryConfig } from "./notify"
import { ExpertDefSchema, OutputFormatSchema, validateSwarmConstraints } from "./swarm"
import type { ExpertDef } from "./swarm"


export const AutoAnswerSchema = z.object({
  pattern: z.string(),
  answer: z.string(),
})

export interface SubAgentDef {
  description: string
  prompt?: string
  agent_file?: string
  tools?: string[]
  disallowedTools?: string[]
  model?: string
  skills?: string[]
  maxTurns?: number
  background?: boolean
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | number
}

export const SubAgentDefSchema = z.object({
  description: z.string(),
  prompt: z.string().optional(),
  agent_file: z.string().optional(),
  tools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  model: z.string().optional(),
  skills: z.array(z.string()).optional(),
  maxTurns: z.number().int().positive().optional(),
  background: z.boolean().optional(),
  effort: z.union([z.enum(["low", "medium", "high", "xhigh", "max"]), z.number()]).optional(),
})

export const CaseSchema = z.object({
  when: z.string(),
  then: z.string(),
})

export const ApprovalOptionSchema = z.object({
  label: z.string(),
  value: z.string(),
})

export interface HookDef {
  id?: string
  type?: "agent" | "bash" | "notify"
  prompt?: string
  bash?: string
  timeout?: number
  model?: string
  engine?: string
  nodes?: string[]
  condition?: string
  // Notify-specific fields
  channel?: string | string[]
  template?: NotifyTemplate
  on_failure?: "log" | "retry" | "abort"
  retry?: NotifyRetryConfig
}

export const HookSchema = z.object({
  id: z.string().optional(),
  type: z.enum(["agent", "bash", "notify"]).default("agent"),
  prompt: z.string().optional(),
  bash: z.string().optional(),
  timeout: z.number().int().positive().optional(),
  model: z.string().optional(),
  engine: z.string().optional(),
  nodes: z.array(z.string()).optional(),
  condition: z.string().optional(),
  channel: z.union([z.string(), z.array(z.string())]).optional(),
  template: NotifyTemplateSchema.optional(),
  on_failure: z.enum(["log", "retry", "abort"]).optional(),
  retry: NotifyRetrySchema.optional(),
})

export interface WorkflowHooks {
  on_node_success?: HookDef[]
  on_node_failure?: HookDef[]
  on_workflow_failure?: HookDef[]
  on_cancel?: HookDef[]
  on_interrupt?: HookDef[]
  on_retry?: HookDef[]
  on_success?: HookDef[]
  on_complete?: HookDef[]
  // swarm lifecycle hooks
  on_swarm_start?: HookDef[]
  on_expert_spawn?: HookDef[]
  on_expert_complete?: HookDef[]
  on_swarm_round_end?: HookDef[]
  on_swarm_consensus?: HookDef[]
  on_swarm_complete?: HookDef[]
}

export const WorkflowHooksSchema = z.object({
  on_node_success: z.array(HookSchema).optional(),
  on_node_failure: z.array(HookSchema).optional(),
  on_workflow_failure: z.array(HookSchema).optional(),
  on_cancel: z.array(HookSchema).optional(),
  on_interrupt: z.array(HookSchema).optional(),
  on_retry: z.array(HookSchema).optional(),
  on_success: z.array(HookSchema).optional(),
  on_complete: z.array(HookSchema).optional(),
  // swarm lifecycle hooks
  on_swarm_start: z.array(HookSchema).optional(),
  on_expert_spawn: z.array(HookSchema).optional(),
  on_expert_complete: z.array(HookSchema).optional(),
  on_swarm_round_end: z.array(HookSchema).optional(),
  on_swarm_consensus: z.array(HookSchema).optional(),
  on_swarm_complete: z.array(HookSchema).optional(),
})

export interface PlanningDef {
  max_turns?: number
  verify?: boolean
  tools?: string[]
  disallowed_tools?: string[]
}

export const PlanningSchema = z.object({
  max_turns: z.number().int().positive().optional(),
  verify: z.boolean().optional(),
  tools: z.array(z.string()).optional(),
  disallowed_tools: z.array(z.string()).optional(),
})

export interface NodeDef {
  id: string
  type: "bash" | "python" | "agent" | "condition" | "approval" | "loop" | "swarm"
  model?: string
  engine?: string
  timeout?: number
  depends_on?: string[]
  execute_when?: string
  outputs?: Record<string, string>

  // bash
  bash?: string

  // python
  python?: string
  inputs?: Record<string, string>

  // agent
  agent?: string
  skills?: string[]
  prompt?: string
  context?: "new" | "continue"
  resume_from?: string
  auto_answers?: AutoAnswer[]
  agents?: Record<string, SubAgentDef>

  // Agent goal mode (Upgrade 1)
  goal?: string
  constraints?: string[]
  planning?: PlanningDef

  // condition
  cases?: CaseDef[]

  // approval
  options?: ApprovalOption[]
  approval_timeout?: number
  on_reject?: string

  // loop
  while?: string
  break_when?: string
  continue_when?: string
  max_iterations?: number
  nodes?: NodeDef[]

  // swarm
  topic?: string
  mode?: "review" | "debate" | "dispatch" | "swarm"
  experts?: Array<{
    role: string
    agent_file?: string
    prompt?: string
    perspective?: string
    task?: string
    depends_on?: string[]
    tools?: string[]
    disallowed_tools?: string[]
    model?: string
  }>
  dynamic?: boolean
  max_experts?: number
  rounds?: number
  consensus_threshold?: number
  budget?: number
  host?: ExpertDef
  failure_policy?: "fail_fast" | "continue_partial" | "retry_failed"
  output_format?: "summary" | "full" | "structured"
  expert_defaults?: {
    model?: string
    tools?: string[]
    disallowed_tools?: string[]
  }
  context_window_rounds?: number
  context_token_budget?: number
  context_tier?: "200k" | "1m"

  // 通用桶 — 不属于上述分类的任意数据
  variables?: Record<string, unknown>
}

export const NodeSchema: z.ZodType<NodeDef> = z.lazy(() =>
  z.object({
    id: z.string(),
    type: z.enum(["bash", "python", "agent", "condition", "approval", "loop", "swarm"]),
    model: z.string().optional(),
    engine: z.string().optional(),
    timeout: z.number().int().positive().optional(),
    depends_on: z.array(z.string()).optional(),
    execute_when: z.string().optional(),
    outputs: z.record(z.string(), z.string()).optional(),

    bash: z.string().optional(),
    python: z.string().optional(),
    inputs: z.record(z.string(), z.string()).optional(),

    agent: z.string().optional(),
    skills: z.array(z.string()).optional(),
    prompt: z.string().optional(),
    context: z.enum(["new", "continue"]).optional(),
    resume_from: z.string().optional(),
    auto_answers: z.array(AutoAnswerSchema).optional(),
    agents: z.record(z.string(), SubAgentDefSchema).optional(),

    goal: z.string().optional(),
    constraints: z.array(z.string()).optional(),
    planning: PlanningSchema.optional(),

    cases: z.array(CaseSchema).optional(),

    options: z.array(ApprovalOptionSchema).optional(),
    approval_timeout: z.number().int().positive().optional(),
    on_reject: z.string().optional(),

    while: z.string().optional(),
    break_when: z.string().optional(),
    continue_when: z.string().optional(),
    max_iterations: z.number().int().positive().optional(),
    nodes: z.array(NodeSchema).optional(),

    // swarm
    topic: z.string().optional(),
    mode: z.enum(["review", "debate", "dispatch", "swarm"]).optional(),
    experts: z.array(ExpertDefSchema).optional(),
    dynamic: z.boolean().optional(),
    max_experts: z.number().int().positive().optional(),
    rounds: z.number().int().positive().optional(),
    consensus_threshold: z.number().min(0).max(1).optional(),
    budget: z.number().int().positive().optional(),
    host: ExpertDefSchema.optional(),
    failure_policy: z.enum(["fail_fast", "continue_partial", "retry_failed"]).optional(),
    output_format: OutputFormatSchema.optional(),
    expert_defaults: z.object({
      model: z.string().optional(),
      tools: z.array(z.string()).optional(),
      disallowed_tools: z.array(z.string()).optional(),
    }).optional(),
    context_window_rounds: z.number().int().positive().optional(),
    context_token_budget: z.number().int().positive().optional(),
    context_tier: z.enum(["200k", "1m"]).optional(),

    variables: z.record(z.string(), z.unknown()).optional(),
  }).superRefine((data, ctx) => {
    // Swarm cross-field validations (only for type: "swarm")
    if (data.type !== "swarm") return
    validateSwarmConstraints(data, ctx)
  })
)

export const WorkflowInputSchema = z.object({
  description: z.string(),
  required: z.boolean().default(false),
  default: z.string().default(""),
})

export const WorkflowSchema = z.object({
  apiVersion: z.string().regex(/^octopus\/v\d+$/, "apiVersion must match octopus/v{number}"),
  kind: z.literal("Workflow"),
  name: z.string(),
  description: z.string().optional(),
  model: z.string().optional(),
  engine: z.string().optional(),
  timeout: z.number().int().positive().optional(),
  execution_mode: z.enum(["auto", "serial"]).default("auto"),
  max_concurrent: z.number().int().positive().optional(),
  variables: z.record(z.string(), z.unknown()).optional(),
  auto_answers: z.array(AutoAnswerSchema).optional(),
  inputs: z.record(WorkflowInputSchema).optional(),
  hooks: WorkflowHooksSchema.optional(),
  providers: z.record(z.string(), NotifyProviderConfigSchema).optional(),
  channels: z.record(z.string(), ChannelProfileSchema).optional(),
  nodes: z.array(NodeSchema),
})

export type WorkflowDef = z.infer<typeof WorkflowSchema>
export type AutoAnswer = z.infer<typeof AutoAnswerSchema>
export type SubAgentDefType = z.infer<typeof SubAgentDefSchema>
export type CaseDef = z.infer<typeof CaseSchema>
export type ApprovalOption = z.infer<typeof ApprovalOptionSchema>
export type WorkflowInput = z.infer<typeof WorkflowInputSchema>