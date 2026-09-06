// packages/web-app/lib/workflow-presets-api.ts
//
// task-workflow-presets (T6) → binding-catalog redesign (2026-09-06):
// client for GET /api/workflow-presets (the BINDING CATALOG — what the
// phase-binding form offers) plus the built-in workflow endpoints used for
// input-definition mirroring and YAML preview.

import { getServerUrl } from "@/lib/server-config"

/** A single binding-catalog entry (workflow-presets.yaml). */
export interface WorkflowPreset {
  name: string
  desc?: string
  workflow: string
  inputs: Record<string, string>
}

/** GET /api/workflow-presets — the binding catalog verbatim. */
export async function listWorkflowPresets(): Promise<{ presets: WorkflowPreset[] }> {
  const res = await fetch(`${getServerUrl()}/api/workflow-presets`)
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
