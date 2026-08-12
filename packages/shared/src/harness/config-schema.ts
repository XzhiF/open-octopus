import { z } from "zod"

/**
 * DetectorConfig schema — per-detector settings
 */
export const DetectorConfigSchema = z
  .object({
    enabled: z.boolean(),
    threshold: z.number().int().positive().optional(),
  })
  .passthrough()

/**
 * StrategyAction schema — a single action in a strategy
 */
export const StrategyActionSchema = z
  .object({
    type: z.string(),
    message: z.string().optional(),
    prefer: z.string().optional(),
    reason: z.string().optional(),
    notify: z.boolean().optional(),
  })
  .passthrough()

/**
 * StrategyConfig schema — one entry in the strategies array
 */
export const StrategyConfigSchema = z.object({
  match: z.string(),
  severity: z.enum(["info", "warning", "critical"]).optional(),
  actions: z.array(StrategyActionSchema),
  delegate_to_agent: z.boolean().optional(),
})

/**
 * IsolationConfig schema — process isolation settings
 */
export const IsolationConfigSchema = z.object({
  process_group: z.boolean().default(true),
  port_protection: z.boolean().default(true),
  pid_protection: z.boolean().default(true),
  sandbox: z
    .enum(["auto", "seatbelt", "bubblewrap", "wrapper", "disabled"])
    .default("auto"),
  fs_whitelist: z.array(z.string()).default([".", "/tmp"]),
})

/**
 * HarnessSystemConfigSchema — top-level schema for harness.yaml.
 * Named "System" to distinguish from the per-node HarnessConfig in octopus-agent.ts.
 */
export const HarnessSystemConfigSchema = z.object({
  detectors: z.record(z.string(), DetectorConfigSchema).default({}),
  strategies: z.array(StrategyConfigSchema).default([]),
  isolation: IsolationConfigSchema.optional(),
})

export type HarnessSystemConfigParsed = z.infer<typeof HarnessSystemConfigSchema>
