import { EXPERT_ROLE_IDS } from "@octopus/shared"
import type { SessionCacheContextDAO } from "../../db/dao/session-cache-context-dao"

export interface ExpertRosterInput {
  sessionId: string
  cloneName: string
  /** Experts requested by this turn (consult UI); may be empty. */
  requested: readonly string[]
  /** Seed the whole catalog on first use (main chat / task-doer / task-author)
   *  so an `@expert` dispatch never mutates the SDK agents metadata. */
  seedCatalog?: boolean
}

/**
 * Session-stable expert roster.
 *
 * The SDK `agents` map is part of the prompt prefix that the provider caches.
 * Registering an expert for one turn and removing it on the next would reset
 * the whole cached transcript twice per consultation. Chat sessions therefore
 * register the full catalog from turn 0; other clones union as they go (a new
 * id costs one reset, never a remove/re-add cycle).
 *
 * The user message names the expert to consult this turn — the roster itself
 * stays byte-identical.
 */
export function resolveSessionExpertRoster(
  dao: SessionCacheContextDAO,
  input: ExpertRosterInput,
): string[] {
  const { sessionId, cloneName, requested } = input
  let roster = dao.getExpertRoster(sessionId)
  if (roster.length === 0 && (input.seedCatalog || cloneName === "task-author")) {
    roster = dao.saveExpertRoster(sessionId, EXPERT_ROLE_IDS)
  }
  const ids = requested.map((id) => id.trim()).filter(Boolean)
  if (ids.length > 0) {
    roster = dao.addExpertsToRoster(sessionId, ids)
  }
  return roster
}
