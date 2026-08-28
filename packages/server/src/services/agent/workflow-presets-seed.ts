// packages/server/src/services/agent/workflow-presets-seed.ts
//
// task-workflow-presets: the DEFAULT workflow-presets.yaml content, embedded as
// a constant so CloneInitService can seed the task-author clone directory on
// first init (persona pattern — same as persona.md). This is the single source
// of the runtime default: the file shipped in the repo lives HERE, not in
// core-pack, so a packaged install without core-pack still seeds correctly.
//
// The seeded file lands at:
//   ~/.octopus/agent/built-in/task-author/workflow-presets.yaml
// and is read by WorkflowPresetsService (GET /api/workflow-presets) + the
// task-author agent (HOW-handoff via its SKILL.md).
//
// goal-task-dev (ticket 05): versioned seed migration. skip-if-exists alone
// meant existing installs NEVER refreshed (general-dev kept pointing at
// matt-dev-pipeline, US1 died silently). The default now carries a
// `# version: N` header; CloneInitService compares the existing file's
// NORMALIZED content hash against ALL historical embedded defaults
// (PREV_DEFAULT_WORKFLOW_PRESETS_YAMLS — code-review c1: a single baseline
// silently stranded installs seeded before mid-life literal changes):
//   ≡ prev default (untouched seed)  → refresh to new default + log
//   ≡ current default                → skip silently (already fresh)
//   anything else (user hand-edit)   → preserve + warn once
//   missing                          → write new default
//
// NOTE: inside the template literal the `${...}` placeholders MUST be escaped
// as \${...} — an unescaped `${goal}` is a JavaScript interpolation expression.

import { createHash } from 'crypto'

/** Seed catalog version — bump on every default change that existing
 *  installs should receive. The value is mirrored in the `# version: N`
 *  header line of DEFAULT_WORKFLOW_PRESETS_YAML (guarded by test). */
export const PRESETS_VERSION = 2

/** The most recent embedded default before v2 (v1b — task-workflow-presets
 *  with the superpowers-task-dev preset appended by 709e8019). KEPT VERBATIM
 *  as a migration baseline. Do not edit. */
export const PREV_DEFAULT_V1B_WORKFLOW_PRESETS_YAML = `# Default workflow presets — maps skill groups to recommended workflows + input templates.
# Each preset: name + skills_group[] (empty = general fallback) + workflow ref + inputs skeleton.
# Inputs may contain \${goal} and \${ac} placeholders — resolved at materialization time.
#
# This file is the preset catalog for the task-author clone. It lives at:
#   ~/.octopus/agent/built-in/task-author/workflow-presets.yaml
# and is read by:
#   - Server: GET /api/workflow-presets?skills_group=a,b
#   - Agent: task-author SKILL.md HOW-handoff (recommendation basis)
#
# Shape: each preset = { name, skills_group[], workflow, inputs{} }
# - skills_group: [] = general fallback (matches any task)
# - workflow: ref format "group/name" for built-ins, bare filename for task-home
# - inputs: key→value map; values may contain \${goal} / \${ac} placeholders

presets:
  # General fallback — matches all skill groups
  - name: general-dev
    skills_group: []
    workflow: built-in/matt-dev-pipeline
    inputs:
      idea: "\${goal}"

  # XZF development pipeline
  - name: xzf-dev
    skills_group: [octo-xzf-implementer]
    workflow: built-in/xzf-dev
    inputs:
      idea: "\${goal}"

  # Superpowers-zh task development (plan-doc detection → subagent dev → CR → ship)
  - name: superpowers-task-dev
    skills_group: [superpowers-zh]
    workflow: built-in/superpowers-task-dev
    inputs:
      goal: "\${goal}"
      ac: "\${ac}"
`

/** The ORIGINAL shipped default (v1a — task-workflow-presets at merge-base,
 *  before the superpowers preset was appended). Installs seeded from this
 *  literal are equally untouched seeds (code-review c1). Do not edit. */
export const PREV_DEFAULT_V1A_WORKFLOW_PRESETS_YAML = `# Default workflow presets — maps skill groups to recommended workflows + input templates.
# Each preset: name + skills_group[] (empty = general fallback) + workflow ref + inputs skeleton.
# Inputs may contain \${goal} and \${ac} placeholders — resolved at materialization time.
#
# This file is the preset catalog for the task-author clone. It lives at:
#   ~/.octopus/agent/built-in/task-author/workflow-presets.yaml
# and is read by:
#   - Server: GET /api/workflow-presets?skills_group=a,b
#   - Agent: task-author SKILL.md HOW-handoff (recommendation basis)
#
# Shape: each preset = { name, skills_group[], workflow, inputs{} }
# - skills_group: [] = general fallback (matches any query)
# - workflow: ref format "group/name" for built-ins, bare filename for task-home
# - inputs: key→value map; values may contain \${goal} / \${ac} placeholders

presets:
  # General fallback — matches all skill groups
  - name: general-dev
    skills_group: []
    workflow: built-in/matt-dev-pipeline
    inputs:
      idea: "\${goal}"

  # XZF development pipeline
  - name: xzf-dev
    skills_group: [octo-xzf-implementer]
    workflow: built-in/xzf-dev
    inputs:
      idea: "\${goal}"
`

/** ALL historical embedded defaults — an existing file whose normalized hash
 *  matches ANY of these is provably an untouched seed → refresh-safe.
 *  Future migrations: move the then-current default into this list, bump
 *  PRESETS_VERSION; never edit existing literals. */
export const PREV_DEFAULT_WORKFLOW_PRESETS_YAMLS: string[] = [
  PREV_DEFAULT_V1A_WORKFLOW_PRESETS_YAML,
  PREV_DEFAULT_V1B_WORKFLOW_PRESETS_YAML,
]

/** Default preset catalog — maps skill groups to recommended workflows + input
 *  skeletons. `skills_group: []` = general fallback (matches any task). Inputs
 *  may contain \${goal} / \${ac} placeholders, resolved at materialization.
 *
 *  v2 (goal-task-dev): general-dev → built-in/task-dev (goal/ac skeleton;
 *  max_turns rides the YAML default, no placeholder). xzf/superpowers unchanged. */
export const DEFAULT_WORKFLOW_PRESETS_YAML = `# version: ${PRESETS_VERSION}
# Default workflow presets — maps skill groups to recommended workflows + input templates.
# Each preset: name + skills_group[] (empty = general fallback) + workflow ref + inputs skeleton.
# Inputs may contain \${goal} and \${ac} placeholders — resolved at materialization time.
#
# This file is the preset catalog for the task-author clone. It lives at:
#   ~/.octopus/agent/built-in/task-author/workflow-presets.yaml
# and is read by:
#   - Server: GET /api/workflow-presets?skills_group=a,b
#   - Agent: task-author SKILL.md HOW-handoff (recommendation basis)
#
# Shape: each preset = { name, skills_group[], workflow, inputs{} }
# - skills_group: [] = general fallback (matches any task)
# - workflow: ref format "group/name" for built-ins, bare filename for task-home
# - inputs: key→value map; values may contain \${goal} / \${ac} placeholders
#
# The "# version: N" header line above is the seed-migration marker maintained
# by CloneInitService — edits to the rest of this file are yours and preserved.

presets:
  # General fallback — matches all skill groups (task-dev: goal 模式无人值守, see goal-task-dev)
  - name: general-dev
    skills_group: []
    workflow: built-in/task-dev
    inputs:
      goal: "\${goal}"
      ac: "\${ac}"

  # XZF development pipeline
  - name: xzf-dev
    skills_group: [octo-xzf-implementer]
    workflow: built-in/xzf-dev
    inputs:
      idea: "\${goal}"

  # Superpowers-zh task development (plan-doc detection → subagent dev → CR → ship)
  - name: superpowers-task-dev
    skills_group: [superpowers-zh]
    workflow: built-in/superpowers-task-dev
    inputs:
      goal: "\${goal}"
      ac: "\${ac}"
`

// ── Migration helpers ─────────────────────────────────────────────

/**
 * Normalize catalog content for version-identity comparison: strip a leading
 * `# version: N` header line, CRLF → LF, trailing whitespace. This makes the
 * version marker itself (and editor whitespace churn) invisible to the
 * untouched-seed detection — only real content edits flip the verdict.
 */
export function normalizePresetsContent(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/^# version: \d+\n/, '')
    .trimEnd()
}

/** Stable identity hash of catalog content (normalized — see
 *  normalizePresetsContent). Used by CloneInitService's seed migration. */
export function hashPresetsContent(content: string): string {
  return createHash('sha256').update(normalizePresetsContent(content), 'utf-8').digest('hex')
}
