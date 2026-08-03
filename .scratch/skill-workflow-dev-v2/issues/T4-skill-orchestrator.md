# Ticket T4: Write New SKILL.md Flow Orchestrator

## Status
DONE

## Scope
Rewrite `.claude/skills/octo-workflow-dev/SKILL.md` as a concise flow orchestrator.

### Frontmatter
- name: octo-workflow-dev
- description: "When using this skill, AI agents create, edit, and debug Octopus YAML workflows — including 9 node types (agent/bash/python/condition/approval/loop/swarm/interaction/sub_workflow), sub-agent delegation, skills loading, Notify/Hook configuration, variable system, DAG orchestration, and auto-testing."

### Structure (≤300 lines)

**Header**: Brief description of what the skill does (1-2 lines)

**Step 1: Resource Discovery** (always execute)
- Query installed agents/skills from registry.json
- Present available resources by group
- Reference: (no external doc needed, inline bash command)

**Step 2: Complexity Assessment**
- Count expected nodes and identify types
- Decision: ≤3 simple nodes (bash/python/agent only) → Quick Path
- Decision: ≥4 nodes OR complex types (swarm/loop/sub_workflow/interaction/condition/approval) → Full Wizard
- Output: path choice

**Step 3: Node Design**
- Quick Path: Brief node selection → reference node-schema.md + node-patterns.md
- Full Wizard: Deep design with depends_on planning → reference node-schema.md + node-patterns.md + swarm-modes.md (if swarm)

**Step 4: DAG Composition** (Full Wizard only)
- Plan execution order with depends_on
- Reference: composition-rules.md + special-conventions.md
- Variable design → reference variables.md

**Step 5: Generate + Validate**
- Generate YAML
- Run: `node .claude/skills/octo-workflow-dev/scripts/validate-workflow.js ./workflow.yaml`
- Auto-fix errors based on validation output
- Re-validate until clean

**Step 6: Test Generation Prompt**
- Ask: "Would you like to generate tests for this workflow?"
- If yes → reference testing.md for fixture generation
- If no → done

### Quick Path (≤3 simple nodes)
- Steps 1 → 3 → 5 → 6
- Minimal node design, skip deep DAG planning

### Key Design Principles
- Agent-first philosophy (brief mention)
- Sub-agent delegation (brief mention)
- Notify subsystem (brief mention)
- All details in reference docs, SKILL.md only orchestrates

### Reference Pointers
Each step includes explicit `→ See references/xxx.md` pointers

## Verification Method
- SKILL.md exists and is ≤300 lines
- Description starts with "When using"
- All 6 steps present
- Quick path vs full wizard logic documented
- All 8 reference docs referenced
- Test generation prompt in Step 6
