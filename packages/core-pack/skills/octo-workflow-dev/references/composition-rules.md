# Composition Rules Reference

Node composition constraints for Octopus workflows: execution modes, DAG topology, and depends_on discipline.

---

## Execution Modes

### `auto` (default) — DAG Parallelism

Engine builds DAG from `depends_on`. Nodes without dependencies at the same level execute in parallel.

```yaml
execution_mode: auto            # Default
max_concurrent: 3               # Same-level concurrency limit
```

```yaml
nodes:
  - id: analyze
  - id: review-code
    depends_on: [analyze]
  - id: review-security
    depends_on: [analyze]       # Parallel with review-code
  - id: summary
    depends_on: [review-code, review-security]
```

### `serial` — Forced Sequential

All nodes execute in array order, one at a time.

```yaml
execution_mode: serial
```

> Even in `serial` mode, loop sub-nodes still need `depends_on` for correct frontend visualization.

---

## DAG Topology Discipline

### The Rule: No Broken Chains

In `execution_mode: auto`, **every non-entry node must explicitly declare `depends_on`**. Omission = broken chain.

### Symptoms of Broken Chains

| Symptom | Cause |
|---------|-------|
| Nodes execute unexpectedly in parallel | No edge → engine treats as independent root node |
| Frontend visualization nodes overlap | dagre layout algorithm can't infer hierarchy |
| Downstream node receives empty variables | Upstream hasn't finished when scheduled |
| Execution order differs from expected | Array order ≠ execution order; only `depends_on` determines order |

### Example

```yaml
# ❌ Broken — setup and build have no dependency, will run in parallel
nodes:
  - id: setup
  - id: build          # Missing depends_on: [setup]
  - id: test
    depends_on: [build]

# ✅ Complete chain — every non-entry node has explicit upstream
nodes:
  - id: setup
  - id: build
    depends_on: [setup]
  - id: test
    depends_on: [build]
```

### Self-Check Method

From the last node, trace `depends_on` backwards. Every path must trace back to an entry node. Any intermediate break = broken chain point.

---

## execute_when — Conditional Node Execution

```yaml
- id: optional
  type: agent
  execute_when: '$inputs.enable_x == "true"'
  prompt: "..."
```

- Falsy → skipped (not counted as failure)
- Can combine with `condition` node: use `execute_when` to replace explicit condition gate

### Common pattern: Skip based on upstream result

```yaml
- id: e2e-runner
  type: agent
  # Sets $vars.e2e_status

- id: e2e-notify
  type: bash
  depends_on: [e2e-runner]
  execute_when: '$vars.e2e_status == "failed"'
  bash: "echo 'E2E failed, notifying...'"
```

---

## Node Composition Patterns

### Linear Chain
```
A → B → C → D
```
```yaml
- id: a
- id: b
  depends_on: [a]
- id: c
  depends_on: [b]
- id: d
  depends_on: [c]
```

### Fan-out / Fan-in (Diamond)
```
    A
   / \
  B   C
   \ /
    D
```
```yaml
- id: a
- id: b
  depends_on: [a]
- id: c
  depends_on: [a]
- id: d
  depends_on: [b, c]
```

### Mixed Sequential + Parallel
```
A → B → C (parallel with D) → E
A → D → E
```
```yaml
- id: a
- id: b
  depends_on: [a]
- id: c
  depends_on: [b]
- id: d
  depends_on: [a]
- id: e
  depends_on: [c, d]
```

---

## Nested Structures

### Loop Inside DAG

```yaml
nodes:
  - id: setup
  - id: verify-loop
    type: loop
    depends_on: [setup]
    max_iterations: 3
    break_when: '$vars.passed == "true"'
    nodes:
      - id: test
        type: agent
        prompt: "Test round $iteration"
      - id: check
        type: bash
        depends_on: [test]
        bash: "echo check"
  - id: deploy
    depends_on: [verify-loop]
    type: agent
    prompt: "Deploy..."
```

### Sub-workflow in DAG

```yaml
nodes:
  - id: build
    type: bash
    bash: "npm run build"
  - id: test-suite
    type: sub_workflow
    depends_on: [build]
    workflow: "workflows/test-suite.yaml"
    on_error: continue
  - id: deploy
    type: agent
    depends_on: [test-suite]
    prompt: "Deploy if tests passed"
```

### Dynamic Sub-Workflow Constraints

When using `dynamic_sub_workflow`:

1. **Agent-only DAGs** — Generated nodes must ALL be type `agent`. No `bash`, `python`, `sub_workflow`, or other types.
2. **No nesting** — Generated DAG cannot contain `sub_workflow` or `dynamic_sub_workflow` nodes.
3. **Acyclic** — The generated DAG must be acyclic (no circular dependencies).
4. **Skills injection** — Always declare relevant skills so the generation agent has domain knowledge.
5. **Prompt specificity** — Be explicit about the expected output format and constraints in the prompt.

```yaml
# ✅ Good: specific prompt with constraints
- id: plan-tasks
  type: dynamic_sub_workflow
  prompt: |
    Analyze the tickets in $vars.tickets.
    Create a DAG where each ticket is an agent node.
    Group related tickets with dependencies.
    Max 10 nodes. Output JSON only.
  skills: [octo-workflow-dev]

# ❌ Bad: vague prompt, no constraints
- id: plan-tasks
  type: dynamic_sub_workflow
  prompt: "plan stuff"
```

---

## Resource Discovery — Before Writing Workflows

Query installed agents/skills before hardcoding resource names:

```bash
# List installed agents
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

### Resource Groups

| Group | Description | Use For |
|-------|-------------|---------|
| `agency-agents-zh` | 215+ Chinese role cards | `agent_file` references |
| `superpowers-zh` | Chinese skill packs | Node `skills` loading |
| `mattpocock-skills` | Engineering skills (TDD/debug/architecture) | Node `skills` loading |
| `gstack` | YC engineering roles (CEO review/security/QA) | `agent_file` references |
| `built-in` | Octopus built-in resources | Direct reference |
