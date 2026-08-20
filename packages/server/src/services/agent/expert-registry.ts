// packages/server/src/services/agent/expert-registry.ts
//
// Resolves expert role ids (the ids in the MoA dialog's AVAILABLE_ROLES, e.g.
// "engineering-rapid-prototyper") into Claude Agent SDK subagent definitions
// (OctopusAgentDef). Used by the single-expert consultation flow: the clone
// chat route registers the selected expert as an `agents` option on the
// current turn so the task-author main agent can invoke it via the Agent tool.
//
// The path-resolution logic mirrors assist-workflow-service.resolveAgentPath
// (agency-agents-zh → core-pack). Kept here standalone so the MoA workflow
// path is untouched; a future pass can consolidate both.

import { readFileSync, existsSync } from "fs"
import path from "path"
import os from "os"
import type { OctopusAgentDef } from "@octopus/providers"

/** Where installed expert agents live (agency-agents-zh package). */
const AGENTS_BASE = path.join(
  os.homedir(),
  ".octopus",
  "resources",
  "installed",
  "agents",
  "agency-agents-zh",
)
/** Fallback: core-pack bundled agents. */
const CORE_PACK_BASE = path.join(
  os.homedir(),
  ".octopus",
  "resources",
  "installed",
  "agents",
  "core-pack",
)

/** Read-only tools every consultation expert gets by default — an expert
 *  should answer from its persona + the chat context, not mutate the task. */
const DEFAULT_TOOLS = ["Read", "Grep", "Glob"]

export interface ExpertSubagentRef {
  id: string
  label?: string
}

/**
 * Resolve expert role ids into a subagent map keyed by agent name.
 * Returns undefined when no subagents are requested.
 */
export function resolveExpertSubagents(
  items: ExpertSubagentRef[],
): Record<string, OctopusAgentDef> | undefined {
  if (!items || items.length === 0) return undefined

  const out: Record<string, OctopusAgentDef> = {}
  for (const item of items) {
    const id = item.id?.trim()
    if (!id) continue
    const filePath = resolveAgentPath(id)
    if (filePath) {
      const { body, metadata } = loadAgentFile(filePath)
      const description =
        typeof metadata.description === "string" && metadata.description
          ? metadata.description
          : item.label ?? id
      const def: OctopusAgentDef = {
        description,
        prompt: body || `你是 ${item.label ?? id} 专家。请基于你的专业视角回答用户的咨询问题。`,
      }
      if (typeof metadata.model === "string" && metadata.model) def.model = metadata.model
      if (Array.isArray(metadata.tools) && metadata.tools.length > 0) {
        def.tools = metadata.tools
      } else {
        def.tools = DEFAULT_TOOLS
      }
      out[id] = def
    } else {
      // No agent file installed — register a minimal persona so the main agent
      // still has an invocable subagent for this turn.
      out[id] = {
        description: item.label ?? id,
        prompt: `你是 ${item.label ?? id} 专家。请基于你的专业视角回答用户的咨询问题，不要编造超出你专业领域的断言。`,
        tools: DEFAULT_TOOLS,
      }
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Locate an expert's .md file, mirroring assist-workflow-service.resolveAgentPath. */
function resolveAgentPath(agentId: string): string | null {
  const agentFile = path.join(AGENTS_BASE, agentId, `${agentId}.md`)
  if (existsSync(agentFile)) return agentFile
  const corePackPath = path.join(CORE_PACK_BASE, `${agentId}.md`)
  if (existsSync(corePackPath)) return corePackPath
  return null
}

/**
 * Read an agent .md file: strip YAML frontmatter → body, parse frontmatter →
 * flat metadata (description / model / tools / skills / maxTurns).
 * Parsing mirrors packages/engine/src/executors/swarm/agent-file-utils.ts.
 */
function loadAgentFile(
  filePath: string,
): { body: string; metadata: Record<string, unknown> } {
  const content = readFileSync(filePath, "utf-8")
  return {
    body: stripFrontmatter(content),
    metadata: parseFrontmatter(content),
  }
}

function parseFrontmatter(content: string): Record<string, unknown> {
  if (!content.startsWith("---")) return {}
  const endIndex = content.indexOf("---", 3)
  if (endIndex === -1) return {}

  const fmBlock = content.slice(3, endIndex).trim()
  const result: Record<string, unknown> = {}

  for (const line of fmBlock.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const colonIdx = trimmed.indexOf(":")
    if (colonIdx === -1) continue

    const key = trimmed.slice(0, colonIdx).trim()
    const rawVal = trimmed.slice(colonIdx + 1).trim()

    const val =
      (rawVal.startsWith('"') && rawVal.endsWith('"')) ||
      (rawVal.startsWith("'") && rawVal.endsWith("'"))
        ? rawVal.slice(1, -1)
        : rawVal

    if (key === "tools" || key === "skills") {
      if (val.startsWith("[")) {
        try {
          const parsed = JSON.parse(val)
          if (Array.isArray(parsed)) {
            result[key] = parsed
              .map((s: unknown) => String(s).trim())
              .filter(Boolean)
          }
        } catch {
          result[key] = val
            .replace(/[\[\]"']/g, "")
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean)
        }
      } else {
        result[key] = val
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean)
      }
    } else if (val) {
      result[key] = val
    }
  }

  return result
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content
  const endIndex = content.indexOf("---", 3)
  if (endIndex === -1) return content
  return content.slice(endIndex + 3).trimStart()
}
