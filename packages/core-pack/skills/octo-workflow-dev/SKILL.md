---
name: octo-workflow-dev
description: "When using this skill, AI agents create, edit, and debug Octopus YAML workflows — including 9 node types (agent/bash/python/condition/approval/loop/swarm/interaction/sub_workflow), sub-agent delegation, skills loading, Notify/Hook configuration, variable system, DAG orchestration, and auto-testing."
category: coding-assistant
tags: [octopus, workflow, YAML, agent, subagent, notify, hooks, swarm, interaction, sub_workflow, testing, simulator]
---

# Octopus Workflow Development Assistant

Wizard-style orchestrator for creating, editing, and debugging Octopus YAML workflows. Supports 9 node types, 4 orchestration modes, and automated validation + testing.

> **Schema authority**: `~/.octopus/workflow-schema.json` (source: `packages/core-pack/workflows/workflow-schema.json`)
> When unsure about any field, consult the schema first — don't write from memory.

---

## Step 1: Resource Discovery (Always Execute)

Before writing any workflow, query installed agents/skills to reuse existing resources:

```bash
# List installed agents (name + group + installPath)
node -e "
const d=JSON.parse(require('fs').readFileSync(
  require('os').homedir()+'/.octopus/resources/registry.json','utf8'));
d.resources.filter(r=>r.installed&&r.type==='agent')
  .forEach(r=>console.log(r.group+'/'+r.name+' → '+r.installPath+'/'+r.name+'.md'))
"

# List installed skills
node -e "
const d=JSON.parse(require('fs').readFileSync(
  require('os').homedir()+'/.octopus/resources/registry.json','utf8'));
d.resources.filter(r=>r.installed&&r.type==='skill')
  .forEach(r=>console.log(r.group+'/'+r.name+' → '+r.installPath+'/SKILL.md'))
"
```

| Group | Description | Use For |
|-------|-------------|---------|
| `agency-agents-zh` | 215+ Chinese role cards | `agent_file` references |
| `superpowers-zh` | Chinese skill packs | Node `skills` loading |
| `mattpocock-skills` | Engineering skills (TDD/debug) | Node `skills` loading |
| `gstack` | YC engineering roles | `agent_file` references |
| `built-in` | Octopus built-in resources | Direct reference |

> **agent_file** = role card (system prompt + persona). **skills** = capability injection. Both can combine.

---

## Step 2: Complexity Assessment

Estimate the workflow requirements:

| Criteria | Path |
|----------|------|
| ≤ 3 nodes, types only `bash`/`python`/`agent` | **Quick Path** → skip to Step 3 (light) → Step 5 → Step 6 |
| ≥ 4 nodes, OR includes `swarm`/`loop`/`sub_workflow`/`interaction`/`condition`/`approval` | **Full Wizard** → continue through all steps |

---

## Step 3: Node Design

### Quick Path (≤ 3 simple nodes)

1. Select node types from the 9 available
2. Write minimal YAML with required fields
3. Go to **Step 5**

→ See `references/node-schema.md` for field definitions
→ See `references/node-patterns.md` for usage examples

### Full Wizard (≥ 4 nodes or complex types)

1. **Select node types** for each step in the workflow
2. **For each node**, determine:
   - Required fields per type → `references/node-schema.md`
   - Working patterns → `references/node-patterns.md`
   - If swarm: mode selection → `references/swarm-modes.md`
3. **Agent-first philosophy**:
   - Prefer `agent` nodes for orchestration/decision/routing
   - Use `bash`/`python` only for deterministic tasks
   - When prompt > 80 lines or multiple files → add `agents` sub-agents
4. **Sub-agent delegation**: parent prompt orchestrates, sub-agents execute heavy work
5. **Skills loading**: use `skills` field, don't repeat skill content in prompt

---

## Step 4: DAG Composition (Full Wizard Only)

### Plan Execution Order

1. **Map dependencies**: which nodes must complete before others
2. **Set `depends_on`** for every non-entry node
3. **Choose execution mode**:
   - `auto` (default): DAG-based, parallel where possible
   - `serial`: forced sequential

→ See `references/composition-rules.md` for DAG patterns and execution modes

### Variable Design

1. Identify data flow between nodes
2. Plan `outputs` mappings for each node
3. Design `execute_when` conditions for optional nodes

→ See `references/variables.md` for reference syntax and expression operators

### Hard Constraints

→ See `references/special-conventions.md` for:
- **depends_on completeness**: every non-first node needs `depends_on`
- **Loop sub-nodes**: must declare `depends_on`
- **goal/prompt**: mutually exclusive
- **condition default**: must be last case
- **Notify subsystem**: providers + channels + notify hook (no hardcoded hermes)
- **Failure signaling**: `__status: "failed"`, not `exit 1`
- **Hook system**: 14 event types, 3 hook types (notify/bash/agent)

---

## Step 5: Generate + Validate

### Generate the Workflow YAML

```yaml
# yaml-language-server: $schema=~/.octopus/workflow-schema.json
apiVersion: octopus/v1
kind: Workflow
name: "my-workflow"
# ... nodes, variables, hooks, etc.
```

### Run Validation

```bash
node .claude/skills/octo-workflow-dev/scripts/validate-workflow.js ./my-workflow.yaml
```

**Validation levels:**
- **L1 (Structure)**: YAML parseable, required fields, types correct
- **L2 (Cross-constraints)**: Swarm constraints, goal/prompt exclusion, condition order
- **L3 (Semantic)**: depends_on references, expression syntax
- **Hard checks**: depends_on completeness warnings

### Auto-Fix Loop

1. If errors found → fix based on error messages
2. Re-run validation
3. Repeat until clean (0 errors)
4. Address warnings (especially depends_on completeness)

### Batch Validation

```bash
node .claude/skills/octo-workflow-dev/scripts/validate-workflow.js ./workflows/*.yaml --json
```

---

## Step 6: Test Generation

After validation passes:

**"Would you like to generate tests for this workflow?"**

### If Yes →

→ See `references/testing.md` for:
1. Workflow analysis (node inventory, side-effect identification, variable flow)
2. Mock data generation rules (per node type)
3. Fixture file structure (`.test.yaml`)
4. Simulator execution + iteration protocol (max 3 rounds)

→ See `references/testing-reference.md` for:
- Golden fixture examples
- Complex mock patterns (per-iteration arrays, swarm auto-vars, approval comment chains)
- Real-world variable flow examples

### If No →

Workflow is complete. Run with:
```bash
octopus workflow run ./my-workflow.yaml --org {org}
```

---

## Quick Reference

### 9 Node Types
| Type | Purpose | Required Fields |
|------|---------|----------------|
| `bash` | Shell scripts | `bash` |
| `python` | Python scripts | `python` |
| `agent` | AI agent | `prompt` or `goal` or `agents` |
| `condition` | Conditional routing | `cases` (with `default` last) |
| `approval` | Human gate | `options` |
| `loop` | Iterative execution | `max_iterations`, `nodes` |
| `swarm` | Multi-expert | `topic`, `mode` |
| `interaction` | Human-in-loop | `interaction_agent` or `interaction_exit_when` |
| `sub_workflow` | Nested workflow | `workflow` |

### Key Constraints
- `apiVersion: octopus/v1` + `kind: Workflow` required
- Node `id` must be unique (recursive)
- Non-first nodes need `depends_on`
- Loop sub-nodes need `depends_on`
- `goal` and `prompt` mutually exclusive
- Notify via providers+channels+hook, not bash
- `__status: "failed"` not `exit 1`
- String literals in outputs: `'"value"'`

### Reference Documents
| Document | Content |
|----------|---------|
| `references/node-schema.md` | All 9 node types field reference |
| `references/node-patterns.md` | Usage patterns + YAML examples |
| `references/swarm-modes.md` | 5 swarm modes + ExpertDef + Host |
| `references/composition-rules.md` | DAG topology + execution modes |
| `references/special-conventions.md` | Hard constraints + conventions |
| `references/variables.md` | Variable system + expressions |
| `references/testing.md` | Test fixture generation + simulator |
| `references/testing-reference.md` | Mock patterns reference |
