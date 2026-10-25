/**
 * Shared expert catalog — single source of truth lives in @octopus/shared so
 * the server roster and the UI can never drift.
 */
export {
  EXPERT_ROLES,
  EXPERT_ROLE_IDS,
  expertLabel,
  expertName,
  expertByMention,
  parseExpertMentions,
} from '@octopus/shared'
export type { ExpertRole } from '@octopus/shared'
