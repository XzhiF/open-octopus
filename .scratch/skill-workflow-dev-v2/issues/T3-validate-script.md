# Ticket T3: Write L1+L2+L3 Validation Script

## Status
DONE

## Scope
Rewrite `.claude/skills/octo-workflow-dev/scripts/validate-workflow.js` to cover 3 validation levels:

### L1 — Structure Validation
- YAML parseable
- apiVersion format (octopus/v{N})
- kind === "Workflow"
- name present (string)
- inputs values must be objects (not bare strings)
- nodes is non-empty array
- Node id uniqueness (recursive into loop sub-nodes)
- Per-type required fields:
  - bash: requires `bash` field
  - python: requires `python` field
  - agent: requires at least one of `agent`, `prompt`, `goal`, `agents`
  - condition: requires `cases` (non-empty)
  - loop: requires `max_iterations`
  - swarm: requires `topic` + `mode`
  - interaction: requires `interaction_agent` or `interaction_exit_when`
  - sub_workflow: requires `workflow`
  - approval: no special required fields

### L2 — Cross-Constraint Validation
- Swarm: `expert_pool` and `experts` are mutually exclusive
- Swarm: `mode: moa` requires `aggregator`
- Swarm: `mode: moa` requires `experts` ≥ 2
- Swarm: `mode: debate` requires `experts` ≥ 2
- Swarm: `mode: moa` rounds must be 0-5
- Swarm: `dynamic: true` requires `max_experts`
- Swarm: expert `depends_on` references must exist among expert roles
- Agent: `goal` and `prompt` are mutually exclusive
- Condition: `when: default` must be last case

### L3 — Semantic Validation
- `depends_on` references must point to existing node ids (recursive)
- Variable reference syntax: `$vars.*`, `$inputs.*`, `$node_id.output*`, `$last_output`, `$iteration`
- `$parent.*` and `$ancestor[N].*` only valid inside sub_workflow context
- `interaction_exit_when` expression syntax
- `execute_when` expression syntax
- `loop.while` / `loop.break_when` expression syntax

### Hard Checks (Warnings)
- **depends_on completeness**: Non-first top-level nodes without `depends_on` → emit WARNING (not error)
- Loop sub-nodes without `depends_on` → emit WARNING

### Output
- Text mode (default): ✓/✗ per file, error/warning details, summary
- JSON mode (--json flag): structured output with errors[] and warnings[]
- Exit codes: 0 = all pass, 1 = errors, 2 = warnings only (no errors)

### Technical Requirements
- Standalone JS (no @octopus/shared dependency required)
- Use js-yaml from node_modules (with resolution fallback like existing script)
- Handle batch validation (multiple files)

## Verification Method
- Script exists and is executable
- Valid YAML with all 9 node types → exit 0
- Missing required field (L1) → exit 1, error message
- Swarm expert_pool + experts conflict (L2) → exit 1, error message
- depends_on references non-existent node (L3) → exit 1, error message
- Non-first node without depends_on → exit 0 with warning
- --json flag produces valid JSON output
