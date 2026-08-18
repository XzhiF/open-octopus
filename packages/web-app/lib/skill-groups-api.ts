// packages/web-app/lib/skill-groups-api.ts
//
// Thin client for GET /api/skill-groups — the v3 template-page data source
// (ADR-0012/D3). Mirrors the tasks-api factory pattern: pure fetch wrapper,
// no DB. The server (packages/server/src/routes/skill-groups.ts) aggregates
// ResourceManager installed skills by `group` + always emits the built-in
// "default" empty marker first (D17 — selecting it means "use only built-in
// spec-field flow + shared skills"; the plugin-materializer skips it).
//
// The response shape mirrors the server's SkillGroup interface verbatim
// ({group, displayName, skills:[{name, description?}]}) — web-app cannot
// import from the server package, so this mirror keeps the client type-safe
// without a cross-package dependency (same pattern as TaskDetail in tasks-api).

import { getServerUrl } from "@/lib/server-config"

export interface SkillGroupSkill {
  name: string
  /** Best-effort description read from SKILL.md frontmatter (SW-BP13). May be
   *  undefined when the file is missing or has no description field. */
  description?: string
}

export interface SkillGroup {
  /** Registry group key (also the identifier persisted into task_spec.skill_groups). */
  group: string
  /** Human-readable label (server currently echoes `group`). */
  displayName: string
  skills: SkillGroupSkill[]
}

export interface SkillGroupsResponse {
  groups: SkillGroup[]
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return res.json()
}

/** GET /api/skill-groups — list skill groups for the template page. */
export async function listSkillGroups(): Promise<SkillGroupsResponse> {
  const res = await fetch(`${getServerUrl()}/api/skill-groups`)
  return handleResponse<SkillGroupsResponse>(res)
}
