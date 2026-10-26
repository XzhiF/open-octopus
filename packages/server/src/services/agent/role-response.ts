// Shared identity-switch API surface — one response shape for the three role
// routes (main session / clone session / task doer chat). Identity now targets
// the clone roster (built-in + user); legacy rows keep resolving through the
// agency EXPERT_ROLES catalog so already-delivered cards stay interpretable.

import { EXPERT_ROLES } from "@octopus/shared"
import type { SessionRoleState } from "../../db/dao/session-cache-context-dao"
import { isValidCloneName, resolveCloneInfo } from "./clone-resolver"

/** Identity id accepted by the role switch: a live clone (built-in or user). */
export function isCloneRoleTarget(name: string): boolean {
  return isValidCloneName(name) && resolveCloneInfo(name) !== null
}

export function roleResponse(sessionId: string, state: SessionRoleState) {
  const isClone = state.activeKind === "clone"
  const clone = isClone && state.activeExpert ? resolveCloneInfo(state.activeExpert) : null
  const expert = !isClone && state.activeExpert
    ? EXPERT_ROLES.find((role) => role.id === state.activeExpert) ?? null
    : null
  return {
    session_id: sessionId,
    active_expert: state.activeExpert,
    active_kind: state.activeKind,
    expert,
    clone: clone
      ? {
          id: clone.name,
          display_name: clone.display_name,
          type: clone.type,
          skills: clone.skills,
          memory_scope: clone.memory_scope,
          status: clone.status,
        }
      : null,
    revision: state.revision,
    delivered_revision: state.deliveredRevision,
  }
}