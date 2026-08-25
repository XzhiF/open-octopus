// packages/server/src/routes/skill-groups.ts
//
// GET /api/skill-groups — the template-page data source (ADR-0012/D3). Aggregates
// the ResourceManager's installed skills (type=skill) by their `group` field and
// reads each skill's description from SKILL.md frontmatter (best-effort — absent
// or unreadable → undefined, never a throw, SW-BP13).
//
// Always includes the built-in "default" group as an EMPTY marker (D17): selecting
// it means "use only the built-in spec-field flow + shared skills (already exposed
// via plugin #1, ~/.octopus/agent)" — the plugin-materializer skips it, so
// re-materializing would cause the SDK to discover duplicates.
//
// Pure route layer: delegates to the ResourceManager (the registry is the single
// source of truth, NOT a filesystem readdir — cf. archive.ts' /skill-groups which
// reads the installed/ tree directly and would miss registry-only state). The
// `?org=` query is accepted for API-contract conformance but does not filter
// (resources are not org-scoped — ResourceManagerRegistry is a global singleton).

import { Hono } from "hono"
import fs from "fs"
import path from "path"
import type { ResourceManager } from "@octopus/shared"
import { DEFAULT_SKILL_GROUP } from "../services/tasks/plugin-materializer"

export interface SkillGroupSkill {
  name: string
  /** Best-effort description read from SKILL.md frontmatter (SW-BP13). Undefined
   *  when the file is missing, has no frontmatter, or the frontmatter lacks a
   *  `description` field. */
  description?: string
}

export interface SkillGroup {
  group: string
  displayName: string
  skills: SkillGroupSkill[]
}

/** Read the `description` field from the YAML frontmatter of a SKILL.md.
 *  Best-effort: any error or absence → undefined (SW-BP13). Handles the common
 *  `description: <value>` single-line form; strips surrounding quotes. */
function readSkillDescription(installPath: string): string | undefined {
  try {
    const skillMd = path.join(installPath, "SKILL.md")
    if (!fs.existsSync(skillMd)) return undefined
    const content = fs.readFileSync(skillMd, "utf-8")
    // YAML frontmatter is a leading --- ... --- block.
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!match) return undefined
    const frontmatter = match[1]!
    for (const line of frontmatter.split(/\r?\n/)) {
      const m = line.match(/^description\s*:\s*(.*)$/)
      if (m) {
        const val = m[1]!.trim()
        // Strip a single pair of surrounding quotes (single or double).
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          return val.slice(1, -1)
        }
        return val
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

export function createSkillGroupsRoutes(rm: ResourceManager): Hono {
  const router = new Hono()

  // GET / — list skill groups for the template page.
  // ?org= accepted (forward-compat) but not filtered — resources are global.
  router.get("/", (c) => {
    const installed = rm.list({ type: "skill", installed: true }).resources

    // Aggregate by group, preserving first-seen order.
    const order: string[] = []
    const byGroup = new Map<string, SkillGroupSkill[]>()
    for (const entry of installed) {
      if (!byGroup.has(entry.group)) {
        byGroup.set(entry.group, [])
        order.push(entry.group)
      }
      byGroup.get(entry.group)!.push({
        name: entry.name,
        description: readSkillDescription(entry.installPath),
      })
    }

    const groups: SkillGroup[] = []
    // Built-in default empty-marker — always first (D17).
    groups.push({
      group: DEFAULT_SKILL_GROUP,
      displayName: DEFAULT_SKILL_GROUP,
      skills: [],
    })
    for (const group of order) {
      // "default" is already added as the empty marker — skip a registry entry
      // under that group too (it would otherwise list shared skills that the
      // materializer refuses to link anyway, D17).
      if (group === DEFAULT_SKILL_GROUP) continue
      groups.push({
        group,
        displayName: group,
        skills: byGroup.get(group)!,
      })
    }
    return c.json({ groups })
  })

  return router
}
