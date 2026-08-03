# Specification: octo-workflow-dev Skill Refactoring v2

## Overview

Refactor the `octo-workflow-dev` skill from a monolithic reference document into a wizard-style AI-friendly flow orchestrator with 8 specialized reference documents, integrate content from `octo-swarm-dev` and `octo-workflow-test`, add interaction/sub_workflow node support, and create a comprehensive L1-L3 schema validation script.

## Context

- **Current State**: 
  - `octo-workflow-dev`: 697-line SKILL.md + 672-line REFERENCE.md + basic validation script
  - `octo-swarm-dev`: 627-line SKILL.md (to be deleted)
  - `octo-workflow-test`: 665-line SKILL.md + 568-line REFERENCE.md (to be deleted)
- **Target State**: 
  - Concise SKILL.md orchestrator with wizard flow (Steps 1-6)
  - 8 specialized reference documents in `references/` subdirectory
  - Enhanced validation script covering L1 (structure) + L2 (cross-constraints) + L3 (semantic)
  - Two execution paths: full wizard (≥4 nodes or complex types) and quick path (≤3 simple nodes)
  - Integration of swarm and testing content

## Requirements

### Functional Requirements

1. **SKILL.md Flow Orchestrator**
   - Step 1: Resource discovery (query installed agents/skills)
   - Step 2: Complexity assessment (≤3 simple nodes → quick path, else → full wizard)
   - Step 3: Node selection guidance (reference node-schema.md + node-patterns.md)
   - Step 4: DAG composition (reference composition-rules.md + special-conventions.md)
   - Step 5: Validation (run validate-workflow.js, auto-fix errors)
   - Step 6: Test generation prompt (reference testing.md)
   - Quick path: Steps 1 → 3 → 5 → 6 (skip Steps 2, 4 deep dive)

2. **Reference Documents** (8 files in `references/`)
   - `node-schema.md`: 9 node types field reference (from workflow.ts Zod schemas)
   - `node-patterns.md`: Typical usage + YAML examples per node
   - `swarm-modes.md`: 5 swarm modes (from octo-swarm-dev SKILL.md)
   - `composition-rules.md`: Node composition constraints (depends_on, execution_mode)
   - `special-conventions.md`: Special node conventions + depends_on completeness check
   - `variables.md`: Variable system + expression syntax
   - `testing.md`: Test fixture generation + simulator usage
   - `testing-reference.md`: Mock patterns reference (from octo-workflow-test REFERENCE.md)

3. **Validation Script** (`scripts/validate-workflow.js`)
   - L1 (Structure): YAML parseable, required fields present, types correct
   - L2 (Cross-constraints): Swarm expert_pool+experts mutual exclusion, moa requires aggregator, depends_on references exist
   - L3 (Semantic): Variable references valid, condition expressions parseable, interaction_exit_when syntax
   - **Hard check**: depends_on completeness (non-first nodes without depends_on → warning)
   - Output formats: text (default) and JSON (--json flag)
   - Exit codes: 0 = pass, 1 = errors found, 2 = warnings only

4. **Node Type Coverage** (9 types)
   - bash, python, agent, condition, approval, loop, swarm
   - **interaction**: interaction_agent, interaction_exit_when, interaction_display, interaction_max_rounds, interaction_timeout
   - **sub_workflow**: workflow, execution_mode, input_mapping, output_mapping, on_error

5. **Integration**
   - Merge octo-swarm-dev content into octo-workflow-dev (swarm-modes.md + node-schema.md swarm section)
   - Merge octo-workflow-test content into octo-workflow-dev (testing.md + testing-reference.md)
   - Delete octo-swarm-dev directory
   - Delete octo-workflow-test directory
   - Update skill description to "When using" English format

6. **Core-pack Sync**
   - Copy new octo-workflow-dev structure to packages/core-pack/skills/octo-workflow-dev/
   - Ensure validate-workflow.js is executable and standalone

### Non-Functional Requirements

- **Do NOT modify**: Zod schemas in packages/shared, engine executors, web-app UI
- **Standalone validation**: validate-workflow.js must work without @octopus/shared dependency (inline schemas)
- **AI-friendly**: SKILL.md should be concise (≤300 lines), reference docs single-responsibility
- **Backward compatible**: Existing workflows continue to validate correctly

## Deliverables

### File Structure

```
.claude/skills/octo-workflow-dev/
├── SKILL.md                          ← Flow orchestrator (wizard + quick path)
├── references/
│   ├── node-schema.md                ← 9 node types field reference
│   ├── node-patterns.md              ← Usage examples per node
│   ├── swarm-modes.md                ← 5 swarm modes
│   ├── composition-rules.md          ← Node composition constraints
│   ├── special-conventions.md        ← Special conventions + depends_on check
│   ├── variables.md                  ← Variable system
│   ├── testing.md                    ← Test fixture generation
│   └── testing-reference.md          ← Mock patterns reference
└── scripts/
    └── validate-workflow.js          ← L1+L2+L3 validation (standalone)

packages/core-pack/skills/octo-workflow-dev/
├── SKILL.md                          ← Copy
├── references/                       ← Copy
└── scripts/                          ← Copy

.claude/skills/octo-swarm-dev/        ← DELETED
.claude/skills/octo-workflow-test/    ← DELETED
packages/core-pack/skills/octo-swarm-dev/    ← DELETED
packages/core-pack/skills/octo-workflow-test/ ← DELETED
```

### Acceptance Criteria

1. ✅ SKILL.md guides agent through Steps 1-6 for complex workflows (≥4 nodes or swarm/loop/sub_workflow)
2. ✅ Quick path activated for ≤3 simple nodes (bash/python/agent only)
3. ✅ Both paths prompt "generate tests?" after validation
4. ✅ 8 reference documents exist with single-responsibility content
5. ✅ validate-workflow.js passes L1+L2+L3 checks on valid workflows
6. ✅ validate-workflow.js catches L1 errors (missing required fields)
7. ✅ validate-workflow.js catches L2 errors (swarm expert_pool+experts conflict)
8. ✅ validate-workflow.js catches L3 errors (depends_on references non-existent node)
9. ✅ depends_on completeness check emits warning for non-first nodes without depends_on
10. ✅ interaction node fields documented in node-schema.md
11. ✅ sub_workflow node fields documented in node-schema.md
12. ✅ swarm-modes.md covers all 5 modes with examples
13. ✅ testing.md covers fixture generation + simulator usage
14. ✅ octo-swarm-dev directory deleted
15. ✅ octo-workflow-test directory deleted
16. ✅ core-pack/skills/octo-workflow-dev synced
17. ✅ Skill description uses "When using" English format

## Implementation Plan

### Phase 1: Foundation
1. Create `references/` directory structure
2. Extract content from existing SKILL.md/REFERENCE.md into reference docs
3. Integrate octo-swarm-dev content into swarm-modes.md
4. Integrate octo-workflow-test content into testing.md + testing-reference.md

### Phase 2: New Content
5. Add interaction node documentation to node-schema.md
6. Add sub_workflow node documentation to node-schema.md
7. Create composition-rules.md (depends_on, execution_mode, DAG discipline)
8. Create special-conventions.md (loop sub-nodes, depends_on completeness)

### Phase 3: Validation Script
9. Rewrite validate-workflow.js with L1+L2+L3 checks
10. Add depends_on completeness warning
11. Add swarm cross-constraint checks (expert_pool vs experts, moa aggregator)
12. Add interaction/sub_workflow validation
13. Test with valid/invalid YAML samples

### Phase 4: Orchestrator
14. Write new SKILL.md as flow orchestrator (Steps 1-6)
15. Add complexity assessment logic (quick path vs full wizard)
16. Reference all 8 reference docs with clear pointers
17. Update skill description to "When using" format

### Phase 5: Cleanup & Sync
18. Delete octo-swarm-dev directories (.claude/skills + core-pack)
19. Delete octo-workflow-test directories (.claude/skills + core-pack)
20. Sync octo-workflow-dev to core-pack
21. Verify all files exist and references resolve

## Verification Strategy

### Automated Checks
- File existence: all 8 reference docs + SKILL.md + validate-workflow.js
- Reference resolution: all `references/*.md` links in SKILL.md are valid
- Directory deletion: octo-swarm-dev and octo-workflow-test removed
- Core-pack sync: file count matches between .claude/skills and core-pack

### Manual Testing
- Run validate-workflow.js on sample workflows (valid + invalid)
- Verify depends_on warning triggers for incomplete DAG
- Verify swarm L2 checks catch expert_pool+experts conflict
- Verify interaction/sub_workflow fields validate correctly

### Integration Testing
- Use skill to generate a workflow with interaction node → validate passes
- Use skill to generate a workflow with sub_workflow node → validate passes
- Use skill to generate a swarm workflow → validate passes
- Quick path activates for ≤3 simple nodes → skips deep dive steps

## Risks & Mitigations

1. **Risk**: SKILL.md too long → AI skips steps
   - **Mitigation**: Keep SKILL.md ≤300 lines, move all details to references/

2. **Risk**: Validation script misses edge cases
   - **Mitigation**: Test with 10+ sample workflows covering all node types

3. **Risk**: Content duplication between reference docs
   - **Mitigation**: Single-responsibility per file, cross-reference instead of duplicate

4. **Risk**: Core-pack sync incomplete
   - **Mitigation**: Use diff to verify identical structure after sync

5. **Risk**: Quick path threshold (≤3 nodes) too aggressive
   - **Mitigation**: Document threshold clearly, allow manual override
