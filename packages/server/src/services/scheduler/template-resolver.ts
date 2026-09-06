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
// task-phase-redesign (ticket 04) v4 vocabulary — available ONLY when a
// PlaceholderContext is passed (per-phase resolution in the v4 ready gate /
// materialize). Absent ctx, these names stay UNKNOWN (→ "" + unresolved),
// so v3 callers behave exactly as before:
//   ${phase.slug}           → the phase's path-safe slug (batch dir name, K10)
//   ${phase.spec_dir}       → dirname of the phase's resolved spec file (home-relative → absolute)
//   ${phase.batch_rel}      → home-RELATIVE posix batch dir (`.scratch/<date>/<slug>`) —
//                             the ws-isomorphic position (seed copies the batch dir there,
//                             K10); spec-consuming execution flows (matt-spec-dev) bind to
//                             THIS, not the absolute home path (${phase.spec_dir} stays for
//                             home-side writers like task-fix)
//   ${task.home}            → the task home dir (TaskHomeService.homePath)
//   ${task_artifacts_dir}   → the task artifacts dir (same value as the managed
//                             input_values key of the same name)
//
// goal/ac are OPTIONAL since v4 specs may omit them (shared ticket 01); an
// absent value behaves like the empty one: placeholder present → unresolved.
//
// Unknown placeholders (e.g. ${foo}) do NOT throw — they resolve to "" and the
// key is reported in `unresolved` so the ready-gate can push it into the
// missing list ("input:<name>") instead of 500-ing the request (review fix
// 2026-08-27: readers flagged a throw crossing the binding-helper boundary into
// the task state machine).

import yaml from "js-yaml"
import type { InputValues } from "@octopus/shared"

/** v4 per-phase resolution context (ticket 04). Every field optional — an
 *  empty/missing value behaves like the WHAT-empty case (placeholder present
 *  → unresolved), never a throw. */
export interface PlaceholderContext {
  phaseSlug?: string
  phaseSpecDir?: string
  /** Home-relative posix batch dir (`.scratch/<date>/<slug>`) — the ws-isomorphic
   *  path spec-consuming flows execute against. Absent (specDir outside the home
   *  / absolute specPath) → placeholder resolves "" + key reported unresolved. */
  phaseBatchRel?: string
  taskHome?: string
  taskArtifactsDir?: string
}

/** Known placeholder → replacement value map builder. v4 names are added only
 *  when a ctx is passed — without ctx the map carries just goal/ac, so dotted
 *  v4 names fall through the unknown branch (v3 behavior byte-identical).
 *  With ctx, an absent field behaves like an empty WHAT value: the key is
 *  marked unresolved, never a throw. */
function buildPlaceholderMap(
  goal: string | undefined,
  ac: string[] | undefined,
  ctx?: PlaceholderContext,
): Record<string, string> {
  const map: Record<string, string> = {
    goal: goal ?? "",
    ac: (ac ?? []).join("\n"),
  }
  if (ctx) {
    map["phase.slug"] = ctx.phaseSlug ?? ""
    map["phase.spec_dir"] = ctx.phaseSpecDir ?? ""
    map["phase.batch_rel"] = ctx.phaseBatchRel ?? ""
    map["task.home"] = ctx.taskHome ?? ""
    map["task_artifacts_dir"] = ctx.taskArtifactsDir ?? ""
  }
  return map
}

export interface ResolvedInputValues {
  /** Placeholder-resolved values (unknown placeholders → ""). */
  values: InputValues
  /** Keys whose value contained an unknown placeholder (e.g. `${goaal}`) or a
   *  placeholder referencing an empty WHAT field. Callers decide the policy:
   *  ready-gate → missing list; materialization → best-effort (keep ""). */
  unresolved: string[]
}

/** Resolve placeholders in input_values. Never throws — an unknown
 *  placeholder resolves to "" and its key lands in `unresolved`, so a bad
 *  template surfaces as data (missing list) rather than a hard error across
 *  service boundaries.
 *
 *  v3 vocabulary (${goal}/${ac}) always available; the v4 vocabulary
 *  (${phase.slug}/${phase.spec_dir}/${task.home}/${task_artifacts_dir})
 *  requires the optional ctx (ticket 04). The name charset is widened to
 *  include `.` so dotted names are recognized-and-reported instead of left
 *  as literal text in the value.
 *
 *  @param inputValues - raw input_values from task_spec / one phase (undefined ok)
 *  @param goal - task_spec.goal (optional in v4 specs)
 *  @param ac - task_spec.ac string[] (optional in v4 specs)
 *  @param ctx - v4 placeholder context (omit ⇒ v3 behavior) */
export function resolveInputValues(
  inputValues: InputValues | undefined,
  goal: string | undefined,
  ac: string[] | undefined,
  ctx?: PlaceholderContext,
): ResolvedInputValues {
  if (!inputValues || Object.keys(inputValues).length === 0) {
    return { values: {}, unresolved: [] }
  }

  const map = buildPlaceholderMap(goal, ac, ctx)
  const placeholderRegex = /\$\{([\w.]+)\}/g
  const values: InputValues = {}
  const unresolved: string[] = []

  for (const [key, value] of Object.entries(inputValues)) {
    let hadUnknown = false
    values[key] = value.replace(placeholderRegex, (match, name: string) => {
      // Object.hasOwn, not `in`: the [\w.]+ regex admits `${constructor}` /
      // `${toString}` etc.; a prototype-chain hit via `in` would substitute
      // an inherited function (truthy) instead of marking it unresolved.
      if (Object.hasOwn(map, name)) {
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
