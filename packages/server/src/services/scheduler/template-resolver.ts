// packages/server/src/services/scheduler/template-resolver.ts
//
// task-workflow-presets (T4): resolves ${goal} and ${ac} placeholders in
// input_values at materialization time. Does NOT touch the engine's
// substituteVars (research 01 conclusion: engine has its own interpolation,
// we do a one-time pre-materialization replacement here).
//
// Placeholders:
//   ${goal} → task_spec.goal (string, direct substitution)
//   ${ac}   → task_spec.ac.join('\n') (array → newline-joined)
//
// Unknown placeholders (e.g. ${foo}) do NOT throw — they resolve to "" and the
// key is reported in `unresolved` so the ready-gate can push it into the
// missing list ("input:<name>") instead of 500-ing the request (review fix
// 2026-08-27: readers flagged a throw crossing the binding-helper boundary into
// the task state machine).

import yaml from "js-yaml"
import type { InputValues } from "@octopus/shared"

/** Known placeholder → replacement value map builder. */
function buildPlaceholderMap(
  goal: string,
  ac: string[],
): Record<string, string> {
  return {
    goal,
    ac: ac.join("\n"),
  }
}

export interface ResolvedInputValues {
  /** Placeholder-resolved values (unknown placeholders → ""). */
  values: InputValues
  /** Keys whose value contained an unknown placeholder (e.g. `${goaal}`) or a
   *  placeholder referencing an empty WHAT field. Callers decide the policy:
   *  ready-gate → missing list; materialization → best-effort (keep ""). */
  unresolved: string[]
}

/** Resolve ${goal} / ${ac} placeholders in input_values. Never throws — an
 *  unknown placeholder resolves to "" and its key lands in `unresolved`, so a
 *  bad template surfaces as data (missing list) rather than a hard error across
 *  service boundaries.
 *
 *  @param inputValues - raw input_values from task_spec (may be undefined)
 *  @param goal - task_spec.goal
 *  @param ac - task_spec.ac (string[]) */
export function resolveInputValues(
  inputValues: InputValues | undefined,
  goal: string,
  ac: string[],
): ResolvedInputValues {
  if (!inputValues || Object.keys(inputValues).length === 0) {
    return { values: {}, unresolved: [] }
  }

  const map = buildPlaceholderMap(goal, ac)
  const placeholderRegex = /\$\{(\w+)\}/g
  const values: InputValues = {}
  const unresolved: string[] = []

  for (const [key, value] of Object.entries(inputValues)) {
    let hadUnknown = false
    values[key] = value.replace(placeholderRegex, (match, name: string) => {
      if (name in map) {
        const replaced = map[name]
        if (!replaced) hadUnknown = true // placeholder present but WHAT empty
        return replaced
      }
      hadUnknown = true
      return ""
    })
    if (hadUnknown) unresolved.push(key)
  }

  return { values, unresolved }
}

/** A workflow input definition: name + whether it's required. */
export interface WorkflowInputDef {
  name: string
  required: boolean
}

/** Parse a workflow YAML's `inputs:` section to extract required input names.
 *  An input is `required: true` if it has that flag set explicitly. Inputs
 *  without a `required` field or with `required: false` are optional.
 *
 *  Returns [] for invalid YAML, missing inputs section, or non-object inputs.
 *  This is a best-effort parse for the ready-gate — we don't fail on malformed
 *  workflow content (that's the workflow validator's job). */
export function parseWorkflowInputDefs(content: string): WorkflowInputDef[] {
  let parsed: unknown
  try {
    parsed = yaml.load(content)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== "object") return []

  const wf = parsed as Record<string, unknown>
  const inputs = wf.inputs
  if (!inputs || typeof inputs !== "object") return []

  const result: WorkflowInputDef[] = []
  for (const [name, def] of Object.entries(inputs as Record<string, unknown>)) {
    if (!def || typeof def !== "object") continue
    const defObj = def as Record<string, unknown>
    const required = defObj.required === true
    result.push({ name, required })
  }
  return result
}
