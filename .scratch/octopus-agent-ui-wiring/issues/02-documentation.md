# 02 — Documentation: node-schema.md + requires-and-effort.md

## What to build
Update two reference documents in the octo-workflow-dev skill:

1. **node-schema.md** (`.claude/skills/octo-workflow-dev/references/node-schema.md`):
   - Add `octopus_agent` to the `type` enum list in Common Fields (line 12)
   - Add new section `## 11. octopus_agent — Delegate Agent` with:
     - All octopus-specific fields: `agent`, `version`, `min_stage`, `task` (brief/context/constraints/expected_output/sop/budget), `harness` (heartbeat_interval/heartbeat_timeout/auto_abort_on_budget)
     - Note that common fields `model`, `engine`, `effort` are inherited and supported
     - Note that `skills` is NOT supported (clone uses its own skills)
     - YAML example showing a complete octopus_agent node
   - Update RequiresDef section (lines 407-414) to add `commands`, `rules`, `clones` fields

2. **requires-and-effort.md** (`.claude/skills/octo-workflow-dev/references/requires-and-effort.md`):
   - Add `commands`, `rules`, `clones` to the requires field table
   - Add YAML examples for each new type
   - Document that `clones` are hard-fail (not auto-provisioned, must be pre-installed)

## Blocked by
None — can start immediately.

## Status
done

## Acceptance Criteria
- [ ] AC-12: octopus_agent 节点类型文档完整
- [ ] AC-13: commands/rules/clones 文档完整

## Verification Method
**Verification type**: Manual checklist

**Verification steps**:
1. Read node-schema.md: confirm `octopus_agent` appears in type enum
2. Read node-schema.md: confirm `## 11. octopus_agent` section exists with all fields from Zod schema
3. Read node-schema.md: confirm RequiresDef includes all 5 fields (skills, agent_files, commands, rules, clones)
4. Read requires-and-effort.md: confirm commands/rules/clones have format docs and examples
5. Read requires-and-effort.md: confirm clones hard-fail behavior is documented

**Pass criteria**: All checklist items confirmed
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
