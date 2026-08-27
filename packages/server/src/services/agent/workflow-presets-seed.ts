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
// task-author agent (HOW-handoff via its SKILL.md). Users may edit the seeded
// file in the clone dir — CloneInitService only writes it when missing
// (skip-if-exists, same as persona.md).
//
// NOTE: inside the template literal the `${...}` placeholders MUST be escaped
// as \${...} — an unescaped `${goal}` is a JavaScript interpolation expression.

/** Default preset catalog — maps skill groups to recommended workflows + input
 *  skeletons. `skills_group: []` = general fallback (matches any task). Inputs
 *  may contain \${goal} / \${ac} placeholders, resolved at materialization. */
export const DEFAULT_WORKFLOW_PRESETS_YAML = `# Default workflow presets — maps skill groups to recommended workflows + input templates.
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
`