import type { SessionCacheContextDAO } from "../../db/dao/session-cache-context-dao"
import { listConsultableClones } from "./clone-resolver"

export interface ExpertRosterInput {
  sessionId: string
  /** Clones requested by this turn (mentions / 挂载 panel); may be empty. */
  requested: readonly string[]
}

/**
 * Session-stable consultable roster (the SDK `agents` map).
 *
 * The `agents` map is part of the prompt prefix that the provider caches.
 * Registering a clone for one turn and removing it on the next would reset the
 * whole cached transcript twice per consultation. Sessions therefore register
 * the FULL clone roster from turn 0; clones created later union in on first
 * use (a new id costs one reset, never a remove/re-add cycle).
 *
 * The user message names the clone consulted this turn — the roster itself
 * stays byte-identical.
 */
export function resolveSessionExpertRoster(
  dao: SessionCacheContextDAO,
  input: ExpertRosterInput,
): string[] {
  const { sessionId, requested } = input
  let roster = dao.getExpertRoster(sessionId)
  if (roster.length === 0) {
    roster = dao.saveExpertRoster(
      sessionId,
      listConsultableClones().map((c) => c.name),
    )
  }
  const ids = requested.map((id) => id.trim()).filter(Boolean)
  if (ids.length > 0) {
    roster = dao.addExpertsToRoster(sessionId, ids)
  }
  return roster
}