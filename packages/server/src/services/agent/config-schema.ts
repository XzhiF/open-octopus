import { z } from 'zod'
import { KnowledgeConfigSchema } from '@octopus/shared'

// Allowed model list (bare identifiers for legacy/flat format)
export const ALLOWED_MODELS = [
  'pro-max', 'pro', 'se',
  'claude-opus-4-20250514', 'claude-sonnet-4-20250514',
  'claude-haiku-4-5-20251001'
] as const

// Accept both bare identifiers and engine/alias format (e.g. "claude/pro")
const MODEL_PATTERN = /^(?:[a-z][a-z0-9-]*\/)?[a-z][a-z0-9._-]*$/i
function isValidModel(v: string): boolean {
  if (ALLOWED_MODELS.includes(v as any)) return true
  return MODEL_PATTERN.test(v) && v.includes('/')
}

// IANA timezone validation (simplified — checks common formats)
const ianaTimezoneRegex = /^[A-Z][a-z]+\/[A-Z][a-z_]+(?:\/[A-Z][a-z_]+)?$/

export const notificationPlatformSchema = z.enum(['telegram', 'discord', 'slack', 'signal', 'email', 'none'])

export const agentConfigSchema = z.object({
  model: z.string().refine(isValidModel, {
    message: `model must be one of: ${ALLOWED_MODELS.join(', ')} or engine/alias format (e.g. claude/pro)`
  }).default('pro-max'),
  timeout: z.number().int().min(30).max(1800).default(300),
  max_clones: z.number().int().min(1).default(5),
  notification: z.object({
    platform: notificationPlatformSchema.default('telegram'),
    target: z.string().default(''),
    timezone: z.string().regex(ianaTimezoneRegex, 'Must be a valid IANA timezone').default('Asia/Shanghai'),
  }).default({}).superRefine((notification, ctx) => {
    // When platform is not 'none', validate target format if non-empty
    if (notification.platform !== 'none' && notification.target && notification.target.trim() !== '') {
      if (notification.platform === 'email') {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notification.target)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Invalid email address for notification target',
            path: ['target'],
          })
        }
      } else if (notification.platform === 'telegram') {
        // Accept numeric chat ID or hermes group/channel name
        if (!/^-?\d+$/.test(notification.target) && !/^[a-zA-Z0-9_-]+$/.test(notification.target)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Telegram target must be a numeric chat ID or a hermes target name',
            path: ['target'],
          })
        }
      } else if (notification.platform === 'slack') {
        if (!/^[C#][A-Z0-9]+$/.test(notification.target)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Slack target must be a channel ID (e.g., C0123ABC) or #channel-name',
            path: ['target'],
          })
        }
      } else {
        // For other platforms: target must be platform:id format or a qualified identifier
        const providerPrefixRe = /^(telegram|slack|email|discord|signal|webhook):.+$/
        // Bare identifiers must contain at least one separator (_, -, .) to avoid ambiguity
        const qualifiedIdRe = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*[_.:-][a-zA-Z0-9_.:-]*$/
        if (!providerPrefixRe.test(notification.target) && !qualifiedIdRe.test(notification.target)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Notification target must use platform:id format (e.g., telegram:12345) or a qualified identifier',
            path: ['target'],
          })
        }
      }
    }
  }),
  memory: z.object({
    session_retention_days: z.number().int().min(30).max(365).default(90),
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
