# Ticket T1: Create Core Reference Documents (node-schema + node-patterns + variables)

## Status
DONE

## Scope
Create 3 reference documents in `.claude/skills/octo-workflow-dev/references/`:

1. **node-schema.md** — Field reference for all 9 node types
   - Source: `packages/shared/src/types/workflow.ts` Zod schemas
   - Must cover: bash, python, agent, condition, approval, loop, swarm, **interaction**, **sub_workflow**
   - For each type: required fields, optional fields, types, constraints
   - interaction fields: interaction_display, interaction_max_rounds, interaction_exit_when, interaction_timeout, interaction_agent
   - sub_workflow fields: workflow, execution_mode, input_mapping, output_mapping, on_error

2. **node-patterns.md** — Usage patterns + YAML examples per node type
   - Source: existing SKILL.md §5 (node speed reference), REFERENCE.md patterns
   - Must cover all 9 types with working YAML examples
   - Include interaction + sub_workflow examples

3. **variables.md** — Variable system + expression syntax
   - Source: existing SKILL.md §6 (variables & expressions)
   - Reference syntax table ($vars, $node_id.output, $inputs, $last_output, $iteration, $ref:, $parent.*)
   - outputs mapping (5 expression types)
   - Cross-execution references ($ref:)

## Verification Method
- File existence: all 3 files exist
- Content coverage: node-schema.md mentions all 9 types
- interaction fields present in node-schema.md
- sub_workflow fields present in node-schema.md
- variables.md contains $parent.* and $ancestor[N].* syntax
