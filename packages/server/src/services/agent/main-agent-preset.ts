// Main-agent identity presets — persona-source switch (P3-2, option a).
//
// A preset is a NAMED persona text. Switching one writes the global
// `persona.md` (the single source SystemPromptAssembler reads) after backing
// the outgoing file up. Consequences, by design:
//   - existing sessions are untouched: their system-prompt snapshot froze on
//     the first turn, so the provider prefix cache survives the switch;
//   - new sessions pick the preset up from their first turn;
//   - switching back is one call, and every reader (assembler / persona
//     editor / debug assemble) sees the SAME active text — no hidden overlay
//     between the file and what the model gets.
//
// The workspace preset resolves live from the `workspace` clone's role pack,
// so improving that 岗位包 improves the main-agent option in the same edit.

import crypto from "crypto"
import fs from "fs"
import { getPersonaPath } from "./paths"
import { getPersonaService } from "./persona-service"
import { resolveCloneRolePack } from "./clone-resolver"

export type MainAgentPresetId = "octopus" | "workspace"

/** Shipped platform default — the persona.md that ships with the agent home. */
export const OCTOPUS_DEFAULT_PERSONA = `# 人格

你是 Octopus Agent，一个智能编排助手。

## 核心能力
- 理解用户意图，将自然语言任务转化为可执行的工作流
- 管理分身（Clones）并行执行多个任务
- 维护三层记忆系统，持续学习和改进
- 通过 SKILL 进化机制自主优化工作方式

## 工作原则
- 安全第一：危险操作必须确认，文件操作限定在工作空间内
- 透明沟通：解释你的决策过程，让用户了解每一步
- 持续学习：从每次任务中提取经验，优化未来表现
- 尊重边界：在授权范围内行动，超出范围时主动询问`

export interface MainAgentPresetOption {
  id: MainAgentPresetId
  label: string
  description: string
  chars: number
  personaPreview: string
}

export interface MainAgentPresetState {
  /** The preset the current persona.md matches, or 'custom' (hand-edited). */
  active: MainAgentPresetId | "custom"
  personaPath: string
  /** Switch affects NEW sessions only — frozen snapshots are never touched. */
  appliesTo: "new_sessions"
  options: MainAgentPresetOption[]
}

const PRESET_META: Record<MainAgentPresetId, { label: string; description: string }> = {
  octopus: {
    label: "Octopus Agent（平台默认）",
    description: "智能编排助手：意图→工作流、分身管理、三层记忆、技能进化。",
  },
  workspace: {
    label: "全栈开发助手",
    description: "工程分身：角色 / 工作流强制项 / 交付标准 / 可用技能 / 边界（取自 workspace 分身岗位包，随其更新）。",
  },
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").trim()
}

function textHash(text: string): string {
  return crypto.createHash("sha256").update(normalize(text), "utf-8").digest("hex")
}

/** Persona text for a preset, or null when the source is unavailable. */
export function mainAgentPresetText(id: MainAgentPresetId): string | null {
  if (id === "octopus") return OCTOPUS_DEFAULT_PERSONA
  if (id === "workspace") return resolveCloneRolePack("workspace")?.persona ?? null
  return null
}

export function listMainAgentPresets(): MainAgentPresetOption[] {
  const ids: MainAgentPresetId[] = ["octopus", "workspace"]
  const out: MainAgentPresetOption[] = []
  for (const id of ids) {
    const text = mainAgentPresetText(id)
    if (!text) continue
    out.push({
      id,
      label: PRESET_META[id].label,
      description: PRESET_META[id].description,
      chars: normalize(text).length,
      personaPreview: normalize(text).slice(0, 120),
    })
  }
  return out
}

/** Current preset state: which preset the persona.md on disk matches. */
export function getMainAgentPresetState(): MainAgentPresetState {
  const personaPath = getPersonaPath()
  let current = ""
  try {
    current = fs.readFileSync(personaPath, "utf-8")
  } catch {
    // Missing file = the platform default is effectively in effect.
    return {
      active: "octopus",
      personaPath,
      appliesTo: "new_sessions",
      options: listMainAgentPresets(),
    }
  }

  const currentHash = textHash(current)
  let active: MainAgentPresetId | "custom" = "custom"
  for (const option of listMainAgentPresets()) {
    const text = mainAgentPresetText(option.id)
    if (text && textHash(text) === currentHash) {
      active = option.id
      break
    }
  }
  return { active, personaPath, appliesTo: "new_sessions", options: listMainAgentPresets() }
}

export interface SetMainAgentPresetResult {
  preset: MainAgentPresetId
  /** Where the outgoing persona.md was preserved, when it differed. */
  backupPath: string | null
  chars: number
}

/**
 * Switch the main-agent persona source. Backs the outgoing persona.md up when
 * it differs from the incoming text, then writes through PersonaService —
 * inheriting the shared 2000-char cap (413 PERSONA_TOO_LONG) so the presets
 * obey the same rule as the persona editor.
 */
export function setMainAgentPreset(preset: MainAgentPresetId, org: string): SetMainAgentPresetResult {
  const text = mainAgentPresetText(preset)
  if (!text) {
    const err = new Error(`Unknown or unavailable preset: ${preset}`) as Error & { code?: string }
    err.code = "INVALID_PARAM"
    throw err
  }

  const personaPath = getPersonaPath()
  let backupPath: string | null = null
  try {
    const current = fs.readFileSync(personaPath, "utf-8")
    if (normalize(current) !== normalize(text)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-")
      backupPath = `${personaPath}.bak-${stamp}`
      fs.copyFileSync(personaPath, backupPath)
    }
  } catch {
    // No existing persona.md — nothing to back up.
  }

  getPersonaService().writePersona(org, text)

  return { preset, backupPath, chars: normalize(text).length }
}