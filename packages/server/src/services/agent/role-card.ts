import { expertName } from "@octopus/shared"
import type { SessionRoleState } from "../../db/dao/session-cache-context-dao"
import { resolveExpertDefinition } from "./expert-registry"
import { resolveCloneRolePack } from "./clone-resolver"

/** Bound the card: full agent files can be long; 6k chars is a one-time cost
 *  per switch and still carries the methodology wholesale. */
const MAX_PERSONA_CHARS = 6000

/** Clone packs inline WHOLE (completeness beats tokens — the card is a one-time
 *  append that then rides the cache). Beyond this the card degrades to a head
 *  excerpt + a Read pointer, so the full text stays reachable either way. */
const MAX_CLONE_INLINE_CHARS = 20_000
const CLONE_HEAD_CHARS = 6000

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

/**
 * Clone identity switch (v59). Same cache discipline as buildRoleCard — the
 * pack is appended to the user message, never to the system prompt — but the
 * payload is the clone's WHOLE role pack: full persona text (no truncation up
 * to MAX_CLONE_INLINE_CHARS), its declared skills, and its memory scope.
 */
export function buildCloneRoleCard(cloneName: string, revision: number): string | null {
  const pack = resolveCloneRolePack(cloneName)
  if (!pack) return null

  const skillsLine = pack.skills.length > 0
    ? pack.skills.join("、")
    : "全部全局技能"
  const head = pack.persona ?? `（该分身暂无岗位包文本，按基础人设工作；可在分身配置里补充 persona）`
  const body = head.length > MAX_CLONE_INLINE_CHARS
    ? [
        head.slice(0, CLONE_HEAD_CHARS),
        "",
        pack.personaPath
          ? `（岗位包较长，以上为节选；动手前必须先用 Read 读取完整原文：${pack.personaPath}）`
          : `（岗位包较长，以上为节选；完整原文见该分身的 persona 文件）`,
      ].join("\n")
    : head

  return [
    `[服务端角色切换 · revision ${revision}]`,
    `从本轮开始，你以「${pack.displayName}」分身（clone: ${pack.name}）身份工作。以下岗位包优先于你的基础人设；基础安全、写权边界和任务纪律仍然优先。`,
    "你可以使用本会话已有的工具与权限，不要越权；不要反复确认或宣告身份，直接以该角色推进工作。",
    "最新一张角色卡生效，旧角色卡作废；不要混用多个角色。",
    "",
    `<clone name="${pack.name}" display="${pack.displayName}" revision="${revision}">`,
    "## 可用技能",
    `${skillsLine}。需要时先用 Read 打开对应 SKILL.md 再动作（内置技能：packages/core-pack/skills/<名>/SKILL.md；本地进化技能：~/.octopus/{org}/agent/skills/<名>/SKILL.md）。`,
    "## 边界",
    "- 基础安全、写权边界、任务纪律永远优先于岗位包",
    `- 长期记忆范围：${pack.memoryScope === "shared" ? "shared（跨会话共享）" : "isolated（本分身独立）"}`,
    "## 岗位包",
    body,
    "</clone>",
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
  if (!state.activeExpert) return buildRoleResetCard(state.revision)
  return state.activeKind === "clone"
    ? buildCloneRoleCard(state.activeExpert, state.revision)
    : buildRoleCard(state.activeExpert, state.revision)
}
