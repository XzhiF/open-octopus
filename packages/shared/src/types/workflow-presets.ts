// packages/shared/src/types/workflow-presets.ts
//
// task-workflow-presets (T1) → binding-catalog redesign (2026-09-06):
// workflow-presets.yaml is the BINDING CATALOG — the single source of which
// workflows the v4 phase-binding form offers and what input skeleton each
// carries. Same file feeds the task-author agent's binding recommendations.
// The old skills_group filtering and the whole built-in-domain browse are
// retired; to offer a workflow, list it here (ref resolvability is still the
// enqueue gate's job, not this file's).
//
// The catalog lives at ~/.octopus/agent/built-in/task-author/workflow-presets.yaml
// (agent behavior asset, co-located with persona.md).
//
// inputs values may contain ${phase.*} / ${task.home} / ${task_artifacts_dir}
// placeholders — resolved at materialization time by the server.

import { z } from "zod"

/** Task workflow input values: key→non-empty string, values may contain
 *  `${...}` templates resolved at materialization. A named type so
 *  the invariant travels with the name across server + web-app seams. */
export type InputValues = Record<string, string>

/** A single catalog entry: a bindable workflow + the input skeleton the
 *  binding form pre-fills. desc is the one-line shown in the picker. */
export const workflowPresetSchema = z.object({
  name: z.string().min(1),
  desc: z.string().optional(),
  workflow: z.string().min(1),
  inputs: z.record(z.string(), z.string()).default({}),
})
export type WorkflowPreset = z.infer<typeof workflowPresetSchema>

/** The binding catalog: a YAML file containing an array of presets. */
export const workflowPresetsCatalogSchema = z.object({
  presets: z.array(workflowPresetSchema).default([]),
})
export type WorkflowPresetsCatalog = z.infer<typeof workflowPresetsCatalogSchema>
