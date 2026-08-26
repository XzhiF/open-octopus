// packages/shared/src/types/workflow-presets.ts
//
// task-workflow-presets (T1): preset catalog schemas.
//
// A "preset" maps a skill group to a recommended workflow + input skeleton.
// The catalog lives at ~/.octopus/agent/built-in/task-author/workflow-presets.yaml
// (agent behavior asset, co-located with the persona.md). Server reads it to
// serve GET /api/workflow-presets; agent reads it for HOW-handoff recommendations.
//
// Shape: each preset = name + skills_group[] + workflow ref + inputs skeleton.
// skills_group: [] = general fallback (matches any task's skill groups).
// inputs values may contain ${goal} / ${ac} placeholders — resolved at
// materialization time by the server (materializeTaskSpecToConfig).

import { z } from "zod"

/** A single workflow preset: maps skill groups to a recommended workflow + input
 *  skeleton. `skills_group: []` is the general fallback — matches any task. */
export const workflowPresetSchema = z.object({
  name: z.string().min(1),
  skills_group: z.array(z.string()).default([]),
  workflow: z.string().min(1),
  inputs: z.record(z.string(), z.string()).default({}),
})
export type WorkflowPreset = z.infer<typeof workflowPresetSchema>

/** The preset catalog: a YAML file containing an array of presets. */
export const workflowPresetsCatalogSchema = z.object({
  presets: z.array(workflowPresetSchema).default([]),
})
export type WorkflowPresetsCatalog = z.infer<typeof workflowPresetsCatalogSchema>
