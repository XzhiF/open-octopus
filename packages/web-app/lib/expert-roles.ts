/**
 * Shared expert catalog — single source of truth lives in @octopus/shared so
 * the server roster and the UI can never drift.
 */
export { EXPERT_ROLES, expertLabel, expertName } from '@octopus/shared'
export type { ExpertRole } from '@octopus/shared'
