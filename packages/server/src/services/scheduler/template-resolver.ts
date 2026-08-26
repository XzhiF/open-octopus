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
// Unknown placeholders (e.g. ${foo}) → throw Error (fail-fast at bind time).

import yaml from "js-yaml"

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

/** Resolve ${goal} and ${ac} placeholders in input_values. Throws on unknown
 *  placeholders (fail-fast — the binding dialog should have caught this, but
 *  the server is the safety net).
 *
 *  @param inputValues - raw input_values from task_spec (may be undefined)
 *  @param goal - task_spec.goal
 *  @param ac - task_spec.ac (string[])
 *  @returns resolved Record<string, string> with all placeholders replaced */
export function resolveInputValues(
  inputValues: Record<string, string> | undefined,
  goal: string,
  ac: string[],
): Record<string, string> {
  if (!inputValues || Object.keys(inputValues).length === 0) {
    return {}
  }

  const map = buildPlaceholderMap(goal, ac)
  const placeholderRegex = /\$\{(\w+)\}/g
  const resolved: Record<string, string> = {}

  for (const [key, value] of Object.entries(inputValues)) {
    resolved[key] = value.replace(placeholderRegex, (match, name: string) => {
      if (name in map) {
        return map[name]
      }
      throw new Error(
        `Unknown placeholder in input_values["${key}"]: ${match}. ` +
        `Known placeholders: \${goal}, \${ac}`,
      )
    })
  }

  return resolved
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
