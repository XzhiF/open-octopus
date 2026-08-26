// packages/web-app/lib/workflow-presets-api.ts
//
// task-workflow-presets (T6): client for GET /api/workflow-presets and the
// existing built-in workflow detail endpoint.

import { getServerUrl } from "@/lib/server-config"

/** A single workflow preset from the catalog. */
export interface WorkflowPreset {
  name: string
  skills_group: string[]
  workflow: string
  inputs: Record<string, string>
}

/** GET /api/workflow-presets?skills_group=a,b — filtered preset list. */
export async function listWorkflowPresets(
  skillsGroup?: string[],
): Promise<{ presets: WorkflowPreset[] }> {
  const url = new URL(`${getServerUrl()}/api/workflow-presets`)
  if (skillsGroup?.length) {
    url.searchParams.set("skills_group", skillsGroup.join(","))
  }
  const res = await fetch(url.toString())
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }
  return res.json()
}

/** Built-in workflow detail (content + parsed YAML). */
export interface BuiltInWorkflowDetail {
  ref: string
  content: string
  parsed: {
    name: string
    description?: string
    inputs?: Record<string, { description?: string; required?: boolean; default?: string }>
    [key: string]: unknown
  }
}

/** GET /api/workflows/built-in/:ref — workflow content + parsed YAML. */
export async function getBuiltInWorkflowDetail(
  ref: string,
): Promise<BuiltInWorkflowDetail> {
  const res = await fetch(`${getServerUrl()}/api/workflows/built-in/${encodeURIComponent(ref)}`)
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }
  return res.json()
}

/** List all installed built-in workflows (summary). */
export interface BuiltInWorkflowSummary {
  ref: string
  name: string
  group: string
  inputs?: Record<string, { description?: string; required?: boolean; default?: string }>
}

export async function listBuiltInWorkflows(): Promise<BuiltInWorkflowSummary[]> {
  const res = await fetch(`${getServerUrl()}/api/workflows/built-in`)
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }
  return res.json()
}
