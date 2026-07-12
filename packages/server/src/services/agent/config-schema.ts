import { z } from 'zod'
import { KnowledgeConfigSchema } from '@octopus/shared'

// Allowed model list
export const ALLOWED_MODELS = [
  'pro-max', 'pro', 'se',
  'claude-opus-4-20250514', 'claude-sonnet-4-20250514',
  'claude-haiku-4-5-20251001'
] as const

// IANA timezone validation (simplified — checks common formats)
const ianaTimezoneRegex = /^[A-Z][a-z]+\/[A-Z][a-z_]+(?:\/[A-Z][a-z_]+)?$/

export const notificationProviderSchema = z.enum(['hermes', 'telegram', 'slack', 'email', 'none'])

export const agentConfigSchema = z.object({
  model: z.string().refine(v => ALLOWED_MODELS.includes(v as any), {
    message: `model must be one of: ${ALLOWED_MODELS.join(', ')}`
  }).default('pro-max'),
  timeout: z.number().int().min(30).max(1800).default(300),
  max_clones: z.number().int().min(1).max(20).default(5),
  notification: z.object({
    provider: notificationProviderSchema.default('hermes'),
    target: z.string().default(''),
    timezone: z.string().regex(ianaTimezoneRegex, 'Must be a valid IANA timezone').default('Asia/Shanghai'),
  }).default({}).superRefine((notification, ctx) => {
    // When provider is not 'none', validate target format if non-empty
    if (notification.provider !== 'none' && notification.target && notification.target.trim() !== '') {
      if (notification.provider === 'email') {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notification.target)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Invalid email address for notification target',
            path: ['target'],
          })
        }
      } else if (notification.provider === 'telegram') {
        if (!/^-?\d+$/.test(notification.target)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Telegram target must be a numeric chat ID',
            path: ['target'],
          })
        }
      } else if (notification.provider === 'slack') {
        if (!/^[C#][A-Z0-9]+$/.test(notification.target)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Slack target must be a channel ID (e.g., C0123ABC) or #channel-name',
            path: ['target'],
          })
        }
      } else {
        // For hermes/other providers: target must be provider:id format or a qualified identifier
        const providerPrefixRe = /^(telegram|slack|email|hermes|webhook):.+$/
        // Bare identifiers must contain at least one separator (_, -, .) to avoid ambiguity
        const qualifiedIdRe = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*[_.:-][a-zA-Z0-9_.:-]*$/
        if (!providerPrefixRe.test(notification.target) && !qualifiedIdRe.test(notification.target)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Notification target must use provider:id format (e.g., telegram:12345) or a qualified identifier',
            path: ['target'],
          })
        }
      }
    }
  }),
  memory: z.object({
    session_retention_days: z.number().int().min(30).max(365).default(90),
    archive_cron_hour: z.number().int().min(0).max(23).default(3),
    long_term_refine_trigger_days: z.number().int().min(1).max(30).default(7),
    session_compress_threshold_messages: z.number().int().min(10).max(500).default(50),
  }).default({}),
  knowledge: KnowledgeConfigSchema.optional(),
  safe_mode: z.object({
    enabled: z.boolean().default(false),
    inactive_days_threshold: z.number().int().min(7).max(90).default(14),
  }).default({}),
  debug: z.object({
    enabled: z.boolean().default(false),
  }).default({}),
  onboarding_completed: z.boolean().default(false),
  default_org: z.string().default(''),
  active_clone: z.string().default(''),
})

export type AgentConfigYaml = z.infer<typeof agentConfigSchema>
