# Ticket T2: Create Specialized Reference Documents (swarm + composition + conventions + testing)

## Status
DONE

## Scope
Create 5 reference documents in `.claude/skills/octo-workflow-dev/references/`:

1. **swarm-modes.md** — 5 swarm modes (from octo-swarm-dev)
   - Source: `octo-swarm-dev/SKILL.md` §1 (five modes), §2 (ExpertDef), §3 (Host), §4 (context)
   - Must cover: review, debate, dispatch, swarm (dynamic), moa
   - Include ExpertDef schema, Host configuration, auto-vars, context management
   - Include cross-constraints (expert_pool vs experts, moa requires aggregator, etc.)

2. **composition-rules.md** — Node composition constraints
   - Source: existing SKILL.md §7 (execution flow), Constraints section
   - DAG topology, execution_mode (auto/serial), max_concurrent
   - depends_on completeness discipline (non-first nodes must have depends_on)
   - execute_when conditional execution

3. **special-conventions.md** — Special node conventions
   - Source: existing SKILL.md Constraints section, loop sub-node discipline
   - Loop sub-nodes must declare depends_on
   - condition.cases default must be last
   - agent goal/prompt mutual exclusion
   - Sub-agent discipline (agents delegation)
   - Notify subsystem (providers + channels + notify hook)
   - Hook system (events + types)
   - Auto Answers
   - depends_on completeness as hard check

4. **testing.md** — Test fixture generation + simulator
   - Source: `octo-workflow-test/SKILL.md` §1-§8
   - Auto-discovery convention (.test.yaml)
   - Workflow analysis (node inventory, side-effect identification, variable flow)
   - Mock data generation rules (per node type)
   - Fixture generation (.test.yaml structure)
   - Simulator execution + iteration protocol
   - Constraint solving for mock data

5. **testing-reference.md** — Mock patterns reference
   - Source: `octo-workflow-test/REFERENCE.md`
   - Variable flow examples (from xzf-dev.yaml)
   - Swarm template mock patterns
   - Golden fixture examples
   - Complex mock patterns (per-iteration arrays, approval comment chains, swarm auto-vars)

## Verification Method
- File existence: all 5 files exist
- swarm-modes.md covers all 5 modes
- testing.md covers fixture generation + simulator
- special-conventions.md includes depends_on completeness check
- composition-rules.md covers DAG discipline
