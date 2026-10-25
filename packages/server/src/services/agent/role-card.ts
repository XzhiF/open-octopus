import { expertName } from "@octopus/shared"
import type { SessionRoleState } from "../../db/dao/session-cache-context-dao"
import { resolveExpertDefinition } from "./expert-registry"

/** Bound the card: full agent files can be long; 6k chars is a one-time cost
 *  per switch and still carries the methodology wholesale. */
const MAX_PERSONA_CHARS = 6000

/**
 * Session role switching WITHOUT touching the system prompt.
 *
 * The provider cache is a prefix cache (tools → system → messages). Mutating
 * the system prompt to change persona invalidates the entire transcript. A
 * role card is appended to the user message instead: the cached prefix stays
 * put, and only the card + the current turn are new tokens.
 *
 * Returned text is wrapped by withTransientReminder() at the call site.
 */
export function buildRoleCard(expertId: string, revision: number): string | null {
  const def = resolveExpertDefinition(expertId)
  const name = expertName(expertId)
  if (!def && name === expertId) return null
  const persona = (def?.prompt ?? `你是 ${name} 专家。`).slice(0, MAX_PERSONA_CHARS)
  return [
    `[服务端角色切换 · revision ${revision}]`,
    `从本轮开始，你以「${name}」专家身份工作。以下 persona 与方法论优先于你的基础人设；基础安全、写权边界和任务纪律仍然优先。`,
    "你可以使用本会话已有的工具与权限，不要越权；不要反复确认或宣告身份，直接以该角色推进工作。",
    "最新一张角色卡生效，旧角色卡作废；不要混用多个角色。",
    "",
    `<expert id="${expertId}" name="${name}">`,
    persona,
    "</expert>",
  ].join("\n")
}

/** Clearing the active expert must also be delivered (otherwise the model
 *  keeps the last persona). */
export function buildRoleResetCard(revision: number): string {
  return [
    `[服务端角色切换 · revision ${revision}]`,
    "专家身份已结束。回到会话的基础角色继续工作；不要继续扮演之前的专家，也不要宣告这次切换。",
  ].join("\n")
}

/** Build the card only when the current revision has not been delivered yet. */
export function pendingRoleCard(state: SessionRoleState): string | null {
  if (state.revision <= state.deliveredRevision) return null
  return state.activeExpert
    ? buildRoleCard(state.activeExpert, state.revision)
    : buildRoleResetCard(state.revision)
}
