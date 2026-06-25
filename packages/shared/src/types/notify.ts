// packages/shared/src/types/notify.ts
import { z } from "zod"

// ── Zod Schemas ──

export const NotifyProviderConfigSchema = z.object({
  type: z.string(),
  timeout: z.number().int().positive().default(15),
  min_severity: z.enum(["info", "warn", "error"]).default("info"),
  cli_path: z.string().optional(),
  url: z.string().optional(),
  method: z.enum(["POST", "PUT"]).default("POST"),
  headers: z.record(z.string(), z.string()).optional(),
})

export const ChannelProfileSchema = z.object({
  provider: z.string(),
  target: z.string().optional(),
  url: z.string().optional(),
  min_severity: z.enum(["info", "warn", "error"]).optional(),
})

export const NotifyTemplateSchema = z.object({
  severity: z.enum(["info", "warn", "error"]).default("info"),
  title: z.string(),
  body: z.string().optional(),
})

export type NotifyTemplate = z.infer<typeof NotifyTemplateSchema>

export const NotifyRetrySchema = z.object({
  max_attempts: z.number().int().min(1).max(10).default(1),
  delay: z.number().min(0).max(60).default(1),
})

// ── Inferred types from schemas ──

export type NotifyProviderConfig = z.infer<typeof NotifyProviderConfigSchema>
export type ChannelProfile = z.infer<typeof ChannelProfileSchema>
export type NotifyRetryConfig = z.infer<typeof NotifyRetrySchema>

// ── Runtime types (used by Provider implementations) ──

export interface NotifyMessage {
  severity: "info" | "warn" | "error"
  title: string
  body: string
}

export interface NotifyResult {
  success: boolean
  provider: string
  channel: string
  durationMs: number
  error?: string
  metadata?: Record<string, unknown>
}

export interface NotifySendConfig {
  target?: string
  url?: string
  timeout: number
  method?: string
  headers?: Record<string, string>
  cliPath?: string
}

export interface NotifyProvider {
  readonly name: string
  readonly type: string
  send(message: NotifyMessage, config: NotifySendConfig): Promise<NotifyResult>
}
